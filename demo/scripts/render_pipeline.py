#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 docs/analysis-pipeline.yaml 渲染成二维流水线图（纯标准库，无第三方依赖）。

用法：
    python scripts/render_pipeline.py
产物：
    docs/img/pipeline-2d.svg   矢量图（论文里可直接插入）
    docs/pipeline-2d.html      同尺寸预览页（便于浏览器截图/答辩展示）

YAML 解析只覆盖本项目用到的子集：缩进映射、`- ` 列表、`[a, b]` 行内序列、字符串与整数。
"""
from __future__ import annotations

import html
import io
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.normpath(os.path.join(HERE, "..", "docs"))
SRC = os.path.join(DOCS, "analysis-pipeline.yaml")
OUT_SVG = os.path.join(DOCS, "img", "pipeline-2d.svg")
OUT_HTML = os.path.join(DOCS, "pipeline-2d.html")


# ---------------------------------------------------------------- YAML 子集
def _strip_comment(line: str) -> str:
    # 仅去掉整行注释；值里的 # 都属于文本内容
    return "" if line.lstrip().startswith("#") else line.rstrip()


def _scalar(text: str):
    text = text.strip()
    if text.startswith("[") and text.endswith("]"):
        body = text[1:-1].strip()
        return [p.strip() for p in body.split(",")] if body else []
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    return text


def _parse_block(lines, i, indent):
    if i >= len(lines):
        return None, i
    is_list = lines[i][0] == indent and lines[i][1].startswith("- ")
    box = [] if is_list else {}
    while i < len(lines):
        ind, text = lines[i]
        if ind < indent or (ind == indent and not text.startswith("- ") and is_list):
            break
        if ind > indent:  # 意外缩进，交给上层兜底
            break
        if is_list:
            if not text.startswith("- "):
                break
            item = text[2:].strip()
            if not item:
                value, i = _parse_block(lines, i + 1, indent + 2)
                box.append(value)
                continue
            if ": " in item or item.endswith(":"):
                key, _, rest = item.partition(":")
                entry = {}
                if rest.strip():
                    entry[key.strip()] = _scalar(rest)
                    i += 1
                else:
                    value, i = _parse_block(lines, i + 1, indent + 2)
                    entry[key.strip()] = value
                # 同一列表项里的后续键（缩进 +2）
                while i < len(lines) and lines[i][0] == indent + 2 and not lines[i][1].startswith("- "):
                    k2, _, v2 = lines[i][1].partition(":")
                    entry[k2.strip()] = _scalar(v2)
                    i += 1
                box.append(entry)
                continue
            box.append(_scalar(item))
            i += 1
            continue
        key, _, rest = text.partition(":")
        key = key.strip()
        if rest.strip():
            box[key] = _scalar(rest)
            i += 1
        else:
            value, i = _parse_block(lines, i + 1, indent + 2)
            box[key] = value
    return box, i


def load_yaml(path: str):
    raw = io.open(path, encoding="utf-8").read().splitlines()
    lines = []
    for line in raw:
        line = _strip_comment(line.replace("\t", "  "))
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip(" "))
        lines.append((indent, line.strip()))
    data, _ = _parse_block(lines, 0, lines[0][0] if lines else 0)
    return data


# ---------------------------------------------------------------- SVG 画布
W, H = 1240, 980
BG = "#f5f7fb"
CARD = "#ffffff"
LINE = "#dbe3ef"
INK = "#172033"
MUTED = "#66758a"
ACCENT = "#2563eb"
CYAN = "#0ea5a4"
OK = "#16835b"
MONO = "'JetBrains Mono', ui-monospace, Consolas, monospace"
SANS = "-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"

parts = []


def add(s):
    parts.append(s)


def esc(t):
    return html.escape(str(t or ""), quote=True)


def tw(s, size):
    """按中英文估宽，用于把文字裁到卡片内。"""
    return sum(size * (1.0 if ord(ch) > 127 else 0.56) for ch in s)


def clip(s, maxw, size):
    s = str(s or "")
    out = ""
    for ch in s:
        if tw(out + ch, size) > maxw:
            return out[:-1] + "…" if out else "…"
        out += ch
    return out


def wrap(s, maxw, size, max_lines=2):
    s = str(s or "")
    lines, cur = [], ""
    for ch in s:
        if tw(cur + ch, size) > maxw:
            lines.append(cur)
            cur = ch
            if len(lines) == max_lines:
                break
        else:
            cur += ch
    else:
        if cur:
            lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
    if lines and tw("".join(lines), size) < tw(s, size):
        lines[-1] = clip(lines[-1] + "…", maxw, size)
    return lines or [""]


def text(x, y, s, size=12, fill=INK, weight=400, family=SANS, anchor="start", ls=0):
    extra = f' letter-spacing="{ls}"' if ls else ""
    add(f'<text x="{x}" y="{y}" font-size="{size}" fill="{fill}" font-weight="{weight}" '
        f'font-family="{family}" text-anchor="{anchor}"{extra}>{esc(s)}</text>')


def box(x, y, w, h, rx=10, fill=CARD, stroke=LINE, sw=1):
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
        f'stroke="{stroke}" stroke-width="{sw}"/>')


def arrow(x1, y1, x2, y2, color=LINE):
    add(f'<path d="M{x1},{y1} L{x2},{y2}" stroke="{color}" stroke-width="1.4" '
        f'marker-end="url(#arrow)" fill="none"/>')


def band_title(y, no, title, note=""):
    text(40, y, no, 11, ACCENT, 600, MONO, ls=1.4)
    text(66, y, title, 15, INK, 650)
    if note:
        text(66 + len(title) * 15 + 12, y, note, 11.5, MUTED)


def render(data):
    stages = data.get("stages") or []
    algos = data.get("algorithms") or []
    views = data.get("views") or []
    inv = data.get("invariants") or []
    meta = data.get("meta") or {}

    add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
    add('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" '
        'markerHeight="7" orient="auto-start-reverse">'
        f'<path d="M 0 0 L 10 5 L 0 10 z" fill="{LINE}"/></marker>'
        '<pattern id="dot" width="22" height="22" patternUnits="userSpaceOnUse">'
        f'<circle cx="1" cy="1" r="1" fill="#dfe7f2"/></pattern></defs>')
    add(f'<rect width="{W}" height="{H}" fill="{BG}"/>')
    add(f'<rect width="{W}" height="{H}" fill="url(#dot)"/>')

    # 标题
    text(40, 52, "● 分析流水线", 11, ACCENT, 600, MONO, ls=1.2)
    text(40, 88, "从 Java 仓库到需求与架构：一条可核对的分析链", 26, INK, 700)
    text(40, 114, meta.get("determinism", ""), 12, MUTED)
    text(W - 40, 52, "PIPELINE v" + str(data.get("version", 1)), 10.5, MUTED, 500, MONO, anchor="end", ls=1.2)
    text(W - 40, 72, meta.get("engine_policy", "")[:52], 10.5, MUTED, 400, SANS, anchor="end")

    # ① 流水线：两行四列
    band_title(160, "01", "分析阶段", "横轴阅读；每个阶段写清工具、产物与依据")
    sx, sy, cw, ch, gx, gy = 40, 178, 268, 104, 24, 18
    for idx, st in enumerate(stages[:8]):
        row, col = divmod(idx, 4)
        x = sx + col * (cw + gx)
        y = sy + row * (ch + gy)
        box(x, y, cw, ch)
        text(x + 14, y + 22, st.get("id", ""), 10.5, ACCENT, 600, MONO, ls=1.2)
        text(x + 44, y + 22, st.get("name", ""), 13.5, INK, 650)
        if st.get("llm") and st.get("llm") != "none":
            add(f'<circle cx="{x + cw - 16}" cy="{y + 18}" r="4" fill="{CYAN}"/>')
            text(x + cw - 26, y + 22, "LLM", 9, CYAN, 600, MONO, anchor="end")
        text(x + 14, y + 44, clip(st.get("tool", ""), 238, 10), 10, MUTED, 400, MONO)
        out_lines = wrap(st.get("output", ""), 238, 11, 1)
        text(x + 14, y + 64, out_lines[0], 11, INK)
        text(x + 14, y + 84, clip("依据 " + str(st.get("paper", "")), 238, 9.5), 9.5, MUTED)
        if col < 3 and idx < 7:
            arrow(x + cw + 4, y + ch / 2, x + cw + gx - 4, y + ch / 2)
    # S4 换行接到 S5：画一条虚线回路，避免「断了」的观感
    if len(stages) > 4:
        x4 = sx + 3 * (cw + gx) + cw / 2
        x5 = sx + cw / 2
        y4 = sy + ch + 2
        y5 = sy + (ch + gy) - 2
        add(f'<path d="M{x4},{y4} L{x4},{y4 + 9} L{x5},{y4 + 9} L{x5},{y5}" '
            f'stroke="{LINE}" stroke-width="1.2" stroke-dasharray="4 3" fill="none" '
            'marker-end="url(#arrow)"/>')
        text(x5 + 8, y4 + 6, "承接上一行", 9, MUTED, 400, MONO)

    # ② 算法核对
    band_title(470, "02", "算法接入", "输入 / 输出 / 对照基线 / 指标，可在评测页复现")
    ax, ay, aw, ah = 40, 488, 276, 96
    for idx, al in enumerate(algos[:4]):
        x = ax + idx * (aw + 20)
        box(x, ay, aw, ah, rx=10)
        text(x + 14, ay + 22, str(al.get("id", "")), 10.5, OK, 600, MONO, ls=1.2)
        text(x + 44, ay + 22, al.get("name", ""), 12.5, INK, 650)
        text(x + 14, ay + 44, clip(f'{al.get("input", "")} → {al.get("output", "")}', 246, 10.5), 10.5, INK)
        text(x + 14, ay + 62, clip(f'基线 {al.get("baseline", "")}', 246, 10), 10, MUTED)
        text(x + 14, ay + 80, clip(f'指标 {al.get("metric", "")}', 246, 10), 10, MUTED)

    # ③ 八个页面的二维编码
    band_title(632, "03", "结果展示", "每页只有两个维度，图里有面积或位置的含义")
    vx, vy, vw, vh = 40, 650, 268, 74
    for idx, v in enumerate(views[:8]):
        row, col = divmod(idx, 4)
        x = vx + col * (vw + 24)
        y = vy + row * (vh + 14)
        box(x, y, vw, vh, rx=9)
        text(x + 14, y + 24, v.get("name", ""), 12.5, INK, 650)
        dims = v.get("dims") or []
        if len(dims) == 2:
            text(x + 14, y + 44, f'{dims[0]} × {dims[1]}', 10.5, ACCENT, 500, MONO)
        text(x + 14, y + 62, v.get("chart", ""), 10, MUTED)

    # ④ 约束
    band_title(830, "04", "硬约束", "与「设计约束」一致，实现里逐条可查")
    ix, iy = 40, 846
    for idx, item in enumerate(inv[:6]):
        wpx = 186
        x = ix + (idx % 6) * (wpx + 12)
        y = iy
        box(x, y, wpx, 60, rx=8, fill="#ffffff")
        text(x + 10, y + 18, str(item.get("id", "")), 10, ACCENT, 600, MONO)
        lines = wrap(item.get("text", ""), 156, 9.2, 2)
        for li, line in enumerate(lines):
            text(x + 10, y + 34 + li * 13, line, 9.2, INK)

    text(40, H - 26, "LLM 仅参与命名（青点标记），结构事实、图可达性与指标全部由确定性算法产出", 11, MUTED)
    text(W - 40, H - 26, "render_pipeline.py · source: docs/analysis-pipeline.yaml", 9.5, MUTED, 400, MONO, anchor="end")
    add("</svg>")


def main():
    if not os.path.exists(SRC):
        raise SystemExit(f"缺少 {SRC}")
    data = load_yaml(SRC)
    render(data)
    svg = "\n".join(parts)
    os.makedirs(os.path.dirname(OUT_SVG), exist_ok=True)
    io.open(OUT_SVG, "w", encoding="utf-8").write(svg)
    page = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>分析流水线 · 二维视图</title>
<style>html,body{{margin:0;background:#eef3f9}}main{{max-width:1280px;margin:0 auto;padding:24px}}
svg{{width:100%;height:auto;display:block;border-radius:12px;box-shadow:0 8px 24px #0f172a14}}</style>
</head><body><main>{svg}</main></body></html>"""
    io.open(OUT_HTML, "w", encoding="utf-8").write(page)
    print("stages:", len(data.get("stages") or []), "algorithms:", len(data.get("algorithms") or []),
          "views:", len(data.get("views") or []), "invariants:", len(data.get("invariants") or []))
    print("written:", OUT_SVG)
    print("written:", OUT_HTML)


if __name__ == "__main__":
    main()
