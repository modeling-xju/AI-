# -*- coding: utf-8 -*-
"""可选的嵌入模型通道：OpenAI 兼容 /embeddings。

未配置 EMBED_BASE_URL / EMBED_MODEL 时返回 None，检索自动退回 LSA。
"""
from __future__ import annotations

import json
import os
import urllib.request

BASE = (os.environ.get("EMBED_BASE_URL") or "").rstrip("/")
KEY = os.environ.get("EMBED_API_KEY") or ""
MODEL = os.environ.get("EMBED_MODEL") or ""


def available():
    return bool(BASE and MODEL)


def describe():
    return {"backend": "embeddings" if available() else "lsa", "model": MODEL or "lsa-96"}


def embed(texts, batch=32, timeout=60):
    if not available():
        return None
    out = []
    for start in range(0, len(texts), batch):
        chunk = [t[:2000] for t in texts[start:start + batch]]
        body = json.dumps({"model": MODEL, "input": chunk}).encode("utf-8")
        req = urllib.request.Request(BASE + "/embeddings", data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer " + KEY})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        rows = payload.get("data") or []
        if len(rows) != len(chunk):
            raise RuntimeError("embeddings 返回条数不匹配")
        out.extend([row.get("embedding") or [] for row in rows])
    return out
