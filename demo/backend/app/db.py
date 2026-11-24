# -*- coding: utf-8 -*-
"""SQLite 存储层：建库、建表与常用查询封装。

所有表都以 project_id 挂在一个工程下，重新分析时按工程整体清空。
"""
import json
import os
import sqlite3
import time

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB_PATH = os.path.join(BASE_DIR, "data", "reverse.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    root         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    status       TEXT DEFAULT 'new',
    step         TEXT DEFAULT '',
    error        TEXT DEFAULT '',
    file_count   INTEGER DEFAULT 0,
    loc          INTEGER DEFAULT 0,
    class_count  INTEGER DEFAULT 0,
    method_count INTEGER DEFAULT 0,
    module_count INTEGER DEFAULT 0,
    modularity   REAL DEFAULT 0,
    nmi          REAL DEFAULT 0,
    build_tool   TEXT DEFAULT '',
    test_count   INTEGER DEFAULT 0,
    config_count INTEGER DEFAULT 0,
    languages    TEXT DEFAULT '{}',
    graph_nodes  INTEGER DEFAULT 0,
    graph_edges  INTEGER DEFAULT 0,
    engine       TEXT DEFAULT 'self'
);

CREATE TABLE IF NOT EXISTS files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    path       TEXT NOT NULL,
    package    TEXT DEFAULT '',
    loc        INTEGER DEFAULT 0,
    category   TEXT DEFAULT '源码',
    content    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS classes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    file_id    INTEGER,
    name       TEXT NOT NULL,
    package    TEXT DEFAULT '',
    kind       TEXT DEFAULT 'class',
    layer      TEXT DEFAULT '其他',
    module_id  INTEGER,
    start_line INTEGER DEFAULT 0,
    doc        TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS methods (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    class_id    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    signature   TEXT DEFAULT '',
    return_type TEXT DEFAULT '',
    params      TEXT DEFAULT '',
    line        INTEGER DEFAULT 0,
    loc         INTEGER DEFAULT 0,
    doc         TEXT DEFAULT '',
    is_public   INTEGER DEFAULT 1,
    branches    INTEGER DEFAULT 0,
    loops       INTEGER DEFAULT 0,
    catches     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fields (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    class_id   INTEGER NOT NULL,
    name       TEXT NOT NULL,
    type_name  TEXT DEFAULT '',
    modifiers  TEXT DEFAULT '',
    line       INTEGER DEFAULT 0,
    doc        TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS externals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name       TEXT NOT NULL,
    kind       TEXT DEFAULT '',
    count      INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    caller_id   INTEGER NOT NULL,
    callee_name TEXT NOT NULL,
    qualifier   TEXT DEFAULT '',
    callee_id   INTEGER,
    line        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS modules (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER NOT NULL,
    name         TEXT NOT NULL,
    evidence     TEXT DEFAULT '',
    size         INTEGER DEFAULT 0,
    cohesion     REAL DEFAULT 0,
    method_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS functions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    module_id  INTEGER,
    parent_id  INTEGER,
    name       TEXT NOT NULL,
    summary    TEXT DEFAULT '',
    evidence   TEXT DEFAULT '',
    level      INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS components (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    module_id  INTEGER,
    name       TEXT NOT NULL,
    layer      TEXT DEFAULT '其他',
    classes    TEXT DEFAULT '[]',
    provides   TEXT DEFAULT '[]',
    depends_on TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS documents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    content    TEXT DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    key        TEXT NOT NULL,
    label      TEXT NOT NULL,
    value      REAL DEFAULT 0,
    note       TEXT DEFAULT ''
);

-- 每次分析留一份指标快照，对比页用来显示「本次 vs 上次」
CREATE TABLE IF NOT EXISTS metrics_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    run_at     TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      REAL DEFAULT 0
);
"""


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init():
    with connect() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)


MIGRATIONS = {
    "projects": {"build_tool": "TEXT DEFAULT ''", "test_count": "INTEGER DEFAULT 0",
                 "config_count": "INTEGER DEFAULT 0", "languages": "TEXT DEFAULT '{}'",
                 "graph_nodes": "INTEGER DEFAULT 0", "graph_edges": "INTEGER DEFAULT 0",
                 "engine": "TEXT DEFAULT 'self'"},
    "files": {"category": "TEXT DEFAULT '源码'"},
    "methods": {"branches": "INTEGER DEFAULT 0", "loops": "INTEGER DEFAULT 0",
                "catches": "INTEGER DEFAULT 0"},
}


def _migrate(conn):
    """老库补齐新增列，避免升级后必须删库。"""
    for table, columns in MIGRATIONS.items():
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(%s)" % table)}
        for name, spec in columns.items():
            if name not in existing:
                conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, name, spec))
    conn.commit()


def now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def query(sql, args=()):
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, args).fetchall()]


def query_one(sql, args=()):
    rows = query(sql, args)
    return rows[0] if rows else None


def execute(sql, args=()):
    with connect() as conn:
        cur = conn.execute(sql, args)
        conn.commit()
        return cur.lastrowid


def execute_many(sql, rows):
    with connect() as conn:
        conn.executemany(sql, rows)
        conn.commit()


# ---------------------------------------------------------------- 项目级快捷操作
def create_project(name, root, engine='self'):
    """同名路径的项目直接复用，避免重复接入。"""
    old = query_one("SELECT * FROM projects WHERE root=?", (root,))
    if old:
        execute("UPDATE projects SET name=?, engine=?, status='new', step='', error='' "
                "WHERE id=?", (name, engine, old["id"]))
        return old["id"]
    return execute("INSERT INTO projects(name, root, created_at, engine) VALUES(?,?,?,?)",
                   (name, root, now(), engine))


def set_status(pid, status=None, step=None, error=None):
    sets, args = [], []
    for col, val in (("status", status), ("step", step), ("error", error)):
        if val is not None:
            sets.append("%s=?" % col)
            args.append(val)
    if not sets:
        return
    args.append(pid)
    execute("UPDATE projects SET %s WHERE id=?" % ", ".join(sets), args)


def project(pid):
    return query_one("SELECT * FROM projects WHERE id=?", (pid,))


def list_projects():
    return query("SELECT * FROM projects ORDER BY id DESC")


def clear_project(pid):
    """重新分析前清空分析结果，工程本身保留。"""
    for table in ("calls", "fields", "externals", "methods", "classes", "modules", "functions", "components",
                  "documents", "metrics", "files"):
        execute("DELETE FROM %s WHERE project_id=?" % table, (pid,))


def add_file(pid, path, content, package="", loc=0, category="源码"):
    return execute(
        "INSERT INTO files(project_id, path, package, loc, category, content) "
        "VALUES(?,?,?,?,?,?)",
        (pid, path, package, loc, category, content))


def dump_json(value):
    return json.dumps(value, ensure_ascii=False)


def load_json(text):
    if not text:
        return []
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return []
