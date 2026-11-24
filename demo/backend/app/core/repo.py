# -*- coding: utf-8 -*-
"""接入与预处理：Git 克隆/拉取、构建工具识别、文件分类与语言统计。

只做「把工程变成一份统一快照」这件事，不解析语法（那是 javaparse 的职责）。
"""
import os
import re
import shutil
import subprocess

SKIP_DIRS = {".git", ".idea", ".gradle", ".mvn", "target", "build", "out", "node_modules",
             "dist", "__pycache__", ".settings"}
SOURCE_EXT = {".java", ".kt", ".scala", ".groovy"}
CONFIG_EXT = {".xml", ".yml", ".yaml", ".properties", ".json", ".toml", ".ini", ".conf"}
DOC_EXT = {".md", ".txt", ".adoc", ".rst"}
RESOURCE_EXT = {".html", ".css", ".js", ".ts", ".vue", ".jsp", ".ftl", ".png", ".jpg",
                ".svg", ".gif", ".ico", ".sql", ".sh", ".bat"}
MODULE_RE = re.compile(r"<module>\s*([^<]+?)\s*</module>")


def git_available():
    return shutil.which("git") is not None


def clone(url, target, depth=1):
    """克隆仓库到 target；已存在则 fetch + reset。"""
    if not git_available():
        raise RuntimeError("当前环境没有 git，可改用「本地目录」或 zip 上传")
    if os.path.isdir(os.path.join(target, ".git")):
        _run(["git", "-C", target, "fetch", "--all", "--prune"])
        _run(["git", "-C", target, "reset", "--hard", "origin/HEAD"])
        return target, "pulled"
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    if os.path.isdir(target):
        shutil.rmtree(target, ignore_errors=True)
    args = ["git", "clone", url, target]
    if depth:
        args[2:2] = ["--depth", str(depth)]
    _run(args)
    return target, "cloned"


def _run(args):
    proc = subprocess.run(args, capture_output=True, text=True, timeout=300)
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout or "").strip().splitlines()
        raise RuntimeError(message[-1] if message else "git 执行失败")
    return proc.stdout


def classify(path):
    """按路径与后缀分成：源码 / 测试 / 配置 / 文档 / 资源 / 其他。"""
    lowered = path.replace("\\", "/").lower()
    ext = os.path.splitext(lowered)[1]
    if "/src/test/" in lowered or "/test/" in lowered or re.search(r"(test|tests)\.java$", lowered):
        return "测试"
    if ext in SOURCE_EXT:
        return "源码"
    if ext in CONFIG_EXT:
        return "配置"
    if ext in DOC_EXT:
        return "文档"
    if ext in RESOURCE_EXT:
        return "资源"
    return "其他"


def detect_build(root, files):
    """识别 Maven / Gradle 及其模块清单。"""
    has_pom = any(os.path.basename(f) == "pom.xml" for f in files)
    has_gradle = any(os.path.basename(f) in ("build.gradle", "build.gradle.kts") for f in files)
    if has_pom:
        tool = "maven"
    elif has_gradle:
        tool = "gradle"
    else:
        tool = "none"
    modules = []
    for name in files:
        if os.path.basename(name) == "pom.xml":
            try:
                text = open(name, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            modules.extend(MODULE_RE.findall(text))
    return tool, modules


def scan(root, max_files=600):
    """扫描工程，返回文件清单、分类统计、语言构成与构建方式。"""
    root = os.path.abspath(os.path.expanduser(root))
    if not os.path.isdir(root):
        raise ValueError("目录不存在：%s" % root)
    entries, skipped = [], 0
    for current, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            full = os.path.join(current, name)
            rel = os.path.relpath(full, root).replace("\\", "/")
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if size > 2 * 1024 * 1024:  # 跳过超大文件
                skipped += 1
                continue
            entries.append({"path": full, "rel": rel, "size": size,
                            "category": classify(rel)})
            if len(entries) >= max_files:
                break
        if len(entries) >= max_files:
            break

    tool, modules = detect_build(root, [e["path"] for e in entries])
    languages, categories = {}, {}
    java_files, test_files, other_files = [], [], []
    for entry in entries:
        ext = os.path.splitext(entry["rel"])[1].lower() or "(无后缀)"
        languages.setdefault(ext, {"files": 0, "loc": 0})
        languages[ext]["files"] += 1
        categories[entry["category"]] = categories.get(entry["category"], 0) + 1
        try:
            with open(entry["path"], "r", encoding="utf-8", errors="ignore") as handle:
                content = handle.read()
        except OSError:
            content = ""
        entry["loc"] = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
        languages[ext]["loc"] += entry["loc"]
        if ext == ".java" and entry["category"] == "测试":
            test_files.append(entry["rel"])  # 测试代码只登记，不进入逆向分析
            continue
        if ext == ".java" and entry["category"] == "源码":
            entry["content"] = content
            java_files.append(entry)
        else:
            other_files.append({key: entry[key] for key in ("rel", "category", "loc")})

    return {
        "root": root,
        "java_files": java_files,
        "test_files": test_files,
        "other_files": other_files[:200],
        "build_tool": tool,
        "modules": modules,
        "languages": dict(sorted(languages.items(), key=lambda item: -item[1]["loc"])[:8]),
        "categories": categories,
        "loc": sum(item["loc"] for item in entries),
        "skipped": skipped,
    }
