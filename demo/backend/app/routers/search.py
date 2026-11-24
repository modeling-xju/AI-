# -*- coding: utf-8 -*-
"""语义检索与图查询（两者共同构成代码知识库的两种访问方式）。"""
from fastapi import APIRouter, HTTPException, Query

from .. import services

router = APIRouter(prefix="/api/projects/{pid}", tags=["search"])


@router.get("/search")
def search(pid: int, q: str = Query("", min_length=0), mode: str = "bm25", k: int = 10):
    mode = mode if mode in ("bm25", "keyword") else "bm25"
    return services.search(pid, q, mode=mode, k=max(1, min(k, 50)))


@router.get("/graph")
def graph(pid: int, op: str = "callers", class_id: str = Query("", alias="class"),
          frm: str = Query("", alias="from"), to: str = ""):
    try:
        return services.graph(pid, op, class_id=class_id, src=frm, dst=to)
    except services.NotFound as error:
        raise HTTPException(status_code=404, detail=str(error))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))
