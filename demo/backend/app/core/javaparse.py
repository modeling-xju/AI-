# -*- coding: utf-8 -*-
"""极简 Java 解析器：只抽取本课题需要的事实。

产出结构（pipeline 直接消费）：
{
  "package": "com.shop.dao",
  "imports": ["java.util.List", ...],
  "classes": [
    {"name": "OrderDao", "kind": "class", "line": 12, "doc": "订单数据访问。",
     "fields": [{"name": "orders", "type": "List<Order>"}],
     "methods": [
        {"name": "insert", "return_type": "long", "params": "Order order",
         "signature": "long insert(Order order)", "modifiers": "public",
         "line": 40, "end_line": 48, "doc": "...", "loc": 9, "is_public": True,
         "calls": [{"name": "add", "qualifier": "orders", "line": 42}]}
     ]}
  ]
}

按行与花括号配对解析，不追求语法完备，覆盖常规 Spring 风格 Java 工程。
"""
import re

CLASS_RE = re.compile(r"(?:\b(?:public|protected|private)\s+)?(?:abstract\s+|final\s+|static\s+)*"
                      r"\b(class|interface|enum)\s+(\w+)")
PACKAGE_RE = re.compile(r"^[ \t]*package\s+([\w.]+)\s*;", re.M)
IMPORT_RE = re.compile(r"^[ \t]*import\s+(?:static\s+)?([\w.*]+)\s*;", re.M)
METHOD_RE = re.compile(
    r"^[ \t]*(?P<mods>(?:(?:public|protected|private|static|final|abstract|synchronized|"
    r"default|native)[ \t]+)*)"
    r"(?P<ret>[A-Za-z_$][\w<>\[\],.?]*(?:[ \t]+[A-Za-z_$][\w<>\[\],.?]*)*?)[ \t]+"
    r"(?P<name>\w+)[ \t]*\((?P<params>[^)]*)\)[ \t]*"
    r"(?:throws[ \t]+[\w,\s.]+)?\{", re.M)
NEW_RE = re.compile(r"\bnew\s+(\w+)\s*\(")
CALL_RE = re.compile(r"(?<![\w.])(\w+)\s*\.\s*(\w+)\s*\(")
FIELD_RE = re.compile(
    r"^[ \t]*(?:(?:private|public|protected|static|final|transient|volatile)\s+)*"
    r"([\w<>\[\],.]+)\s+(\w+)\s*(?:=[^;]*)?;", re.M)

SKIP_CALLS = {
    "if", "for", "while", "switch", "catch", "return", "new", "throw", "super", "this",
    "else", "do", "try", "synchronized", "case", "assert", "printStackTrace", "println",
    "printf", "format", "valueOf", "size", "isEmpty", "equals", "hashCode", "toString",
}
RESERVED = {"if", "for", "while", "switch", "catch", "return", "new", "throw", "else",
            "do", "try", "case", "assert", "class", "interface", "enum", "package",
            "import", "int", "long", "double", "float", "boolean", "char", "byte",
            "short", "void", "String", "static", "final"}


def strip_comments(src):
    """把注释替换为空格、保持行号，并收集 javadoc 区间。"""
    out, docs = [], []
    i, n, line = 0, len(src), 1
    while i < n:
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n - 2 if j < 0 else j
            block = src[i:j + 2]
            if block.startswith("/**"):
                docs.append((line, line + block.count("\n"), block))
            out.append(re.sub(r"[^\n]", " ", block))
            line += block.count("\n")
            i = j + 2
        else:
            if src[i] == "\n":
                line += 1
            out.append(src[i])
            i += 1
    return "".join(out), docs


def _doc_text(block):
    body = block.strip()
    body = body[3:] if body.startswith("/**") else body
    body = body[:-2] if body.endswith("*/") else body
    parts = []
    for raw in body.splitlines():
        text = raw.strip().lstrip("*").strip()
        if text and not text.startswith("@"):
            parts.append(text)
    return " ".join(parts)[:300]


def doc_before(docs, line_no, gap=4):
    """取紧邻 line_no 之前（中间不超过 gap 行）的 javadoc。"""
    best = None
    for start, end, block in docs:
        if line_no - end <= gap and end < line_no:
            best = (end, block)
        elif end >= line_no:
            break
    return _doc_text(best[1]) if best else ""


def _balanced(text, open_index):
    """从 open_index 的 '{' 配对，返回 (内部文本, 右花括号下标)。"""
    depth = 0
    for k in range(open_index, len(text)):
        if text[k] == "{":
            depth += 1
        elif text[k] == "}":
            depth -= 1
            if depth == 0:
                return text[open_index + 1:k], k
    return text[open_index + 1:], len(text)


def _calls_in(body, base_line):
    calls, seen = [], set()
    for match in CALL_RE.finditer(body):
        qualifier, name = match.group(1), match.group(2)
        if qualifier in RESERVED or name in SKIP_CALLS:
            continue
        line = base_line + body.count("\n", 0, match.start())
        if (name, qualifier, line) in seen:
            continue
        seen.add((name, qualifier, line))
        calls.append({"name": name, "qualifier": qualifier, "line": line})
    for match in NEW_RE.finditer(body):
        name = match.group(1)
        if name in RESERVED or name[0].islower():
            continue
        line = base_line + body.count("\n", 0, match.start())
        if (name, "new", line) in seen:
            continue
        seen.add((name, "new", line))
        calls.append({"name": name, "qualifier": "new", "line": line})
    calls.sort(key=lambda c: c["line"])
    return calls


def _structural_facts(inner):
    """方法级结构摘要：分支、循环、异常捕获的次数（CFG/DDG 的轻量投影）。"""
    return {
        "branches": len(re.findall(r"\bif\s*\(", inner)) + len(re.findall(r"\bswitch\s*\(", inner))
                    + inner.count("?"),
        "loops": len(re.findall(r"\b(for|while|do)\s*[\(\{]", inner)),
        "catches": len(re.findall(r"\bcatch\s*\(", inner)),
    }


def _parse_methods(body, base_line, docs=None):
    methods = []
    for match in METHOD_RE.finditer(body):
        name = match.group("name")
        ret = re.sub(r"\s+", " ", match.group("ret")).strip()
        mods = re.sub(r"\s+", " ", match.group("mods")).strip() or "package"
        params = re.sub(r"\s+", " ", match.group("params")).strip()
        if name in RESERVED or name == ret:
            continue
        open_index = match.end() - 1
        inner, close_index = _balanced(body, open_index)
        line_no = base_line + body.count("\n", 0, match.start())
        end_line = base_line + body.count("\n", 0, close_index)
        facts = _structural_facts(inner)
        methods.append({
            "name": name,
            "return_type": ret,
            "params": params,
            "signature": ("%s %s(%s)" % (ret, name, params)).strip(),
            "modifiers": mods,
            "line": line_no,
            "end_line": end_line,
            "doc": doc_before(docs, line_no) if docs else "",
            "loc": max(1, end_line - line_no + 1),
            "is_public": "public" in mods and "private" not in mods,
            "branches": facts["branches"],
            "loops": facts["loops"],
            "catches": facts["catches"],
            "body": inner[:4000],
            "calls": _calls_in(inner, line_no),
        })
    return methods


def _parse_fields(body, class_body_start):
    fields = []
    for match in FIELD_RE.finditer(body):
        ftype, fname = match.group(1), match.group(2)
        if ftype in RESERVED or fname in RESERVED:
            continue
        fields.append({"name": fname, "type": ftype})
    return fields[:12]


def _base_type(text):
    if not text:
        return ""
    cleaned = re.sub(r"<[^>]*>", "", text).replace("[]", "").strip()
    return cleaned.split(".")[-1].strip()


def _type_list(head, keyword):
    """从类声明头部取 extends / implements 后面的类型名列表。"""
    match = re.search(r"\b%s\s+([\w.,<>\s]+?)(?=implements\b|$|\s*throws)" % keyword, head)
    if not match:
        return []
    names = []
    for part in match.group(1).split(","):
        name = _base_type(part)
        if name and name not in names:
            names.append(name)
    return names


def parse_source(src):
    clean, docs = strip_comments(src)
    package_match = PACKAGE_RE.search(clean)
    package = package_match.group(1) if package_match else ""
    imports = IMPORT_RE.findall(clean)

    classes = []
    for match in CLASS_RE.finditer(clean):
        kind, name = match.group(1), match.group(2)
        after = clean[match.end():match.end() + 400]
        brace = after.find("{")
        if brace < 0 or ";" in after[:brace]:
            continue
        line_no = clean.count("\n", 0, match.start()) + 1
        head = after[:brace]
        body, _ = _balanced(clean, match.end() + brace)
        classes.append({
            "name": name,
            "kind": kind,
            "line": line_no,
            "doc": doc_before(docs, line_no),
            "extends": _type_list(head, "extends"),
            "implements": _type_list(head, "implements"),
            "fields": _parse_fields(body, line_no),
            "methods": _parse_methods(body, line_no, docs),
        })
    return {"package": package, "imports": imports, "classes": classes,
            "lines": clean.count("\n") + 1}


def parse_file(path):
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        return parse_source(handle.read())
