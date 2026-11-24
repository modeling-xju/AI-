# -*- coding: utf-8 -*-
"""把库里 recall_* 指标刷成当前评测值（改过检索/去重逻辑后不用整条流水线重跑）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import db                      # noqa: E402
from app.core import retrieve           # noqa: E402


def refresh(pid=3, k=5):
    db.init()
    result = retrieve.evaluate(pid, k=k)
    pairs = (
        ("recall_bm25", result["bm25"]),
        ("recall_keyword", result["keyword"]),
        ("recall_vector", result["vector"]),
        ("recall_fusion", result["fusion"]),
    )
    updated = []
    for key, value in pairs:
        row = db.query_one(
            "SELECT id FROM metrics WHERE project_id=? AND key=?", (pid, key))
        if row:
            db.execute("UPDATE metrics SET value=? WHERE id=?", (round(value, 3), row["id"]))
            updated.append((key, round(value, 3)))
    print("cases", result["cases"], updated)


if __name__ == "__main__":
    refresh(int(sys.argv[1]) if len(sys.argv) > 1 else 3)
