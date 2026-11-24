# -*- coding: utf-8 -*-
"""工程接入：目录接入、zip 上传、分析触发与状态查询。"""
import os
import shutil
import zipfile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .. import db, services
from ..core import pipeline, repo, retrieve

router = APIRouter(prefix="/api/projects", tags=["projects"])

BASE_DIR = db.BASE_DIR
UPLOAD_DIR = os.path.join(BASE_DIR, "data", "uploads")
REPO_DIR = os.path.join(BASE_DIR, "data", "repos")


class ProjectIn(BaseModel):
    name: str = ""
    root: str = ""
    git_url: str = ""
    engine: str = "self"  # self=自研解析器，joern=Joern CPG


@router.get("")
def list_projects():
    return {"projects": services.projects()}


@router.post("")
def create_project(payload: ProjectIn):
    """三种接入方式：本地目录（root）、Git 仓库（git_url）、zip 上传（单独接口）。"""
    if payload.git_url.strip():
        return _create_from_git(payload.name.strip(), payload.git_url.strip(), payload.engine)
    root = os.path.abspath(os.path.expanduser(payload.root.strip()))
    if not root or not os.path.isdir(root):
        raise HTTPException(status_code=400, detail="目录不存在：%s" % root)
    pid = db.create_project(payload.name.strip() or os.path.basename(root), root,
                        payload.engine)
    db.set_status(pid, status="new", step="", error="")
    return services.status(pid)


def _create_from_git(name, url, engine="self"):
    slug = url.rstrip("/").split("/")[-1].replace(".git", "") or "repo"
    target = os.path.join(REPO_DIR, slug)
    try:
        path, action = repo.clone(url, target)
    except RuntimeError as error:
        raise HTTPException(status_code=400, detail=str(error))
    pid = db.create_project(name or slug, path, engine)
    db.set_status(pid, status="new", step="", error="")
    result = services.status(pid)
    result["git"] = {"action": action, "path": path}
    return result


@router.post("/upload")
async def upload_project(file: UploadFile = File(...), name: str = Form(""),
                       engine: str = Form("self")):
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="只支持 zip 文件")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    target = os.path.join(UPLOAD_DIR, os.path.basename(file.filename))
    with open(target, "wb") as handle:
        shutil.copyfileobj(file.file, handle)
    folder = os.path.join(UPLOAD_DIR, os.path.splitext(os.path.basename(target))[0])
    if os.path.isdir(folder):
        shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(folder, exist_ok=True)
    try:
        with zipfile.ZipFile(target) as archive:
            for member in archive.namelist():
                member = member.replace("\\", "/")
                if member.startswith("/") or ".." in member.split("/"):
                    continue
                archive.extract(member, folder)
    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="压缩包损坏")
    pid = db.create_project(name.strip() or os.path.splitext(os.path.basename(target))[0],
                            folder, engine)
    db.set_status(pid, status="new", step="", error="")
    return services.status(pid)


@router.get("/{pid}/status")
def project_status(pid: int):
    return services.status(pid)


@router.post("/{pid}/analyze")
def analyze(pid: int):
    services.status(pid)  # 工程不存在则 404
    retrieve.invalidate(pid)
    db.set_status(pid, status="running", step="扫描源码", error="")
    pipeline.run_async(pid)
    return services.status(pid)


@router.delete("/{pid}")
def delete_project(pid: int):
    services.status(pid)
    for table in ("calls", "methods", "classes", "modules", "functions", "components",
                  "documents", "metrics", "files", "projects"):
        db.execute("DELETE FROM %s WHERE id=?" % table if table == "projects"
                   else "DELETE FROM %s WHERE project_id=?" % table, (pid,))
    retrieve.invalidate(pid)
    return {"deleted": pid}
