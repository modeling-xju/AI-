# -*- coding: utf-8 -*-
"""分析结果查询：总览、结构、功能、架构、评测、变更影响。"""
from fastapi import APIRouter

from .. import services

router = APIRouter(prefix="/api/projects/{pid}", tags=["analysis"])


@router.get("/overview")
def overview(pid: int):
    return services.overview(pid)


@router.get("/structure")
def structure(pid: int):
    return services.structure(pid)


@router.get("/functions")
def functions(pid: int):
    return services.functions(pid)


@router.get("/architecture")
def architecture(pid: int):
    return services.architecture(pid)


@router.get("/compare")
def compare(pid: int):
    return services.compare(pid)


@router.get("/impact/{class_id}")
def impact(pid: int, class_id: int, method: str = ""):
    return services.impact(pid, class_id, method or None)
