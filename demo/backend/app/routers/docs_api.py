# -*- coding: utf-8 -*-
"""文档生成、读取与导出。"""
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Response

from .. import services

router = APIRouter(prefix="/api/projects/{pid}/documents", tags=["documents"])


@router.get("")
def list_documents(pid: int):
    return services.documents(pid)


@router.post("/{kind}")
def create_document(pid: int, kind: str):
    try:
        return services.create_document(pid, kind)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@router.get("/{doc_id}")
def get_document(pid: int, doc_id: int):
    try:
        return services.document(pid, doc_id)
    except services.NotFound as error:
        raise HTTPException(status_code=404, detail=str(error))


@router.get("/{doc_id}/export")
def export_document(pid: int, doc_id: int):
    """导出 Markdown：交给 Word / Typora 继续排版，或直接贴进论文附录。"""
    try:
        filename, content = services.export_document(pid, doc_id)
    except services.NotFound as error:
        raise HTTPException(status_code=404, detail=str(error))
    headers = {
        "Content-Disposition": "attachment; filename*=UTF-8''%s" % quote(filename),
        "X-Filename": quote(filename),
    }
    return Response(content=content, media_type="text/markdown; charset=utf-8",
                    headers=headers)
