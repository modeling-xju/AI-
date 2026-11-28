# -*- coding: utf-8 -*-
"""命名基线对比：结构证据命名 vs 只看方法名。

两条通道：
  A = 系统当前条目名（结构证据 + 去重，落库结果）
  B = 仅用方法名做动词+宾语翻译（knowledge.guess_function_name，看不到模块与同类条目）

判定用四条规则（不是人工判定，结论里会标注）：
  ① 含中文  ② 动词开头  ③ 长度 <= 12  ④ 全工程不重名
通过条数 / 4 即该条目得分，均值即通过率。
"""
from __future__ import annotations

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.normpath(os.path.join(HERE, "..", "backend"))
sys.path.insert(0, BACKEND)

from app import db  # noqa: E402
from app.core import knowledge  # noqa: E402

VERBS = ("列出 查询 查看 添加 新增 创建 修改 更新 删除 移除 保存 提交 取消 支付 登录 登出 "
         "认证 处理 生成 导入 导出 分配 绑定 启用 禁用 标记 校验 统计 计算 获取 设置 "
         "转换 发送 接收 上传 下载 清空 解锁 锁定 刷新 注册 重置").split()
CJK = re.compile(r"[\u4e00-\u9fff]")
SUFFIX = re.compile(r"（[^）]*）\s*$")


def strip_suffix(name):
    return SUFFIX.sub("", name or "").strip()


def judge(name, seen, counts):
    base = strip_suffix(name)
    ok = [bool(CJK.search(base)), base.startswith(tuple(VERBS)),
          0 < len(base) <= 12, counts.get(base, 0) == 1]
    return sum(1 for item in ok if item) / 4.0, ok


def run(pid):
    rows = db.query("SELECT name, evidence FROM functions WHERE project_id=? "
                    "AND parent_id IS NOT NULL ORDER BY id", (pid,))
    project = db.project(pid) or {}
    a = [strip_suffix(r["name"]) for r in rows]
    b = []
    for row in rows:
        method = (row["evidence"] or "").split(".")[-1]
        b.append(strip_suffix(knowledge.guess_function_name(method, "")) if method else "")
    counts_a, counts_b = {}, {}
    for name in a:
        counts_a[name] = counts_a.get(name, 0) + 1
    for name in b:
        counts_b[name] = counts_b.get(name, 0) + 1
    score_a = [judge(name, None, counts_a) for name in a]
    score_b = [judge(name, None, counts_b) for name in b]
    mean_a = sum(s for s, _ in score_a) / (len(score_a) or 1)
    mean_b = sum(s for s, _ in score_b) / (len(score_b) or 1)
    detail = []
    for row, name_a, name_b, (sa, _), (sb, _) in zip(rows, a, b, score_a, score_b):
        detail.append({"evidence": row["evidence"], "structured": name_a, "method_only": name_b,
                       "score_structured": round(sa, 2), "score_method_only": round(sb, 2)})
    return {"pid": pid, "project": project.get("name") or str(pid), "leaves": len(rows),
            "structured": round(mean_a, 4), "method_only": round(mean_b, 4),
            "delta": round(mean_a - mean_b, 4), "detail": detail}


def main():
    pids = [int(x) for x in sys.argv[1:]] or [1, 3]
    results = [run(pid) for pid in pids]
    out = {"judge": "规则判定（中文/动词开头/长度/唯一性），非人工判定",
           "results": results}
    path = os.path.join(BACKEND, "..", "docs", "naming-baseline.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=2)
    print("工程\t条目\t结构证据命名\t只看方法名\t差值")
    for item in results:
        print("%s\t%d\t%.1f%%\t%.1f%%\t%+.1f pt" % (
            item["project"], item["leaves"], item["structured"] * 100,
            item["method_only"] * 100, item["delta"] * 100))
    print("写入", path)


if __name__ == "__main__":
    main()