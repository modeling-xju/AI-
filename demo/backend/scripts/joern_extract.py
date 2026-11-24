# -*- coding: utf-8 -*-
"""通过 Joern 的 CPGQL HTTP 服务抽取实体与边统计，写成 JSON。

服务需先启动：
    joern.bat --server --server-port 8082 <cpg.bin>
用法：
    python scripts/joern_extract.py --port 8082 --out data/cpg/springblade.json
"""
import argparse
import ast
import json
import re
import time
import urllib.error
import urllib.request

ANSI = re.compile(r"\x1b\[[0-9;]*m")
VAL = re.compile(r"val\s+\w+:\s*[\w\[\], .]+\s*=\s*", re.S)
SEP = "|"
NL = "\\n"


def _post(port, query, timeout=120):
    body = json.dumps({"query": query}).encode("utf-8")
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/query", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _result(port, uuid, timeout=300):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/result/{uuid}", timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError:
            time.sleep(0.5)
            continue
        if data.get("stdout"):
            return ANSI.sub("", data["stdout"])
        time.sleep(0.5)
    raise TimeoutError("结果超时：" + uuid)


def q(port, query, timeout=300):
    """返回查询的 stdout（去 ANSI）。"""
    uuid = _post(port, query)["uuid"]
    return _result(port, uuid, timeout=timeout)


def q_str(port, query, timeout=300):
    """把 String 结果取出来。

    服务返回的是 Scala 字符串字面量（三引号）。Windows 路径里的 `\\u`、`\\s`
    会让 ast.literal_eval 报 unicodeescape 错，所以这里手工去掉三引号再还原转义。
    """
    out = q(port, query, timeout=timeout)
    m = VAL.search(out)
    if not m:
        return ""
    body = out[m.end():].strip()
    if body.startswith('"""') and body.endswith('"""'):
        body = body[3:-3]
    elif body.startswith('"') and body.endswith('"'):
        body = body[1:-1]
    return (body.replace("\\\\", "\\")
                .replace("\\n", "\n")
                .replace("\\t", "\t")
                .replace('\\"', '"'))


def q_int(port, query):
    out = q(port, query)
    m = re.search(r"=\s*(\d+)", out)
    return int(m.group(1)) if m else 0


def rows(text):
    return [line.split(SEP) for line in text.splitlines() if line.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8082)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    port = args.port

    def fetch(traversal, var, exprs, timeout=600):
        """traversal.map(var => s"${a}|${b}").mkString("\n")"""
        inner = SEP.join(f"${{{e}}}" for e in exprs)
        query = f'{traversal}.map({var} => s"{inner}").mkString("{NL}")'
        return rows(q_str(port, query, timeout=timeout))

    print("查询规模...", flush=True)
    counts = {
        "all": q_int(port, "cpg.all.size"),
        "typeDecl": q_int(port, "cpg.typeDecl.size"),
        "method": q_int(port, "cpg.method.size"),
        "call": q_int(port, "cpg.call.size"),
        "file": q_int(port, "cpg.file.size"),
    }
    print("  ", counts, flush=True)

    print("抽取类...", flush=True)
    classes = fetch("cpg.typeDecl", "t", [
        "t.name", "t.fullName", "t.filename",
        "t.lineNumber.getOrElse(0)", "t.isExternal"])
    print(f"  {len(classes)} 行", flush=True)

    print("抽取方法...", flush=True)
    methods = fetch("cpg.method", "m", [
        "m.name", "m.fullName", "m.signature", "m.filename",
        "m.lineNumber.getOrElse(0)", "m.isExternal"])
    print(f"  {len(methods)} 行", flush=True)

    print("抽取调用...", flush=True)
    calls = fetch("cpg.call", "c", [
        "c.method.fullName", "c.name", "c.methodFullName",
        "c.lineNumber.getOrElse(0)", "c.method.filename"], timeout=1800)
    print(f"  {len(calls)} 行", flush=True)

    print("统计边...", flush=True)
    edges = {
        "ast": q_int(port, "cpg.method.ast.size"),
        "cfg": q_int(port, "cpg.call.cfgNext.size"),
        "cdg": q_int(port, "cpg.call.cdgOut.size"),
        "ddg": q_int(port, "cpg.call.ddgIn.size"),
        "ref": (q_int(port, "cpg.member.size")
                + q_int(port, "cpg.parameter.size")
                + q_int(port, "cpg.method.methodReturn.size")
                + q_int(port, "cpg.typeDecl.inheritsFromTypeFullName.size")),
    }
    print("  ", edges, flush=True)

    data = {
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
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    print(f"写入 {args.out}：类 {len(data['classes'])}、方法 {len(data['methods'])}、"
          f"调用 {len(data['calls'])}、边 {edges}", flush=True)


if __name__ == "__main__":
    main()
