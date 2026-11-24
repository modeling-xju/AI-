# -*- coding: utf-8 -*-
"""代码属性图（CPG）导出。

演示版不依赖 Joern 运行时：用自研解析器把每个方法切成语句块，
在此基础上生成 AST/CALL/CFG/CDG/DDG 五类边，导出为 JSON 供知识库
与后续模块使用。接口保持「一次导出、按项目落盘」的形状，
若本机装了 Joern CLI，可在 `build()` 前用 `joern_available()` 判断
并改走 `_build_with_joern()`（当前返回 None 表示未启用）。
"""
import json
import os
import re

from .. import db
from . import javaparse

ID_RE = re.compile(r"[A-Za-z_$][\w$]*")
KEYWORDS = {
    "if", "for", "while", "switch", "catch", "return", "new", "throw", "else", "do",
    "try", "case", "assert", "class", "interface", "enum", "package", "import", "int",
    "long", "double", "float", "boolean", "char", "byte", "short", "void", "String",
    "static", "final", "public", "private", "protected", "this", "super", "null", "true",
    "false", "instanceof", "break", "continue", "synchronized", "extends", "implements",
}
CONTROL_RE = re.compile(r"^(if|for|while|switch|catch|try|else|do|synchronized)\b")
ASSIGN_RE = re.compile(r"^([A-Za-z_$][\w$]*)\s*(?:[-+*/%]?=|\+\+|--)")


def joern_available():
    """本机是否可调用 joern-parse（用于切换到真实 CPG 后端）。"""
    return bool(os.environ.get("JOERN_PARSE"))


def _statements(body):
    """把方法体切成语句序列：返回 [{'kind','code','children'}]。

    kind ∈ stmt / if / for / while / switch / try / catch / else / block
    """
    nodes, buffer, index = [], [], 0
    text = body

    def flush(kind="stmt"):
        code = "".join(buffer).strip()
        buffer.clear()
        if code:
            nodes.append({"kind": kind, "code": re.sub(r"\s+", " ", code)[:160],
                          "children": []})

    while index < len(text):
        char = text[index]
        if char == ";":
            flush()
            index += 1
            continue
        if char == "{":
            header = re.sub(r"\s+", " ", "".join(buffer)).strip()
            buffer.clear()
            depth, cursor = 1, index + 1
            while cursor < len(text) and depth:
                if text[cursor] == "{":
                    depth += 1
                elif text[cursor] == "}":
                    depth -= 1
                cursor += 1
            inner = text[index + 1:cursor - 1]
            kind = "block"
            match = CONTROL_RE.match(header)
            if match:
                kind = "else" if header.startswith("else") else match.group(1)
            node = {"kind": kind, "code": header[:160],
                    "children": _statements(inner)}
            nodes.append(node)
            index = cursor
            continue
        if char == "}":
            index += 1
            continue
        buffer.append(char)
        index += 1
    flush()
    return nodes


def _walk(nodes, parent=None):
    """按顺序展开（控制节点带 parent），供 CFG/CDG 建边。"""
    for node in nodes:
        yield node, parent
        yield from _walk(node["children"], node)


def _identifiers(code):
    return {token for token in ID_RE.findall(code) if token not in KEYWORDS}


def _method_graph(method_id, class_name, method, file_path):
    nodes, edges = [], []
    nodes.append({"id": "M%d" % method_id, "label": "METHOD",
                  "name": "%s.%s" % (class_name, method["name"]),
                  "file": file_path, "line": method["line"]})
    body = method.get("body") or ""
    tree = _statements(body) if "{".count(body) >= 0 else []
    flat = []

    def assign(node, prefix):
        node["id"] = "%s%d" % (prefix, len(nodes))
        nodes.append({"id": node["id"], "label": "CONTROL" if node["kind"] in
                      {"if", "for", "while", "switch", "try", "catch", "else"} else "STMT",
                      "name": node["code"][:80], "file": file_path,
                      "line": method["line"]})
        edges.append({"type": "AST", "src": "M%d" % method_id, "dst": node["id"]})
        flat.append(node)
        for child in node["children"]:
            assign(child, prefix)

    for statement in tree:
        assign(statement, "S")

    # CFG：按展开顺序串联，控制节点额外连到其子节点；CDG：子节点依赖控制节点
    for position, node in enumerate(flat):
        next_node = flat[position + 1] if position + 1 < len(flat) else None
        if next_node:
            edges.append({"type": "CFG", "src": node["id"], "dst": next_node["id"]})
        for child in node["children"]:
            edges.append({"type": "CFG", "src": node["id"], "dst": child["id"]})
            edges.append({"type": "CDG", "src": node["id"], "dst": child["id"]})

    # DDG：同一方法内「定义 → 使用」
    last_def = {}
    for node in flat:
        code = node["code"]
        match = ASSIGN_RE.match(code)
        for name in _identifiers(code):
            if name in last_def and last_def[name] != node["id"]:
                edges.append({"type": "DDG", "src": last_def[name], "dst": node["id"],
                              "name": name})
        if match:
            last_def[match.group(1)] = node["id"]

    for call in method.get("calls") or []:
        target = call.get("qualifier") or ""
        edges.append({"type": "CALL", "src": "M%d" % method_id,
                      "dst": "%s.%s" % (target, call.get("name")),
                      "line": call.get("line")})
    return nodes, edges


def _reference_edges(parsed, known):
    """类级引用：继承/实现、字段类型、参数与返回类型。"""
    edges = []
    for cls in parsed["classes"]:
        name = cls["name"]
        if name not in known:
            continue
        for target in cls.get("extends") or []:
            if target in known:
                edges.append({"type": "REF", "src": name, "dst": target, "kind": "extends"})
        for target in cls.get("implements") or []:
            if target in known:
                edges.append({"type": "REF", "src": name, "dst": target, "kind": "implements"})
        for field in cls.get("fields") or []:
            base = _base_type(field.get("type"))
            if base in known and base != name:
                edges.append({"type": "REF", "src": name, "dst": base, "kind": "field"})
        for method in cls.get("methods") or []:
            base = _base_type(method.get("return_type"))
            if base in known and base != name:
                edges.append({"type": "REF", "src": name, "dst": base, "kind": "return"})
            for param in (method.get("params") or "").split(","):
                base = _base_type(param.split()[-1] if param.strip() else "")
                if base in known and base != name:
                    edges.append({"type": "REF", "src": name, "dst": base, "kind": "param"})
    return edges


def _base_type(text):
    if not text:
        return ""
    cleaned = re.sub(r"<[^>]*>", "", text).replace("[]", "").strip()
    return cleaned.split(".")[-1].strip()


def build(pid):
    """导出项目的 CPG（JSON），返回节点/边统计。"""
    files = db.query("SELECT id, path, content FROM files WHERE project_id=? AND category='源码'",
                     (pid,))
    nodes, edges = [], []
    known = {row["name"] for row in db.query(
        "SELECT name FROM classes WHERE project_id=?", (pid,))}
    methods = {row["id"]: row for row in db.query(
        "SELECT m.id, m.name, m.line, m.loc, m.signature, c.name AS class_name "
        "FROM methods m JOIN classes c ON c.id=m.class_id WHERE m.project_id=?", (pid,))}

    for row in files:
        parsed = javaparse.parse_source(row["content"] or "")
        edges.extend(_reference_edges(parsed, known))
        for cls in parsed["classes"]:
            for method in cls["methods"]:
                match = [mid for mid, item in methods.items()
                         if item["class_name"] == cls["name"] and item["name"] == method["name"]
                         and item["line"] == method["line"]]
                if not match:
                    continue
                method_nodes, method_edges = _method_graph(
                    match[0], cls["name"], method, row["path"])
                nodes.extend(method_nodes)
                edges.extend(method_edges)

    payload = {"project_id": pid, "nodes": nodes, "edges": edges}
    target_dir = os.path.join(db.BASE_DIR, "data", "cpg")
    os.makedirs(target_dir, exist_ok=True)
    path = os.path.join(target_dir, "project-%d.json" % pid)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    return {"path": path, "nodes": len(nodes), "edges": len(edges),
            "by_type": _count(edges)}


def _count(edges):
    counts = {}
    for edge in edges:
        counts[edge["type"]] = counts.get(edge["type"], 0) + 1
    return counts
