# -*- coding: utf-8 -*-
"""启动脚本：python run.py [端口]，默认 http://127.0.0.1:8100 。"""
import os
import sys

import uvicorn

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

if __name__ == "__main__":
    default = int(os.environ.get("PORT", "8100"))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else default
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, reload=False, log_level="warning")
