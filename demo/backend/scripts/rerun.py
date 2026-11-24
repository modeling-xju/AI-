# -*- coding: utf-8 -*-
"""重跑指定工程并打印属性图指标（自检用）。"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db  # noqa: E402
from app.core import pipeline  # noqa: E402

PID = int(sys.argv[1]) if len(sys.argv) > 1 else 3


def main():
    db.init()
    started = time.time()
    pipeline.run(PID)
    print("elapsed %.1fs status=%s" % (time.time() - started, db.project(PID)["status"]))
    rows = db.query("SELECT key, value FROM metrics WHERE project_id=? AND key LIKE 'cpg_%' "
                    "ORDER BY key", (PID,))
    for row in rows:
        print("  %-12s %s" % (row["key"], row["value"]))
    project = db.project(PID)
    print("nodes=%s edges=%s" % (project["graph_nodes"], project["graph_edges"]))


if __name__ == "__main__":
    main()
