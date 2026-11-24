# -*- coding: utf-8 -*-
"""拉取 demo 用的大示例工程（SpringBlade）。

GitHub 直连在本机不可达，默认走 Gitee 的同名镜像仓库；如果网络允许，
也可以自己改 SOURCES 里的地址。用法：

    python demo/scripts/fetch_springblade.py

克隆结果落在 demo/samples/springblade（已在 .gitignore 里，不入库）。
"""
import os
import subprocess
import sys

SOURCES = [
    ("https://gitee.com/smallc/SpringBlade.git", "Gitee 镜像"),
    ("https://github.com/chillzhuang/SpringBlade.git", "GitHub 上游"),
]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "samples", "springblade")


def main():
    if os.path.isdir(os.path.join(TARGET, ".git")):
        print("已存在：%s（如需更新请手动 git pull）" % TARGET)
        return 0
    for url, label in SOURCES:
        print("尝试 %s（%s）…" % (url, label))
        code = subprocess.call(["git", "clone", "--depth", "1", url, TARGET])
        if code == 0:
            print("完成：%s" % TARGET)
            return 0
        print("失败：%s" % url)
    print("两个源都失败，请检查网络或代理设置。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
