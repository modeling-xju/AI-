# -*- coding: utf-8 -*-
"""把数据库里的分析结果整理成前端要的 JSON。"""
from . import db
from .core import codegraph, docs, retrieve

LAYER_ORDER = ["接入层", "业务层", "数据层", "领域层", "公共层", "其他"]
STEP_PERCENT = {
    "": 0, "扫描源码": 8, "解析结构": 26, "解析社区发现": 58, "社区发现": 58,
    "归纳功能": 74, "恢复架构": 88, "计算指标": 96, "完成": 100,
}


class NotFound(Exception):
    pass


def _project(pid):
    row = db.project(pid)
    if not row:
        raise NotFound("工程 %s 不存在" % pid)
    return row


def projects():
    rows = db.list_projects()
    return [{"id": row["id"], "name": row["name"], "root": row["root"],
             "status": row["status"], "engine": row["engine"] or "self",
             "created_at": row["created_at"]} for row in rows]


def status(pid):
    row = _project(pid)
    return {"id": row["id"], "status": row["status"], "step": row["step"] or "",
            "percent": STEP_PERCENT.get(row["step"] or "", 0),
            "running": row["status"] == "running",
            "engine": row["engine"] or "self",
            "error": row["error"] or ""}


OVERVIEW_KEYS = ("classes", "methods", "files", "modules", "calls", "modularity",
                 "package_modularity", "nmi", "cohesion", "recall_fusion")
GRAPH_KEYS = ("cpg_nodes", "cpg_edges", "cpg_ast", "cpg_call", "cpg_cfg", "cpg_cdg",
              "cpg_ddg", "cpg_ref")


def graph_stats(pid):
    """属性图统计：节点/边与六类边的计数。"""
    rows = db.query("SELECT key, label, value FROM metrics WHERE project_id=? "
                    "AND key LIKE 'cpg\\_%' ESCAPE '\\' ORDER BY id", (pid,))
    by_key = {row["key"]: row for row in rows}
    return {
        "nodes": int(by_key.get("cpg_nodes", {}).get("value", 0) or 0),
        "edges": int(by_key.get("cpg_edges", {}).get("value", 0) or 0),
        "by_type": {key.replace("cpg_", ""): int(by_key[key]["value"] or 0)
                    for key in GRAPH_KEYS[2:] if key in by_key},
    }


def overview(pid):
    project_row = _project(pid)
    rows = db.query("SELECT key, label, value, note FROM metrics WHERE project_id=? "
                    "ORDER BY id", (pid,))
    metrics = [row for row in rows if row["key"] in OVERVIEW_KEYS]
    modules = db.query("SELECT id, name, evidence, size, method_count, cohesion "
                       "FROM modules WHERE project_id=? ORDER BY size DESC, id", (pid,))
    classes = db.query("SELECT id, name, layer, module_id, doc FROM classes "
                       "WHERE project_id=? ORDER BY name", (pid,))
    for module in modules:
        members = [cls for cls in classes if cls["module_id"] == module["id"]]
        module["classes"] = [{"id": cls["id"], "name": cls["name"], "layer": cls["layer"]}
                             for cls in members[:12]]
        module["summary"] = (module["evidence"] or "").strip()
    function_count = db.query_one(
        "SELECT COUNT(*) AS n FROM functions WHERE project_id=? AND parent_id IS NOT NULL",
        (pid,))["n"]
    document_count = db.query_one("SELECT COUNT(*) AS n FROM documents WHERE project_id=?",
                                  (pid,))["n"]
    return {
        "project": {"id": project_row["id"], "name": project_row["name"],
                    "engine": project_row["engine"] or "self",
                    "root": project_row["root"], "status": project_row["status"],
                    "file_count": project_row["file_count"], "loc": project_row["loc"],
                    "class_count": project_row["class_count"],
                    "method_count": project_row["method_count"],
                    "build_tool": project_row["build_tool"] or "",
                    "test_count": project_row["test_count"] or 0,
                    "config_count": project_row["config_count"] or 0,
                    "languages": db.load_json(project_row["languages"]) or {},
                    "graph_nodes": project_row["graph_nodes"] or 0,
                    "graph_edges": project_row["graph_edges"] or 0,
                    "created_at": project_row["created_at"]},
        "metrics": metrics,
        "modules": modules,
        "function_count": function_count,
        "document_count": document_count,
    }


def structure(pid):
    _project(pid)
    classes = db.query("SELECT id, name, package, kind, layer, module_id, start_line AS line, "
                       "doc, file_id FROM classes WHERE project_id=? ORDER BY name", (pid,))
    methods = db.query("SELECT id, class_id, name, signature, return_type, line, loc, doc, "
                       "branches, loops, catches FROM methods WHERE project_id=? "
                       "ORDER BY class_id, line", (pid,))
    files = db.query("SELECT id, path, package, loc, category FROM files WHERE project_id=? "
                     "ORDER BY path", (pid,))
    calls = db.query("SELECT caller_id, callee_name, qualifier, line, "
                     "CASE WHEN callee_id IS NULL THEN 0 ELSE 1 END AS resolved "
                     "FROM calls WHERE project_id=?", (pid,))

    method_by_class, call_by_method = {}, {}
    for method in methods:
        method_by_class.setdefault(method["class_id"], []).append(
            {"id": method["id"], "name": method["name"], "signature": method["signature"],
             "return_type": method["return_type"], "line": method["line"],
             "loc": method["loc"], "doc": method["doc"],
             "branches": method["branches"], "loops": method["loops"],
             "catches": method["catches"], "calls": []})
    # 调用点按行号归到方法上
    for call in calls:
        call_by_method.setdefault(call["caller_id"], []).append(call)
    for method in methods:
        for item in method_by_class[method["class_id"]]:
            if item["id"] == method["id"]:
                item["calls"] = [{"name": c["callee_name"], "qualifier": c["qualifier"],
                                  "line": c["line"], "resolved": bool(c["resolved"])}
                                 for c in call_by_method.get(method["id"], [])]

    file_map = {row["id"]: row for row in files}
    for row in files:
        row["classes"] = []
    for cls in classes:
        parent = file_map.get(cls["file_id"])
        if parent is not None:
            parent["classes"].append({
                "id": cls["id"], "name": cls["name"], "kind": cls["kind"],
                "layer": cls["layer"], "package": cls["package"], "line": cls["line"],
                "doc": cls["doc"], "module_id": cls["module_id"],
                "methods": method_by_class.get(cls["id"], []),
            })
    return {"files": files, "classes_total": len(classes),
            "methods_total": len(methods), "calls_total": len(calls),
            "graph": graph_stats(pid)}


def functions(pid):
    _project(pid)
    roots = db.query("SELECT id, name, summary, evidence FROM functions WHERE project_id=? "
                     "AND parent_id IS NULL ORDER BY id", (pid,))
    leaves = db.query("SELECT id, name, summary, evidence, module_id, parent_id FROM functions "
                      "WHERE project_id=? AND parent_id IS NOT NULL ORDER BY id", (pid,))
    tree = []
    for root in roots:
        children = [{"id": leaf["id"], "name": leaf["name"], "summary": leaf["summary"],
                     "evidence": leaf["evidence"], "module_id": leaf["module_id"]}
                    for leaf in leaves if leaf["parent_id"] == root["id"]]
        tree.append({"id": root["id"], "name": root["name"], "summary": root["summary"],
                     "children": children})
    return {"tree": tree, "leaf_count": len(leaves)}


def architecture(pid):
    _project(pid)
    rows = db.query("SELECT id, module_id, name, layer, classes, provides, depends_on "
                    "FROM components WHERE project_id=?", (pid,))
    layers = {}
    for row in rows:
        layers.setdefault(row["layer"], []).append({
            "id": row["id"], "module": row["name"], "name": row["name"],
            "layer": row["layer"],
            "classes": db.load_json(row["classes"]),
            "provides": db.load_json(row["provides"]),
            "depends_on": db.load_json(row["depends_on"]),
        })
    ordered = [{"name": name, "components": layers[name]}
               for name in LAYER_ORDER if name in layers]
    return {"layers": ordered,
            "matrix": _layer_matrix(pid),
            "component_functions": _component_functions(pid),
            "entries": codegraph.critical_paths(pid, limit=3)}


def _layer_matrix(pid):
    """层 × 层 依赖矩阵：格子里的数字是跨层的类级调用条数。"""
    classes = db.query("SELECT id, layer FROM classes WHERE project_id=?", (pid,))
    layer_of = {row["id"]: row["layer"] for row in classes}
    calls = db.query("SELECT caller_id, callee_id FROM calls WHERE project_id=? "
                     "AND callee_id IS NOT NULL", (pid,))
    index = {name: pos for pos, name in enumerate(LAYER_ORDER)}
    cells = [[0 for _ in LAYER_ORDER] for _ in LAYER_ORDER]
    for row in calls:
        src, dst = layer_of.get(row["caller_id"]), layer_of.get(row["callee_id"])
        if src in index and dst in index:
            cells[index[src]][index[dst]] += 1
    return {"layers": LAYER_ORDER, "cells": cells}


def _component_functions(pid):
    """组件—功能对齐：功能条目按 evidence 里的类名回到所属层与模块。"""
    classes = db.query("SELECT name, layer, module_id FROM classes WHERE project_id=?", (pid,))
    by_name = {row["name"]: row for row in classes}
    modules = {row["id"]: row["name"] for row in
               db.query("SELECT id, name FROM modules WHERE project_id=?", (pid,))}
    leaves = db.query("SELECT id, name, evidence, module_id FROM functions WHERE project_id=? "
                      "AND parent_id IS NOT NULL ORDER BY id", (pid,))
    grouped = {}
    for leaf in leaves:
        class_name = (leaf["evidence"] or "").split(".")[0]
        cls = by_name.get(class_name)
        layer = cls["layer"] if cls else "其他"
        module_id = leaf["module_id"] or (cls["module_id"] if cls else None)
        key = (modules.get(module_id, "未归属模块"), layer)
        grouped.setdefault(key, []).append({"id": leaf["id"], "name": leaf["name"],
                                            "evidence": leaf["evidence"]})
    result = [{"module": module, "layer": layer, "functions": items}
              for (module, layer), items in sorted(grouped.items(),
                                                   key=lambda kv: (kv[0][0], kv[0][1]))]
    return result


def compare(pid):
    _project(pid)
    metrics = db.query("SELECT key, label, value, note FROM metrics WHERE project_id=? "
                       "ORDER BY id", (pid,))
    by_key = {row["key"]: row["value"] for row in metrics}
    evaluation = retrieve.evaluate(pid)
    return {
        "metrics": metrics,
        "package_modularity": by_key.get("package_modularity", 0),
        "nmi": by_key.get("nmi", 0),
        "retrieval": evaluation,
    }


def search(pid, query, mode="bm25", k=10):
    _project(pid)
    return retrieve.search(pid, query, mode=mode, k=k)


def impact(pid, class_id):
    _project(pid)
    result = codegraph.impact(pid, int(class_id))
    if not result:
        raise NotFound("类 %s 不存在" % class_id)
    return result


def graph(pid, op, class_id=None, src=None, dst=None):
    """知识库的图查询入口：谁调用了它 / 它调用了谁 / 两点之间的调用路径。"""
    _project(pid)
    if op in ("callers", "callees"):
        if class_id in (None, ""):
            raise ValueError("缺少 class 参数")
        result = codegraph.callers(pid, int(class_id)) if op == "callers" \
            else codegraph.callees(pid, int(class_id))
        if not result:
            raise NotFound("类 %s 不存在" % class_id)
        return {"op": op, **result}
    if op == "path":
        if not src or not dst:
            raise ValueError("路径查询需要 from 与 to 两个类名")
        return {"op": op, **codegraph.shortest_path(pid, src, dst)}
    raise ValueError("未知的图查询操作：%s" % op)


def documents(pid):
    _project(pid)
    rows = db.query("SELECT id, kind, title, created_at FROM documents WHERE project_id=? "
                    "ORDER BY id", (pid,))
    return {"documents": rows, "count": len(rows)}


def document(pid, doc_id):
    _project(pid)
    row = db.query_one("SELECT id, kind, title, content, created_at FROM documents "
                       "WHERE project_id=? AND id=?", (pid, doc_id))
    if not row:
        raise NotFound("文档 %s 不存在" % doc_id)
    return {"id": row["id"], "kind": row["kind"], "title": row["title"],
            "created_at": row["created_at"], "html": docs.render(row["content"])}


def create_document(pid, kind):
    _project(pid)
    doc_id = docs.generate(pid, kind)
    return document(pid, doc_id)


def export_document(pid, doc_id):
    """导出为 Markdown 附件，供写论文时直接引用。"""
    _project(pid)
    row = db.query_one("SELECT id, kind, title, content, created_at FROM documents "
                       "WHERE project_id=? AND id=?", (pid, doc_id))
    if not row:
        raise NotFound("文档 %s 不存在" % doc_id)
    names = {"api": "接口文档", "manual": "用户手册", "report": "分析报告"}
    filename = "%s-%s.md" % (names.get(row["kind"], row["kind"]), row["created_at"][:10])
    return filename, row["content"]
