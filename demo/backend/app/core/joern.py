# -*- coding: utf-8 -*-
"""Joern 集成：调用 joern-parse 生成 CPG，再用 CPGQL 服务把实体与边抽出来。

本机没有 Java 时整套流程不可用，`available()` 会返回 False，流水线退回自研解析器。
"""
import json
import os
import re
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

TOOLS = Path(r"D:\Users\Desktop\v3.0\tools")
JOERN_HOME = Path(os.environ.get("JOERN_HOME", str(TOOLS / "joern" / "joern-cli")))
JAVA_HOME = Path(os.environ.get("JAVA_HOME", str(TOOLS / "jdk17" / "jdk-17.0.2")))
TMP_DIR = Path(os.environ.get("JOERN_TMP", str(TOOLS / "tmp")))

ANSI = re.compile(r"\x1b\[[0-9;]*m")
VAL = re.compile(r"val\s+\w+:\s*[\w\[\], .]+\s*=\s*", re.S)
SEP = "|"


def available():
    return ((JOERN_HOME / "joern-parse.bat").exists()
            and (JOERN_HOME / "joern.bat").exists()
            and (JAVA_HOME / "bin" / "java.exe").exists())


def version_text():
    if not available():
        return "未安装"
    return "%s / JDK %s" % (JOERN_HOME.name, JAVA_HOME.name)


def _env():
    env = dict(os.environ)
    env["JAVA_HOME"] = str(JAVA_HOME)
    env["PATH"] = str(JAVA_HOME / "bin") + os.pathsep + env.get("PATH", "")
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    env["TMP"] = str(TMP_DIR)
    env["TEMP"] = str(TMP_DIR)
    env["JAVA_OPTS"] = "-Xmx4g -Djava.io.tmpdir=%s" % TMP_DIR
    return env


def parse(root, bin_path, timeout=3600):
    """joern-parse：源码目录 -> cpg.bin。"""
    bin_path = Path(bin_path)
    bin_path.parent.mkdir(parents=True, exist_ok=True)
    if bin_path.exists():
        bin_path.unlink()
    cmd = ["cmd", "/c", str(JOERN_HOME / "joern-parse.bat"), str(root), "-o", str(bin_path)]
    done = subprocess.run(cmd, env=_env(), capture_output=True, timeout=timeout)
    if not bin_path.exists():
        tail = (done.stderr or done.stdout or b"").decode("utf-8", "replace")[-400:]
        raise RuntimeError("joern-parse 失败：%s" % tail.strip())
    return bin_path


def _free_port(start=8090, limit=30):
    for port in range(start, start + limit):
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise RuntimeError("找不到空闲端口")


def serve(bin_path, port, timeout=180):
    """启动 CPGQL 服务，等到能查询为止，返回 Popen。"""
    cmd = ["cmd", "/c", str(JOERN_HOME / "joern.bat"), "--server",
           "--server-port", str(port), str(bin_path)]
    proc = subprocess.Popen(cmd, env=_env(), stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, cwd=str(TOOLS))
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=2):
                time.sleep(1.0)
                return proc
        except OSError:
            if proc.poll() is not None:
                raise RuntimeError("joern 服务启动失败（退出码 %s）" % proc.returncode)
            time.sleep(1.0)
    stop(proc)
    raise RuntimeError("joern 服务启动超时")


def stop(proc):
    if proc is None or proc.poll() is not None:
        return
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                   capture_output=True, check=False)


def _post(port, query, timeout=120):
    body = json.dumps({"query": query}).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:%d/query" % port, data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _result(port, uuid, timeout=600):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            url = "http://127.0.0.1:%d/result/%s" % (port, uuid)
            with urllib.request.urlopen(url, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("stdout"):
                return ANSI.sub("", data["stdout"])
        except (urllib.error.HTTPError, urllib.error.URLError, socket.timeout):
            pass
        time.sleep(0.4)
    raise TimeoutError("CPGQL 结果超时")


def query(port, cpgql, timeout=600):
    uuid = _post(port, cpgql)["uuid"]
    return _result(port, uuid, timeout=timeout)


def query_str(port, traversal, var, exprs, timeout=600):
    inner = SEP.join("${%s}" % e for e in exprs)
    cpgql = '%s.map(%s => s"%s").mkString("\\n")' % (traversal, var, inner)
    out = query(port, cpgql, timeout=timeout)
    match = VAL.search(out)
    if not match:
        raise RuntimeError("CPGQL 无结果：%s" % cpgql[:120])
    body = out[match.end():].strip()
    if body.startswith('"""') and body.endswith('"""'):
        body = body[3:-3]
    elif body.startswith('"') and body.endswith('"'):
        body = body[1:-1]
    # Windows 路径里的 \u、\s 会破坏 Python 字面量解析，这里手工还原转义
    body = (body.replace("\\\\", "\\").replace("\\n", "\n")
                .replace("\\t", "\t").replace('\\"', '"'))
    return [line.split(SEP) for line in body.splitlines() if line.strip()]


def query_int(port, cpgql):
    out = query(port, cpgql)
    match = re.search(r"=\s*(\d+)", out)
    return int(match.group(1)) if match else 0


def analyze(root, workdir, port=None, keep_server=False):
    """完整跑一次：parse -> serve -> 抽取 -> 关服务。"""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    slug = Path(root).name or "project"
    bin_path = workdir / ("%s.bin" % slug)
    json_path = workdir / ("%s.joern.json" % slug)

    parse(root, bin_path)
    port = port or _free_port()
    proc = serve(bin_path, port)
    try:
        counts = {
            "all": query_int(port, "cpg.all.size"),
            "typeDecl": query_int(port, "cpg.typeDecl.size"),
            "method": query_int(port, "cpg.method.size"),
            "call": query_int(port, "cpg.call.size"),
            "file": query_int(port, "cpg.file.size"),
        }
        classes = query_str(port, "cpg.typeDecl", "t", [
            "t.name", "t.fullName", "t.filename",
            "t.lineNumber.getOrElse(0)", "t.isExternal"])
        methods = query_str(port, "cpg.method", "m", [
            "m.name", "m.fullName", "m.signature", "m.filename",
            "m.lineNumber.getOrElse(0)", "m.isExternal"])
        calls = query_str(port, "cpg.call", "c", [
            "c.method.fullName", "c.name", "c.methodFullName",
            "c.lineNumber.getOrElse(0)", "c.method.filename"], timeout=1800)
        edges = {
            "ast": query_int(port, "cpg.method.ast.size"),
            "cfg": query_int(port, "cpg.call.cfgNext.size"),
            "cdg": query_int(port, "cpg.call.cdgOut.size"),
            "ddg": query_int(port, "cpg.call.ddgIn.size"),
            "ref": (query_int(port, "cpg.member.size")
                    + query_int(port, "cpg.parameter.size")
                    + query_int(port, "cpg.method.methodReturn.size")
                    + query_int(port, "cpg.typeDecl.inheritsFromTypeFullName.size")),
        }
    finally:
        if not keep_server:
            stop(proc)

    data = {
        "bin": str(bin_path),
        "counts": counts,
        "edges": edges,
        "classes": [
            {"name": r[0], "fullName": r[1], "file": r[2],
             "line": int(r[3] or 0), "external": r[4] == "true"}
            for r in classes if len(r) >= 5
        ],
        "methods": [
            {"name": r[0], "fullName": r[1], "signature": r[2], "file": r[3],
             "line": int(r[4] or 0), "external": r[5] == "true"}
            for r in methods if len(r) >= 6
        ],
        "calls": [
            {"caller": r[0], "name": r[1], "callee": r[2],
             "line": int(r[3] or 0), "file": r[4]}
            for r in calls if len(r) >= 5
        ],
    }
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    data["json"] = str(json_path)
    return data
