# -*- coding: utf-8 -*-
"""汇总人工评测表：功能命名与摘要、报告结论的准确率。

判定列填「对 / 部分 / 错」；部分按 0.5 计。空值跳过。
"""
import csv
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.abspath(os.path.join(HERE, "..", "docs", "人工评测"))
WEIGHT = {"对": 1.0, "部分": 0.5, "错": 0.0}
SHEETS = (("功能命名与摘要.csv", "function"), ("报告结论.csv", "document"))


def score(path):
    with open(path, encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    values = [WEIGHT.get((row.get("判定(对/部分/错)") or "").strip(), None) for row in rows]
    filled = [value for value in values if value is not None]
    if not filled:
        return {"n": len(rows), "answered": 0, "accuracy": None}
    return {"n": len(rows), "answered": len(filled),
            "accuracy": round(sum(filled) / len(filled), 4)}


def main():
    report = {}
    for filename, key in SHEETS:
        path = os.path.join(OUT, filename)
        report[key] = score(path) if os.path.exists(path) else {"n": 0, "answered": 0, "accuracy": None}
        item = report[key]
        print("%s：%d 条，已判定 %d，准确率 %s" % (
            filename, item["n"], item["answered"],
            "%.1f%%" % (item["accuracy"] * 100) if item["accuracy"] is not None else "—"))
    with open(os.path.join(OUT, "结果.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print("已写", os.path.join(OUT, "结果.json"))


if __name__ == "__main__":
    main()
