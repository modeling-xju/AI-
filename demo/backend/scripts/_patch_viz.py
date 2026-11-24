# -*- coding: utf-8 -*-
"""一次性补丁：给 viz.js 里所有检查器容器加 .insp 类。"""
import io
import os

path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                    "frontend", "assets", "viz.js")
src = io.open(path, encoding="utf-8").read()
needle = "const inspector = document.createElement('div');"
filled = "const inspector = document.createElement('div');\n    inspector.className = 'insp';"
count = src.count(needle)
src = src.replace(needle, filled)
io.open(path, "w", encoding="utf-8", newline="\n").write(src)
print("occurrences:", count)
