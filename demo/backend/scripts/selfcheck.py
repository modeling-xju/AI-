# -*- coding: utf-8 -*-
"""临时自检：建库、跑一次分析、检查新增字段与图查询。"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db, services  # noqa: E402
from app.core import codegraph, pipeline  # noqa: E402

db.init()
print("tables:", [r["name"] for r in db.query("SELECT name FROM sqlite_master WHERE type='table'")])
cols = [r["name"] for r in db.query("PRAGMA table_info(projects)")]
print("project cols:", cols[-4:])

root = os.path.join(db.BASE_DIR, "samples", "minishop")
pid = db.create_project("minishop", root)
pipeline.run(pid)
row = db.project(pid)
print("status:", row["status"], "err:", row["error"][:200])
print("files:", row["file_count"], "build:", row["build_tool"], "tests:", row["test_count"],
      "configs:", row["config_count"])
print("languages:", row["languages"][:120])

ov = services.overview(pid)
print("modules:", len(ov["modules"]), "functions:", ov["function_count"])
arch = services.architecture(pid)
print("layers:", [l["name"] for l in arch["layers"]])
print("entries:", [len(c) for c in arch["entries"]])
print("matrix rows:", len(arch["matrix"]["cells"]))
print("align groups:", len(arch["component_functions"]))
st = services.structure(pid)
sample = st["files"][0]["classes"][0]["methods"][0]
print("method facts:", sample["name"], sample["branches"], sample["loops"], sample["catches"])
cls_id = st["files"][0]["classes"][0]["id"]
print("callers:", len(services.graph(pid, "callers", class_id=cls_id)["nodes"]))
print("callees:", len(services.graph(pid, "callees", class_id=cls_id)["nodes"]))
print("path:", services.graph(pid, "path", src="CartController", dst="CartDao")["found"])
