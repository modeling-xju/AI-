# -*- coding: utf-8 -*-
"""FastAPI 应用入口：挂 API 与前端静态资源。"""
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db, services
from .core import knowledge
from .routers import analysis, docs_api, projects, search

FRONTEND_DIR = os.path.join(db.BASE_DIR, "frontend")


def create_app():
    db.init()
    app = FastAPI(title="AI 赋能的软件逆向工程系统", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                       allow_headers=["*"])

    app.include_router(projects.router)
    app.include_router(analysis.router)
    app.include_router(search.router)
    app.include_router(docs_api.router)

    @app.get("/api/health")
    def health():
        return {"ok": True, "llm": knowledge.status_text()}

    @app.get("/api/fs/list")
    def list_fs(path: str = ""):
        """本地目录浏览：给「接入本地目录」当选择器用，只读。"""
        target = os.path.abspath(os.path.expanduser(path.strip() or os.path.expanduser("~")))
        if not os.path.isdir(target):
            raise HTTPException(status_code=400, detail="目录不存在：%s" % target)
        entries = []
        try:
            for entry in sorted(os.scandir(target), key=lambda e: (not e.is_dir(), e.name.lower())):
                if entry.name.startswith("."):
                    continue
                entries.append({"name": entry.name, "path": entry.path, "is_dir": entry.is_dir()})
        except PermissionError:
            raise HTTPException(status_code=403, detail="没有权限读取该目录")
        parent = os.path.dirname(target)
        return {"path": target, "parent": parent if parent != target else "", "entries": entries[:500]}

    @app.exception_handler(services.NotFound)
    async def not_found(_request: Request, error: services.NotFound):
        return JSONResponse(status_code=404, content={"detail": str(error)})

    if os.path.isdir(FRONTEND_DIR):
        app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIR, "assets")),
                  name="assets")

        @app.middleware("http")
        async def no_cache_frontend(request: Request, call_next):
            """前端还在改，静态资源别让浏览器吃缓存；改完刷新即可生效。"""
            response = await call_next(request)
            if request.url.path.startswith("/assets/") or request.url.path == "/":
                response.headers["Cache-Control"] = "no-store, must-revalidate"
            return response

        @app.get("/")
        def index():
            return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

    return app


app = create_app()
