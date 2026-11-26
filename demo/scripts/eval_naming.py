#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""对功能条目的命名做全量体检，补上「人工抽样只有 60 条」的短板。

两类检查：
1) 全量规则分：覆盖面、动词开头、中文占比、重名、长度、消歧括号；
2) 人工抽样分：如果 docs/naming-sample.csv 存在（列：evidence,expected），
   比对「条目名是否命中期望关键词」，给出精确/部分命中率。

用法：
    python scripts/eval_naming.py            # 默认查 pid=1 与 pid=3
    python scripts/eval_naming.py 3 4        # 指定工程
"""
from __future__ import annotations

import csv
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.normpath(os.path.join(HERE, "..", "backend"))
sys.path.insert(0, BACKEND)

from app import db  # noqa: E402

VERBS = ("列出 查询 查看 添加 新增 创建 修改 更新 删除 移除 保存 提交 取消 支付 登录 登出 "
         "认证 处理 生成 导入 导出 分配 绑定 启用 禁用 标记 校验 统计 计算 获取 设置 "
         "转换 发送 接收 上传 下载 清空 解锁 锁定 刷新 校验 注册 重置 修改").split()
CJK = re.compile(r"[\u4e00-\u9fff]")
SAMPLE = os.path.join(HERE, "..", "docs", "naming-sample.csv")


def rows(pid):
    return db.query("SELECT name, summary, evidence, level FROM functions "
                    "WHERE project_id=? AND level=2 ORDER BY id", (pid,))


def score(pid):
    items = rows(pid)
    total = len(items)
    if not total:
        return None
    names = [row["name"] or "" for row in items]
    dup = total - len(set(names))
    verb = sum(1 for name in names if any(name.startswith(v) for v in VERBS))
    chinese = sum(1 for name in names if CJK.search(name))
    short = sum(1 for name in names if 0 < len(name) <= 12)
    paren = sum(1 for name in names if "（" in name)
    return {"pid": pid, "total": total, "dup": dup, "verb": verb,
            "chinese": chinese, "short": short, "paren": paren,
            "coverage": 1.0 - dup / total, "verb_rate": verb / total,
            "chinese_rate": chinese / total, "short_rate": short / total,
            "paren_rate": paren / total}


def manual(pid):
    if not os.path.exists(SAMPLE):
        return None
    by_evidence = {}
    with io.open(SAMPLE, encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            evidence = (row.get("evidence") or "").strip()
            expected = (row.get("expected") or "").strip()
            if evidence and expected:
                by_evidence[evidence] = expected
    items = {row["evidence"]: row for row in rows(pid) if row["evidence"]}
    hit = part = seen = 0
    misses = []
    for evidence, expected in by_evidence.items():
        row = items.get(evidence)
        if not row:
            continue
        seen += 1
        name = row["name"] or ""
        if expected == name:
            hit += 1
        elif expected in name or name in expected:
            part += 1
        else:
            misses.append((evidence, expected, name))
    return {"seen": seen, "exact": hit, "partial": part, "misses": misses}


def main():
    pids = [int(arg) for arg in sys.argv[1:]] or [1, 3]
    print("工程  条目  重名  动词开头  中文  长度≤12  带消歧")
    for pid in pids:
        result = score(pid)
        if not result:
            print(pid, "没有功能条目")
            continue
        print("%-4s %4d %5d %7.1f%% %5.1f%% %6.1f%% %6.1f%%" % (
            result["pid"], result["total"], result["dup"],
            result["verb_rate"] * 100, result["chinese_rate"] * 100,
            result["short_rate"] * 100, result["paren_rate"] * 100))
        sample = manual(pid)
        if sample:
            print("     人工抽样 %d 条：精确 %d、部分 %d" % (
                sample["seen"], sample["exact"], sample["partial"]))
            for miss in sample["misses"][:5]:
                print("       miss", miss[0], "期望", miss[1], "实际", miss[2])
        else:
            print("     没有 docs/naming-sample.csv，跳过人工抽样比对")


if __name__ == "__main__":
    main()
