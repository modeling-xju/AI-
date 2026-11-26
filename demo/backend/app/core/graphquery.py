# -*- coding: utf-8 -*-
"""自然语言 → 图查询（参考 CodexGraph 的思路，但收敛成可控的小闭环）。

两段式：
1) 规划：把中文/英文问题解析成结构化查询 {op, class, method, from, to}。
   - 配了大模型就让它出 JSON；
   - 没配 / 超时 / 解析失败 / 类名不存在，一律退回规则解析（可复现）。
2) 执行：查询只走既有的 codegraph / SQL，不让模型直接碰数据库。

所有返回都带 `source`（llm / llm-fallback / rule）与 `evidence`（凭哪些类名匹配到的），
前端据此显示「这次是模型规划的，还是规则兜底的」。
"""
import re

from . import codegraph, knowledge
from .. import db

OPS = ("callers", "callees", "path", "methods", "classes", "impact")

# 关键词 → 操作，顺序重要（先判更具体的）
_RULES = [
    ("path", ("路径", "怎么到", "如何到达", "链路", "path", "route")),
    ("impact", ("影响", "波及", "改动", "改这个", "影响面", "impact", "ripple")),
    ("callers", ("谁调用", "被谁调用", "调用方", "谁用了", "callers", "called by", "uses")),
    ("callees", ("调用了谁", "调用了哪些", "依赖谁", "callees", "calls into", "depends on")),
    ("methods", ("哪些方法", "方法列表", "有什么方法", "methods", "method list")),
    ("classes", ("哪些类", "类列表", "都有什么类", "classes")),
]

_CAMEL = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
_CJK_RUN = re.compile(r"[\u4e00-\u9fff]{2,6}")


def _classes(pid):
    return db.query("SELECT id, name, package, layer FROM classes WHERE project_id=? "
                    "ORDER BY name", (pid,))


def _module_of(pid, class_id):
    row = db.query_one("SELECT m.name AS name FROM classes c JOIN modules m ON m.id=c.module_id "
                       "WHERE c.project_id=? AND c.id=?", (pid, class_id))
    return (row or {}).get("name") if row else None


def _match_classes(pid, question):
    """类名匹配：优先「整词出现」，其次子串 / 标识符前缀 / 中文名词，按出现位置排序。"""
    rows = _classes(pid)
    lowered = question.lower()
    exact, loose, reasons = [], [], []

    def boundary(pos, length):
        before = lowered[pos - 1] if pos > 0 else " "
        after = lowered[pos + length] if pos + length < len(lowered) else " "
        return not before.isalnum() and not after.isalnum()

    for row in rows:
        name = row["name"] or ""
        simple = name.split(".")[-1]
        if len(simple) < 3:
            continue
        low = simple.lower()
        pos = lowered.find(low)
        if pos < 0:
            continue
        item = (pos, -len(low), row, "整词命中 %s" % simple)
        (exact if boundary(pos, len(low)) else loose).append(item)

    if not exact and loose:
        # 没有整词命中时，退而求其次，但优先更短、更贴近的类名（Order 先于 OrderController）
        exact = sorted(loose, key=lambda x: (len(x[2]["name"]), x[0]))[:6]
        loose = []

    if not exact:
        for word in _CAMEL.findall(question):
            for row in rows:
                simple = (row["name"] or "").split(".")[-1]
                if len(word) >= 3 and simple.lower().startswith(word.lower()):
                    exact.append((lowered.find(word.lower()), -len(simple), row,
                                  "标识符前缀 %s → %s" % (word, simple)))

    if not exact:
        stems = []
        for chunk in _CJK_RUN.findall(question):
            for en, cn in knowledge.NOUNS.items():
                if cn and cn in chunk and len(en) >= 3:
                    stems.append(en)
        for row in rows:
            simple = (row["name"] or "").lower()
            for stem in stems:
                if stem in simple:
                    exact.append((lowered.find(stem), -len(simple), row,
                                  "中文名词 %s → %s" % (stem, row["name"])))
                    break

    chosen = exact or loose
    chosen.sort(key=lambda x: (x[0], x[1]))
    seen, uniq = set(), []
    for pos, _neg, row, why in chosen:
        if row["id"] in seen:
            continue
        seen.add(row["id"])
        uniq.append(row)
        reasons.append(why)
    return uniq, reasons


def parse_rule(pid, question):
    text = (question or "").strip()
    op = "classes"
    for name, keys in _RULES:
        if any(key in text.lower() for key in keys):
            op = name
            break
    hits, reasons = _match_classes(pid, text)
    if op == "path" and len(hits) >= 2:
        return {"op": "path", "from": hits[0]["name"], "to": hits[1]["name"]}, reasons
    if op in ("callers", "callees", "methods", "impact") and not hits:
        op = "classes"
    spec = {"op": op}
    if hits:
        spec["class"] = hits[0]["name"]
    return spec, reasons


_LLM_PROMPT = """你是代码知识库的查询规划器。把用户问题转成一个 JSON，只能输出 JSON，不要解释。
可用字段：op（callers=谁调用它 / callees=它调用了谁 / path=两个类之间的调用路径 /
methods=类的方法列表 / classes=有哪些类 / impact=改这个类影响谁）、class、from、to。
类名必须从下列清单中原样选取，选不到就留空字符串。

类清单：
%s

用户问题：%s
"""


def parse_llm(pid, question, limit=120):
    if not knowledge.available():
        return None
    rows = _classes(pid)[:limit]
    names = ", ".join(sorted({(r["name"] or "").split(".")[-1] for r in rows}))
    prompt = _LLM_PROMPT % (names, question)
    data = knowledge.complete_json(prompt)
    if not isinstance(data, dict):
        return None
    op = str(data.get("op", "")).strip().lower()
    if op not in OPS:
        return None
    spec = {"op": op}
    for key in ("class", "from", "to"):
        value = str(data.get(key) or "").strip()
        if value:
            spec[key] = value
    return spec


def _resolve(pid, name):
    """类名可能是简名，也可能是全名；解析成库里的一行。"""
    if not name:
        return None
    rows = _classes(pid)
    exact = [r for r in rows if r["name"] == name]
    if exact:
        return exact[0]
    simple = [r for r in rows if (r["name"] or "").split(".")[-1] == name]
    if simple:
        return simple[0]
    fuzzy = [r for r in rows if name.lower() in (r["name"] or "").lower()]
    return fuzzy[0] if len(fuzzy) == 1 else None


def _run(pid, spec, question):
    op = spec.get("op")
    row = _resolve(pid, spec.get("class") or "")
    if op in ("callers", "callees"):
        if not row:
            return {"op": op, "error": "没有匹配到类，请把类名写得更具体"}
        result = (codegraph.callers if op == "callers" else codegraph.callees)(pid, row["id"])
        items = [{"id": r["id"], "name": r["name"], "layer": r.get("layer"),
                  "module": _module_of(pid, r["id"])} for r in (result or {}).get("nodes", [])]
        return {"op": op, "class": {"id": row["id"], "name": row["name"]},
                "items": items, "count": len(items)}
    if op == "path":
        src, dst = _resolve(pid, spec.get("from") or ""), _resolve(pid, spec.get("to") or "")
        if not src or not dst:
            return {"op": op, "error": "路径查询需要两个能对上的类名"}
        result = codegraph.shortest_path(pid, src["name"], dst["name"])
        if not result.get("found"):
            # 调用是有方向的：反向能找到就说明问题问反了，直接给出反向路径并标注
            back = codegraph.shortest_path(pid, dst["name"], src["name"])
            if back.get("found"):
                steps = [{"id": r["id"], "name": r["name"], "layer": r.get("layer")}
                         for r in back.get("path", [])]
                return {"op": op, "from": src["name"], "to": dst["name"], "steps": steps,
                        "hops": max(0, len(steps) - 1), "found": True, "direction": "reverse",
                        "message": "正向不可达，下面是反方向的调用链"}
        steps = [{"id": r["id"], "name": r["name"], "layer": r.get("layer")}
                 for r in result.get("path", [])]
        found = bool(result.get("found"))
        message = result.get("message", "") or ("" if found else "两个类之间双向都没有调用关系")
        return {"op": op, "from": src["name"], "to": dst["name"], "steps": steps,
                "hops": max(0, len(steps) - 1), "found": found, "message": message}
    if op == "methods":
        if not row:
            return {"op": op, "error": "没有匹配到类"}
        rows = db.query("SELECT id, name, signature, line, loc FROM methods "
                        "WHERE project_id=? AND class_id=? ORDER BY line", (pid, row["id"]))
        return {"op": op, "class": {"id": row["id"], "name": row["name"]},
                "items": rows, "count": len(rows)}
    if op == "impact":
        if not row:
            return {"op": op, "error": "没有匹配到类"}
        result = codegraph.impact(pid, row["id"])
        items = [{"id": r["id"], "name": r["name"], "layer": r.get("layer"),
                  "module": r.get("module"), "hop": r.get("hop"),
                  "dynamic": bool(r.get("dynamic"))}
                 for r in (result or {}).get("classes", []) if r["id"] != row["id"]]
        return {"op": op, "class": {"id": row["id"], "name": row["name"]},
                "count": len(items), "max_hop": result.get("max_hop", 0),
                "dynamic_count": result.get("dynamic_count", 0), "items": items}
    # classes：按问题里的词做模糊检索，空问题给全量前 30
    term = question.strip()
    rows = _classes(pid)
    matched = rows
    if term:
        matched = [r for r in rows if term.lower() in (r["name"] or "").lower()]
    note = ""
    if term and not matched:
        matched, note = rows, "问题里的词没有命中类名，先列出全部类（前 30 个）"
    items = [{"id": r["id"], "name": r["name"], "layer": r.get("layer"),
              "module": _module_of(pid, r["id"])} for r in matched[:30]]
    return {"op": "classes", "items": items, "count": len(items), "note": note}


def ask(pid, question, use_llm=True):
    spec, source, evidence = None, "rule", []
    if use_llm and knowledge.available():
        try:
            spec = parse_llm(pid, question)
        except Exception:  # 网络/超时/格式问题都退回规则，演示不能因此崩
            spec = None
        if spec:
            source = "llm"
        else:
            source = "llm-fallback"
    if spec is None:
        spec, evidence = parse_rule(pid, question)
        if source == "llm-fallback":
            _, evidence = _match_classes(pid, question or "")
        else:
            source = "rule"
    result = _run(pid, spec, question or "")
    return {"question": question, "source": source, "plan": spec,
            "evidence": evidence, "result": result,
            "llm_configured": knowledge.available()}
