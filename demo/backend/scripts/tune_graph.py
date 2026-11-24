# -*- coding: utf-8 -*-
"""临时脚本：跑一次分析并打印模块/依赖指标，用于对比并图前后的效果。"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db  # noqa: E402
from app.core import pipeline  # noqa: E402

pid = int(sys.argv[1]) if len(sys.argv) > 1 else 1
db.init()
t0 = time.time()
pipeline.run(pid)
print("elapsed", round(time.time() - t0, 1), "status", db.project(pid)["status"])
rows = {r["key"]: r["value"] for r in
        db.query("SELECT key, value FROM metrics WHERE project_id=?", (pid,))}
print({k: rows.get(k) for k in
       ("classes", "methods", "calls", "dep_edges", "modules", "modularity", "package_modularity",
        "nmi", "cohesion")})
for m in db.query("SELECT name, size, method_count, cohesion FROM modules "
                  "WHERE project_id=? ORDER BY size DESC LIMIT 6", (pid,)):
    print("  ", m["name"], m["size"], m["method_count"], m["cohesion"])
