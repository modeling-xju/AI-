# -*- coding: utf-8 -*-
"""生成人工评测抽样表：功能命名与摘要、报告结论各若干条。

用法：
    python scripts/make_eval_sheet.py            # 默认输出 docs/人工评测/
    python scripts/make_eval_sheet.py --per-project 16 --seed 7
"""
import argparse
import csv
import os
import random
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "backend"))

from app import db, services              # noqa: E402
from app.core import docs                 # noqa: E402

PROJECTS = ("SpringBlade", "minishop")
CITE = re.compile(r"[A-Za-z_][\w]*\.[a-z_]\w*|第\s*\d+\s*行")


def walk(nodes, module=""):
    for node in nodes or []:
        kids = node.get("children") or []
        here = module or (node.get("name") if kids else module)
        if kids:
            yield from walk(kids, here)
        else:
            node["_module"] = here
            yield node


def project_rows(name, per_project, rng):
    row = db.query("SELECT id FROM projects WHERE name=? ORDER BY id DESC LIMIT 1", (name,))
    if not row:
        return [], []
    pid = row[0]["id"]
    payload = services.functions(pid)
    leaves = list(walk(payload.get("tree")))

    # 按模块轮询抽样，保证每个模块都有代表
    buckets = {}
    for leaf in leaves:
        buckets.setdefault(leaf.get("_module") or "未分组", []).append(leaf)
    order = sorted(buckets)
    picks, cursor = [], 0
    while len(picks) < min(per_project, len(leaves)):
        added = False
        for key in order:
            bucket = buckets[key]
            if cursor < len(bucket):
                picks.append(bucket[cursor])
                added = True
                if len(picks) >= per_project:
                    break
        if not added:
            break
        cursor += 1

    fn_rows = []
    for index, leaf in enumerate(picks, 1):
        fn_rows.append({
            "工程": name,
            "编号": "F%02d" % index,
            "模块": leaf.get("_module") or "",
            "功能名": leaf.get("name", ""),
            "摘要": leaf.get("summary", ""),
            "证据": leaf.get("evidence", ""),
            "判定(对/部分/错)": "",
            "备注": "",
        })

    text = docs.report_doc(pid)
    lines = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("|") and line.count("|") >= 4 and not set(line) <= set("|-: "):
            lines.append(("表格", line))
        elif line.startswith("- ") or line.startswith("* "):
            lines.append(("要点", line.lstrip("-* ").strip()))
    lines = [item for item in lines if len(item[1]) >= 18 and re.search(r"\d", item[1])]
    rng.shuffle(lines)
    doc_rows = []
    for index, (kind, line) in enumerate(lines[: max(6, per_project // 2)], 1):
        doc_rows.append({
            "工程": name,
            "编号": "D%02d" % index,
            "类型": kind,
            "原文": line if len(line) <= 300 else line[:297] + "...",
            "能否回指源码(自动)": "是" if CITE.search(line) else "否",
            "判定(对/部分/错)": "",
            "备注": "",
        })
    return fn_rows, doc_rows


def write_csv(path, rows):
    with open(path, "w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-project", type=int, default=12)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", default=os.path.join(HERE, "..", "docs", "人工评测"))
    args = parser.parse_args()

    rng = random.Random(args.seed)
    fn_all, doc_all = [], []
    for name in PROJECTS:
        fn_rows, doc_rows = project_rows(name, args.per_project, rng)
        fn_all.extend(fn_rows)
        doc_all.extend(doc_rows)

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    write_csv(os.path.join(out, "功能命名与摘要.csv"), fn_all)
    write_csv(os.path.join(out, "报告结论.csv"), doc_all)
    print("功能条目 %d 条 -> %s" % (len(fn_all), os.path.join(out, "功能命名与摘要.csv")))
    print("报告结论 %d 条 -> %s" % (len(doc_all), os.path.join(out, "报告结论.csv")))
    print("填完「判定」列后运行：python scripts/score_eval_sheet.py")


if __name__ == "__main__":
    main()
