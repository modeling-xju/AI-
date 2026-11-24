# -*- coding: utf-8 -*-
"""分析流水线：源码 -> 结构事实 -> 模块与功能 -> 架构视图 -> 指标。

每一步都会写入 SQLite，前端通过 /status 轮询进度。
"""
import os
import re
import threading
import traceback

from .. import db
from . import codegraph, cpg, javaparse, joern, knowledge, repo, retrieve

IDENT_RE = re.compile(r"[A-Za-z_$][\w$]*")
DEP_WEIGHT = 0.4

LAYER_RANK = {"接入层": 0, "业务层": 1, "数据层": 2, "公共层": 3, "领域层": 4, "其他": 5}
GENERIC_LABELS = {"处理", "列出", "保存", "更新", "查询", "删除", "添加", "查看", "设置"}
# 工具类里的方法不算「功能条目」：简介要求过滤访问器与工具方法
TOOL_CLASS_RE = re.compile(r"(Util|Utils|Helper|Constant|Constants)$")
STEP_PERCENT = {
    "": 0, "扫描源码": 8, "解析结构": 26, "解析调用": 42, "社区发现": 58,
    "归纳功能": 70, "恢复架构": 82, "计算指标": 92, "导出代码属性图": 97, "完成": 100,
}


def _store_files(pid, java_files):
    rows = []
    for entry in java_files:
        package = ""
        match = javaparse.PACKAGE_RE.search(entry["content"])
        if match:
            package = match.group(1)
        rows.append((pid, entry["rel"], package, entry["loc"], entry["category"],
                     entry["content"]))
    db.execute_many("INSERT INTO files(project_id, path, package, loc, category, content) "
                    "VALUES(?,?,?,?,?,?)", rows)


def _store_structure(pid):
    files = db.query("SELECT id, path, content FROM files WHERE project_id=?", (pid,))
    class_rows, method_rows = [], []
    for row in files:
        tree = javaparse.parse_source(row["content"])
        for cls in tree["classes"]:
            layer = codegraph.guess_layer(cls["name"], tree["package"])
            class_rows.append((pid, row["id"], cls["name"], tree["package"], cls["kind"],
                               layer, cls["line"], cls["doc"]))
            for method in cls["methods"]:
                method_rows.append((pid, cls["name"], method))

    db.execute_many("INSERT INTO classes(project_id, file_id, name, package, kind, layer, "
                    "start_line, doc) VALUES(?,?,?,?,?,?,?,?)", class_rows)

    class_ids = db.query("SELECT id, name FROM classes WHERE project_id=?", (pid,))
    by_name = {row["name"]: row["id"] for row in class_ids}
    rows = []
    for item in method_rows:
        _, cls_name, method = item
        rows.append((pid, by_name.get(cls_name), method["name"], method["signature"],
                     method["return_type"], method["params"], method["line"], method["loc"],
                     method["doc"], 1 if method.get("is_public") else 0,
                     method.get("branches", 0), method.get("loops", 0),
                     method.get("catches", 0)))
    db.execute_many("INSERT INTO methods(project_id, class_id, name, signature, return_type, "
                    "params, line, loc, doc, is_public, branches, loops, catches) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)

    # 调用边：caller_id 记调用方所属的类，callee 稍后统一解析成类
    methods = db.query("SELECT id, class_id, name FROM methods WHERE project_id=?", (pid,))
    method_ids = {(row["class_id"], row["name"]): row["id"] for row in methods}
    call_rows = []
    for item in method_rows:
        _, cls_name, method = item
        caller_id = by_name.get(cls_name)
        if not caller_id:
            continue
        for call in method["calls"]:
            call_rows.append((pid, caller_id, call["name"], call["qualifier"], call["line"]))
    db.execute_many("INSERT INTO calls(project_id, caller_id, callee_name, qualifier, line) "
                    "VALUES(?,?,?,?,?)", call_rows)
    _resolve_calls(pid)
    # 解析不到、但能看出是基础设施的调用，记为外部依赖
    external_rows = []
    kind_updates = []
    for row in db.query("SELECT id, callee_name, qualifier FROM calls WHERE project_id=? "
                        "AND callee_id IS NULL", (pid,)):
        token = row["qualifier"] or row["callee_name"]
        kind = _external_kind(token)
        if kind != "第三方库":
            external_rows.append((token, kind))
            kind_updates.append((kind, row["id"]))
    db.execute_many("UPDATE calls SET external_kind=? WHERE id=?", kind_updates)
    _store_externals(pid, external_rows)
    return len(class_rows), len(rows), len(call_rows)


def _resolve_calls(pid):
    classes = db.query("SELECT id, name FROM classes WHERE project_id=?", (pid,))
    by_lower = {row["name"].lower(): row["id"] for row in classes}
    methods = db.query("SELECT id, class_id, name FROM methods WHERE project_id=?", (pid,))
    by_method = {}
    for row in methods:
        by_method.setdefault(row["name"], []).append(row["class_id"])

    calls = db.query("SELECT id, caller_id, callee_name, qualifier FROM calls "
                     "WHERE project_id=?", (pid,))
    updates = []
    for row in calls:
        qualifier = (row["qualifier"] or "").lower()
        callee_class = by_lower.get(qualifier)
        if callee_class is None:
            owners = by_method.get(row["callee_name"]) or []
            if len(set(owners)) == 1:
                callee_class = owners[0]
        if callee_class is not None:
            updates.append((callee_class, row["id"]))
    db.execute_many("UPDATE calls SET callee_id=? WHERE id=?", updates)


def _merge_by_domain(labels, classes, limit=140):
    """把主导名词相同的社区并成一个模块。

    Louvain 只看调用关系，管理后台这类工程里 mapper / VO / wrapper 常常各自成团，
    分出来的「角色菜单管理」「菜单角色管理」「用户授权管理」其实是一件事。
    这里按类名剥掉分层后缀后的名词做一次归并，对应简介里「归并相近功能意图」。
    """
    by_id = {cls["id"]: cls for cls in classes}
    groups = {}
    for cls_id, label in labels.items():
        cls = by_id.get(cls_id)
        if cls:
            groups.setdefault(label, []).append(cls)

    dominant = {}
    for label, members in groups.items():
        counts = {}
        for member in members:
            noun = knowledge._class_noun(member["name"])
            if noun:
                counts[noun] = counts.get(noun, 0) + 1
        dominant[label] = max(counts, key=counts.get) if counts else ""

    buckets = {}
    for label, noun in dominant.items():
        if noun:
            buckets.setdefault(noun, []).append(label)

    merged = dict(labels)
    for noun, labels_ in buckets.items():
        if len(labels_) < 2:
            continue
        total = sum(len(groups[label]) for label in labels_)
        if total > limit:
            continue
        target = max(labels_, key=lambda label: len(groups[label]))
        for label in labels_:
            if label == target:
                continue
            for cls_id, current in merged.items():
                if current == label:
                    merged[cls_id] = target
    return merged


def _class_index(classes):
    """类名 -> 类行列表；同名类可能分布在多个包，解析时优先同包。"""
    index = {}
    for row in classes:
        index.setdefault(row["name"], []).append(row)
    return index


def _resolve_type(name, package, index):
    candidates = index.get(name) or []
    if not candidates:
        return None
    for row in candidates:
        if row["package"] == package:
            return row["id"]
    return candidates[0]["id"]


def _signature_type_pairs(pid, classes):
    """方法签名里的参数与返回值类型，反映 Service -> DAO、Controller -> DTO 这类依赖。"""
    index = _class_index(classes)
    package_of = {row["id"]: row["package"] for row in classes}
    rows = db.query("SELECT class_id, return_type, params FROM methods WHERE project_id=?", (pid,))
    pairs = set()
    for row in rows:
        owner = row["class_id"]
        package = package_of.get(owner, "")
        for raw in ((row["return_type"] or "") + " " + (row["params"] or "")).split():
            for name in IDENT_RE.findall(raw):
                target = _resolve_type(name, package, index)
                if target and target != owner:
                    pairs.add(tuple(sorted((owner, target))))
    return pairs


def _source_type_pairs(scan, classes):
    """继承、实现与字段类型：包、类依赖图里最稳定的那部分。"""
    index = _class_index(classes)
    by_key = {(row["package"], row["name"]): row for row in classes}
    pairs = set()
    for entry in scan["java_files"]:
        tree = javaparse.parse_source(entry["content"])
        package = tree.get("package") or ""
        for cls in tree["classes"]:
            owner = by_key.get((package, cls["name"]))
            if not owner:
                continue
            raws = list(cls.get("extends") or []) + list(cls.get("implements") or [])
            raws += [field.get("type") or "" for field in (cls.get("fields") or [])]
            for raw in raws:
                for name in IDENT_RE.findall(raw):
                    target = _resolve_type(name, package, index)
                    if target and target != owner["id"]:
                        pairs.add(tuple(sorted((owner["id"], target))))
    return pairs


def _build_graph(pid, scan=None):
    classes = db.query("SELECT id, name, package, layer FROM classes WHERE project_id=?", (pid,))
    ids = {row["id"] for row in classes}
    pairs = db.query("SELECT caller_id, callee_id FROM calls WHERE project_id=? "
                     "AND callee_id IS NOT NULL", (pid,))
    adjacency = codegraph.build_class_graph(ids, [(r["caller_id"], r["callee_id"])
                                                  for r in pairs])
    # 简介要求「在调用图与包、类依赖图上聚类」：把类型依赖以较低权重并入同一张图
    type_pairs = _signature_type_pairs(pid, classes)
    if scan:
        type_pairs |= _source_type_pairs(scan, classes)
    dep_edges = codegraph.add_type_edges(adjacency, ids, type_pairs, weight=DEP_WEIGHT)
    labels, _ = codegraph.louvain(adjacency)
    if len(classes) <= 60:
        labels = codegraph.merge_small(adjacency, labels, min_size=2, rounds=4)
        labels = codegraph.attach_isolated(adjacency, labels, classes)
    else:
        labels = codegraph.consolidate(adjacency, labels, classes)
        labels = codegraph.split_large(labels, classes, limit=max(30, round(len(classes) / 8)))
        labels = _merge_by_domain(labels, classes)
    quality = codegraph.modularity(adjacency, labels)
    package_labels = codegraph.class_package_labels(classes)
    return adjacency, labels, quality, package_labels, classes, dep_edges


GENERIC_MODULE_NAMES = {"功能模块", "模块", "其他", "未命名"}
# 包名末段 → 更具体的模块名；查不到再用分层兜底
PACKAGE_NOUNS = {
    "mapper": "数据访问", "dao": "数据访问", "repository": "数据访问", "jdbc": "数据访问",
    "entity": "数据模型", "model": "数据模型", "pojo": "数据模型", "dto": "数据模型",
    "vo": "数据模型", "param": "参数模型", "params": "参数模型",
    "util": "工具方法", "utils": "工具方法", "tool": "工具方法", "helper": "工具方法",
    "config": "配置装配", "properties": "配置装配", "launcher": "启动装配",
    "feign": "远程调用", "client": "远程调用", "provider": "远程调用",
    "cache": "缓存", "redis": "缓存",
    "handler": "请求处理", "filter": "请求处理", "interceptor": "请求处理", "advice": "请求处理",
    "controller": "接口", "web": "接口", "endpoint": "接口", "resource": "接口",
    "service": "业务逻辑", "impl": "业务逻辑", "biz": "业务逻辑",
    "exception": "异常处理", "wrapper": "视图装配", "support": "支撑组件",
}
LAYER_MODULE_NAMES = {"接入层": "接口模块", "业务层": "业务模块", "数据层": "数据模块",
                      "领域层": "领域模块", "公共层": "公共模块", "其他": "杂项模块"}


def _package_domain(members):
    """包名里的业务域：跳过 org/公司名后取第一个有意义的段（develop / seata.storage / common）。"""
    votes = {}
    for member in members:
        parts = [part for part in (member.get("package") or "").split(".") if part]
        if len(parts) >= 3:
            domain = parts[2]
            if domain not in ("core", "common"):
                votes[domain] = votes.get(domain, 0) + 1
    if votes:
        return max(votes.items(), key=lambda kv: kv[1])[0]
    return ""


def _package_module_name(members):
    """从成员的包名末段里挑一个最常见的语义词，给泛称模块换一个具体的名字。"""
    votes = {}
    for member in members:
        parts = [part for part in (member.get("package") or "").split(".") if part]
        for part in reversed(parts[-3:]):
            noun = PACKAGE_NOUNS.get(part.lower())
            if noun:
                votes[noun] = votes.get(noun, 0) + 1
                break
    base = ""
    if votes:
        base = max(votes.items(), key=lambda kv: kv[1])[0]
    else:
        layers = [member.get("layer") for member in members if member.get("layer")]
        if layers:
            layer = max(set(layers), key=layers.count)
            base = LAYER_MODULE_NAMES.get(layer, "")
    # 只有分类词（业务逻辑、数据访问…）时前面补业务域，"业务逻辑" 与 "业务逻辑（service）"
    # 这种看着像重名的模块就能区分开
    domain = _package_domain(members)
    if base and domain and domain.lower() not in base.lower():
        return "%s·%s" % (domain, base)
    return base


def _store_modules(pid, adjacency, labels, classes):
    db.execute("DELETE FROM modules WHERE project_id=?", (pid,))
    by_id = {cls["id"]: cls for cls in classes}
    methods = db.query("SELECT class_id, name FROM methods WHERE project_id=?", (pid,))
    method_count, method_names = {}, {}
    for row in methods:
        cls = by_id.get(row["class_id"])
        if not cls:
            continue
        community = labels.get(cls["id"])
        method_count[community] = method_count.get(community, 0) + 1
        method_names.setdefault(community, []).append(row["name"])

    entries = []
    for community in sorted(set(labels.values())):
        members = [by_id[node] for node, label in labels.items() if label == community]
        layers, seen = [], set()
        for member in members:
            if member["layer"] not in seen:
                seen.add(member["layer"])
                layers.append(member["layer"])
        entries.append({
            "id": community,
            "class_names": [member["name"] for member in members],
            "method_names": method_names.get(community, []),
            "layers": layers,
        })

    named = knowledge.name_modules(entries)
    used_names = {}
    for community in sorted(set(labels.values())):
        members = [by_id[node] for node, label in labels.items() if label == community]
        name, evidence = named.get(community, ("功能模块", ""))
        # 「功能模块」这类泛称信息量为零：优先按包名后缀换成更具体的词，再退化到分层
        if name in GENERIC_MODULE_NAMES:
            name = _package_module_name(members) or name
        # 大工程里不同社区常被命名成同一个词，用包名片段区分，避免「用户管理 ×3」
        if name in used_names:
            packages = [m.get("package") or "" for m in members]
            package = max(set(packages), key=packages.count) if packages else ""
            parts = [part for part in package.split(".") if part]
            hint = parts[-1] if parts else ""
            if hint and hint not in name:
                name = f"{name}（{hint}）"
            used_names[name] = used_names.get(name, 0) + 1
            if used_names[name] > 1:
                name = f"{name}{used_names[name]}"
        else:
            used_names[name] = 1
        cohesion = codegraph.cohesion(adjacency, labels, community)
        module_id = db.execute(
            "INSERT INTO modules(project_id, name, evidence, size, cohesion, method_count) "
            "VALUES(?,?,?,?,?,?)",
            (pid, name, evidence, len(members), round(cohesion, 3),
             method_count.get(community, 0)))
        for member in members:
            db.execute("UPDATE classes SET module_id=? WHERE id=?", (module_id, member["id"]))
    return len(set(labels.values()))


def _is_accessor(method):
    if method["name"] in ("toString", "equals", "hashCode", "main"):
        return True
    params = [p for p in (method["params"] or "").split(",") if p.strip()]
    lowered = method["name"].lower()
    if not params and lowered.startswith(("get", "set", "is")) and len(lowered) > 3:
        return True
    if len(params) == 1 and lowered.startswith("set") and len(lowered) > 3:
        return True  # 单参 setter 也算访问器，不进功能树
    return False


def _store_functions(pid):
    db.execute("DELETE FROM functions WHERE project_id=?", (pid,))
    modules = db.query("SELECT id, name, evidence FROM modules WHERE project_id=? ORDER BY id",
                       (pid,))
    ranked = []
    for module in modules:
        methods = db.query(
            "SELECT m.id, m.name, m.return_type, m.params, m.is_public, m.doc, m.line, "
            "c.name AS class_name, c.layer, c.package AS package "
            "FROM methods m JOIN classes c ON c.id=m.class_id "
            "WHERE m.project_id=? AND c.module_id=?", (pid, module["id"]))
        candidates = [m for m in methods
                      if m["is_public"] and not _is_accessor(m)
                      and not (m["name"] or "").startswith("<")
                      and not TOOL_CLASS_RE.search(m["class_name"])]
        candidates.sort(key=lambda m: (LAYER_RANK.get(m["layer"], 9), len(m["name"]), m["id"]))
        for method in candidates[:8]:
            ranked.append({"module": module, "method": method})

    entries, rows = [], []
    for item in ranked:
        method = item["method"]
        label = knowledge.guess_function_name(method["name"], method["class_name"])
        if label in GENERIC_LABELS:
            # 类名与方法名都给不出名词时只剩一个「处理」，这种条目没法核对，直接舍弃；
            # 小工程保留，大工程里它们会把功能页和组件对齐表淹掉。
            if len(modules) > 6 or len(ranked) > 60:
                continue
        entry = "%s.%s" % (method["class_name"], method["name"])
        entries.append({"id": method["id"], "label": label, "entry": entry,
                        "return_type": method["return_type"], "module_id": module["id"],
                        "line": method["line"], "package": method["package"] or "",
                        "layer": method["layer"] or ""})
        rows.append(item)

    summaries = knowledge.summarize_functions(entries)

    # 同一件事在接入层、业务层、实现类里各出现一次（创建订单 → Controller / Service / Impl），
    # 对「功能」来说是一个能力，只保留最靠近入口的那条，其余视为实现细节。
    by_label = {}
    for entry in entries:
        by_label.setdefault((entry["module_id"], entry["label"]), []).append(entry)
    drop = set()
    for group in by_label.values():
        classes = {entry["entry"].split(".")[0] for entry in group}
        layers = {entry.get("layer") or "" for entry in group}
        # 只有「跨层同名」才算同一件事的不同实现；同层的多个类（各类 TokenGranter）
        # 是并列能力，不能合并
        if len(group) > 1 and len(classes) > 1 and len(layers) > 1:
            keep = min(group, key=lambda e: (LAYER_RANK.get(e.get("layer"), 9), e["line"]))
            for entry in group:
                if entry is not keep:
                    drop.add(id(entry))
    if drop:
        # entries 与 rows 一一对应，删条目时必须同步删行，否则后面按索引写库会错位
        kept = [(entry, row) for entry, row in zip(entries, rows) if id(entry) not in drop]
        entries = [entry for entry, _ in kept]
        rows = [row for _, row in kept]

    # 同一模块里重名时补类名；同一个类的重载仍重名时补行号。
    # 两轮都以「原始标签」为基准，避免出现「xxx（A）（第 3 行）」这种叠加。
    origin = {id(entry): entry["label"] for entry in entries}

    def dup_groups():
        groups = {}
        for entry in entries:
            groups.setdefault((entry["module_id"], entry["label"]), []).append(entry)
        return [g for g in groups.values() if len(g) > 1]

    SKIP_SEGMENTS = {"com", "org", "cn", "io", "net", "java", "main", "controller", "impl",
                     "service", "mapper", "dao", "web", "api", "rest", "provider"}

    def pkg_hint(pkg):
        """挑一个能区分同名类的包名片段（demo / desk / seata…）。"""
        parts = [part for part in (pkg or "").split(".") if part]
        for part in reversed(parts):
            if part.lower() not in SKIP_SEGMENTS:
                return part
        return parts[-1] if parts else ""

    def short_pkg(pkg):
        """包名末两段，用来区分不同包里同名的类（desk.controller / demo.controller）。"""
        parts = [part for part in (pkg or "").split(".") if part]
        return ".".join(parts[-2:]) if len(parts) >= 2 else (parts[-1] if parts else "")

    for group in dup_groups():
        classes = {entry["entry"].split(".")[0] for entry in group}
        hints = {pkg_hint(entry.get("package")) for entry in group}
        for entry in group:
            cls = entry["entry"].split(".")[0]
            # 同名类分布在不同的包里（SpringBlade 里 NoticeController 就有两份）：
            # 用包名里的业务域区分，比只差一个行号更容易看懂
            if len(classes) == 1 and len(hints) > 1:
                entry["label"] = "%s（%s.%s）" % (origin[id(entry)], pkg_hint(entry.get("package")), cls)
            else:
                entry["label"] = "%s（%s）" % (origin[id(entry)], cls)
    for group in dup_groups():
        # 同一个类里有多个方法被命名成同一个中文短语时，用方法名区分，
        # 比只给行号更说明「这是另一个方法」而不是重复。
        for entry in group:
            entry["label"] = "%s（%s）" % (origin[id(entry)], entry["entry"])

    leaves = 0
    for module in modules:
        parent_id = db.execute(
            "INSERT INTO functions(project_id, module_id, parent_id, name, summary, "
            "evidence, level) VALUES(?,?,?,?,?,?,?)",
            (pid, module["id"], None, module["name"], module["evidence"] or "", "", 1))
        for item, entry in zip(rows, entries):
            method = item["method"]
            if item["module"]["id"] != module["id"]:
                continue
            db.execute("INSERT INTO functions(project_id, module_id, parent_id, name, summary, "
                       "evidence, level) VALUES(?,?,?,?,?,?,?)",
                       (pid, module["id"], parent_id, entry["label"],
                        summaries.get(method["id"], ""), entry["entry"], 2))
            leaves += 1
    return leaves


def _store_components(pid):
    """组件 = 模块 × 层的分组，依赖取自类级调用图。"""
    db.execute("DELETE FROM components WHERE project_id=?", (pid,))
    modules = db.query("SELECT id, name FROM modules WHERE project_id=? ORDER BY id", (pid,))
    module_name = {row["id"]: row["name"] for row in modules}
    classes = db.query("SELECT id, name, layer, module_id FROM classes WHERE project_id=?", (pid,))
    calls = db.query("SELECT caller_id, callee_id FROM calls WHERE project_id=? "
                     "AND callee_id IS NOT NULL", (pid,))
    class_group = {(row["module_id"], row["layer"]): None for row in classes}
    group_size = {}
    for row in classes:
        group_size[(row["module_id"], row["layer"])] = \
            group_size.get((row["module_id"], row["layer"]), 0) + 1
    module_size = {}
    for row in classes:
        module_size[row["module_id"]] = module_size.get(row["module_id"], 0) + 1

    class_group = {row["id"]: (row["module_id"], row["layer"]) for row in classes}
    labels = {}
    for key in sorted(group_size, key=lambda item: (item[0] or 0, item[1])):
        module_id, layer = key
        base = module_name.get(module_id, "未命名模块")
        if group_size[key] == module_size.get(module_id, group_size[key]):
            labels[key] = base
        else:
            labels[key] = "%s·%s" % (base, layer.replace("层", "")[:2])

    dependencies = {}
    for row in calls:
        src = class_group.get(row["caller_id"])
        dst = class_group.get(row["callee_id"])
        if src and dst and src != dst:
            dependencies.setdefault(src, set()).add(labels[dst])

    for key in sorted(group_size, key=lambda item: (item[0] or 0, item[1])):
        module_id, layer = key
        members = sorted(row["name"] for row in classes
                         if (row["module_id"], row["layer"]) == key)
        db.execute(
            "INSERT INTO components(project_id, module_id, name, layer, classes, provides, "
            "depends_on) VALUES(?,?,?,?,?,?,?)",
            (pid, module_id, labels[key], layer, db.dump_json(members),
             db.dump_json(members), db.dump_json(sorted(dependencies.get(key, set()))[:12])))


def _store_metrics(pid, adjacency, labels, quality, package_labels, classes, scan, method_total, dep_edges):
    db.execute("DELETE FROM metrics WHERE project_id=?", (pid,))
    modules = db.query("SELECT id, cohesion FROM modules WHERE project_id=?", (pid,))
    package_q = codegraph.modularity(adjacency, package_labels)
    nmi_value = codegraph.nmi(labels, package_labels)
    average_cohesion = sum(m["cohesion"] for m in modules) / float(len(modules) or 1)
    evaluation = retrieve.evaluate(pid)

    metrics = [
        ("classes", "类/接口数", len(classes), "来自源码中的 class/interface 声明"),
        ("methods", "方法数", method_total, "含私有方法与访问器"),
        ("files", "源文件数", len(scan["java_files"]), "接入时筛出的 Java 文件"),
        ("modules", "社区数", len(modules), "Louvain 在调用图上的划分结果"),
        ("calls", "调用点数", db.query_one("SELECT COUNT(*) AS n FROM calls WHERE project_id=?",
                                           (pid,))["n"], "解析后能落到具体类的调用"),
        ("dep_edges", "类依赖边", dep_edges, "继承、实现、字段与签名类型构成的依赖边"),
        ("modularity", "模块度 Q", round(quality, 3), "调用图社区划分的模块度"),
        ("package_modularity", "包结构模块度", round(package_q, 3), "按 package 划分的基线"),
        ("nmi", "NMI", round(nmi_value, 3), "与包结构划分的标准化互信息"),
        ("cohesion", "平均内聚度", round(average_cohesion, 3), "模块内部类之间的连接密度"),
        ("recall_bm25", "Recall@5（BM25）", evaluation["bm25"], "语义检索召回率"),
        ("recall_keyword", "Recall@5（关键词）", evaluation["keyword"], "关键词基线召回率"),
        ("recall_vector", "Recall@5（向量）", evaluation["vector"], "向量索引语义召回率"),
        ("recall_fusion", "Recall@5（融合）", evaluation["fusion"], "BM25 + 向量 + 邻居融合"),
    ]
    db.execute_many("INSERT INTO metrics(project_id, key, label, value, note) "
                    "VALUES(?,?,?,?,?)",
                    [(pid, key, label, value, note) for key, label, value, note in metrics])
    # 留一份快照，对比页显示「本次 vs 上次」
    run_at = db.now()
    db.execute_many("INSERT INTO metrics_history(project_id, run_at, key, value) VALUES(?,?,?,?)",
                    [(pid, run_at, key, value) for key, _, value, _ in metrics])
    categories = scan["categories"]
    db.execute("UPDATE projects SET file_count=?, loc=?, class_count=?, method_count=?, "
               "module_count=?, modularity=?, nmi=?, build_tool=?, test_count=?, "
               "config_count=?, languages=? WHERE id=?",
               (len(scan["java_files"]), scan["loc"], len(classes), method_total,
                len(modules), round(quality, 3), round(nmi_value, 3), scan["build_tool"],
                categories.get("测试", 0), categories.get("配置", 0),
                db.dump_json(scan["languages"]), pid))


def _store_graph(pid):
    """导出代码属性图，并把节点/边计数写进指标。"""
    try:
        stats = cpg.build(pid)
    except Exception as error:  # CPG 导出失败不影响主流程
        traceback.print_exc()
        db.set_status(pid, error="CPG 导出失败：%s" % error)
        return
    by_type = stats["by_type"]
    rows = [
        ("cpg_nodes", "属性图节点", stats["nodes"], "语句级节点与方法节点合计"),
        ("cpg_edges", "属性图边", stats["edges"], "AST/CALL/CFG/CDG/DDG/REF 六类"),
        ("cpg_ast", "AST 边", by_type.get("AST", 0), "方法到语句的包含关系"),
        ("cpg_call", "CALL 边", by_type.get("CALL", 0), "调用点指到被调用类"),
        ("cpg_cfg", "CFG 边", by_type.get("CFG", 0), "方法内语句的执行先后"),
        ("cpg_cdg", "CDG 边", by_type.get("CDG", 0), "分支对语句的控制依赖"),
        ("cpg_ddg", "DDG 边", by_type.get("DDG", 0), "变量定义到使用"),
        ("cpg_ref", "实体引用边", by_type.get("REF", 0), "继承/实现/字段/参数/返回值"),
    ]
    db.execute_many("INSERT INTO metrics(project_id, key, label, value, note) "
                    "VALUES(?,?,?,?,?)",
                    [(pid, key, label, value, note) for key, label, value, note in rows])
    db.execute("UPDATE projects SET graph_nodes=?, graph_edges=? WHERE id=?",
               (stats["nodes"], stats["edges"], pid))


def _class_full_name(method_full_name):
    """org.a.B.foo:ret 或 org.a.B.foo 都还原成 org.a.B。"""
    head = (method_full_name or "").split(":", 1)[0]
    return head.rsplit(".", 1)[0] if "." in head else head


def _method_docs(scan):
    """从源码里补出 javadoc、行数与结构摘要：Joern 只给结构，方法体得自己读文件。"""
    docs = {}
    for entry in scan["java_files"]:
        tree = javaparse.parse_source(entry["content"])
        package = tree.get("package") or ""
        for cls in tree["classes"]:
            for method in cls["methods"]:
                docs[(package, cls["name"], method["name"])] = (
                    method["doc"], method["loc"],
                    method.get("branches", 0), method.get("loops", 0), method.get("catches", 0),
                )
    return docs


def _store_joern(pid, data, docs=None):
    """把 Joern 抽出来的实体写进库：类 -> 方法 -> 调用。"""
    docs = docs or {}
    classes = [cls for cls in data["classes"]
               if not cls["external"] and not cls["name"].startswith(("<lambda>", "<meta>",
                                                                      "<global>", "<empty>"))]
    methods = [m for m in data["methods"] if not m["external"]]
    seen_files = {}
    for cls in classes:
        path = (cls["file"] or "").strip()
        if path and path not in seen_files:
            seen_files[path] = 1
    db.execute_many("INSERT INTO files(project_id, path, package, loc, category, content) "
                    "VALUES(?,?,?,?,?,?)",
                    [(pid, path, "", 0, "源码", "") for path in seen_files])
    file_ids = {row["path"]: row["id"]
                for row in db.query("SELECT id, path FROM files WHERE project_id=?", (pid,))}

    rows = []
    for cls in classes:
        package = cls["fullName"].rsplit(".", 1)[0] if "." in cls["fullName"] else ""
        layer = codegraph.guess_layer(cls["name"], package)
        rows.append((pid, file_ids.get(cls["file"]), cls["name"], package, "class",
                     layer, cls["line"], ""))
    db.execute_many("INSERT INTO classes(project_id, file_id, name, package, kind, layer, "
                    "start_line, doc) VALUES(?,?,?,?,?,?,?,?)", rows)

    by_name = {}
    for row in db.query("SELECT id, name, package FROM classes WHERE project_id=?", (pid,)):
        by_name[(row["package"], row["name"])] = row["id"]
    full_index = {}
    for cls in classes:
        package = cls["fullName"].rsplit(".", 1)[0] if "." in cls["fullName"] else ""
        full_index[cls["fullName"]] = by_name.get((package, cls["name"]))

    method_rows = []
    full_names = {cls["fullName"]: cls["name"] for cls in classes}
    for method in methods:
        class_full = _class_full_name(method["fullName"])
        owner = full_index.get(class_full)
        if not owner:
            continue
        signature = method["signature"] or ""
        return_type = signature.split("(", 1)[0] if "(" in signature else ""
        params = signature.split("(", 1)[1].rstrip(")") if "(" in signature else ""
        package = class_full.rsplit(".", 1)[0] if "." in class_full else ""
        doc, loc, branches, loops, catches = docs.get(
            (package, full_names.get(class_full, ""), method["name"]), ("", 0, 0, 0, 0))
        method_rows.append((pid, owner, method["name"], signature, return_type, params,
                            method["line"], loc, doc, 1, branches, loops, catches))
    db.execute_many("INSERT INTO methods(project_id, class_id, name, signature, return_type, "
                    "params, line, loc, doc, is_public, branches, loops, catches) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", method_rows)

    call_rows = []
    external_rows = []
    for call in data["calls"]:
        caller = full_index.get(_class_full_name(call["caller"]))
        if not caller:
            continue
        callee = full_index.get(_class_full_name(call["callee"]))
        kind = ""
        name = call["name"]
        if callee is None:
            raw = call.get("callee") or ""
            simple = _class_full_name(raw).rsplit(".", 1)[-1]
            if simple and not simple.startswith("<") and simple not in full_index:
                kind = _external_kind(raw)
                if kind != "第三方库":  # 只留能归类的基础设施调用，JDK 类型不算外部依赖
                    external_rows.append((simple, kind))
                    name = simple  # 外部调用记依赖名，而不是方法名
                else:
                    kind = ""
        call_rows.append((pid, caller, name, callee, call["line"], kind))
    db.execute_many("INSERT INTO calls(project_id, caller_id, callee_name, callee_id, line, external_kind) "
                    "VALUES(?,?,?,?,?,?)", call_rows)
    _store_externals(pid, external_rows)

    counts = data["counts"]
    edges = data["edges"]
    return len(rows), len(method_rows), len(call_rows)


# 外部依赖的分类规则与判定在 codegraph 里，这里只保留别名，避免两处维护
EXTERNAL_KINDS = codegraph.EXTERNAL_KINDS
_external_kind = codegraph.external_kind


def _store_externals(pid, rows):
    """rows: [(name, kind)]，按名字聚合计数后入库。"""
    if not rows:
        return
    counter = {}
    for name, kind in rows:
        key = (name, kind)
        counter[key] = counter.get(key, 0) + 1
    values = [(pid, name, kind, count) for (name, kind), count in
              sorted(counter.items(), key=lambda item: -item[1])[:40]]
    db.execute_many("INSERT INTO externals(project_id, name, kind, count) VALUES(?,?,?,?)", values)


def _store_fields(pid, scan):
    """字段作为实体入库：结构页要展示，类型依赖边也从这里来。"""
    by_key = {(row["package"], row["name"]): row["id"]
              for row in db.query("SELECT id, name, package FROM classes WHERE project_id=?", (pid,))}
    rows = []
    for entry in scan["java_files"]:
        tree = javaparse.parse_source(entry["content"])
        package = tree.get("package") or ""
        for cls in tree["classes"]:
            class_id = by_key.get((package, cls["name"]))
            if not class_id:
                continue
            for field in cls.get("fields") or []:
                modifiers = field.get("modifiers") or ""
                if isinstance(modifiers, (list, tuple)):
                    modifiers = " ".join(modifiers)
                rows.append((pid, class_id, field["name"], field.get("type", ""), modifiers,
                             field.get("line", 0), field.get("doc", "")))
    if rows:
        db.execute_many("INSERT INTO fields(project_id, class_id, name, type_name, modifiers, "
                        "line, doc) VALUES(?,?,?,?,?,?,?)", rows)
    return len(rows)


def _store_cpg_metrics(pid, data):
    """Joern 路径的属性图指标：_store_metrics 会清表，所以单独在它之后写一次。"""
    counts = data["counts"]
    edges = data["edges"]
    db.execute_many("INSERT INTO metrics(project_id, key, label, value, note) "
                    "VALUES(?,?,?,?,?)",
                    [(pid, key, label, value, note) for key, label, value, note in [
                        ("cpg_nodes", "属性图节点", counts["all"], "Joern CPG 节点总数"),
                        ("cpg_edges", "属性图边", sum(edges.values()), "AST/CALL/CFG/CDG/DDG/REF"),
                        ("cpg_ast", "AST 边", edges["ast"], "类型/方法到其子节点的包含关系"),
                        ("cpg_call", "CALL 边", edges["call"], "调用点指到被调用方法"),
                        ("cpg_cfg", "CFG 边", edges["cfg"], "方法内语句的执行先后"),
                        ("cpg_cdg", "CDG 边", edges["cdg"], "分支对语句的控制依赖"),
                        ("cpg_ddg", "DDG 边", edges["ddg"], "变量定义到使用（数据流引擎按需计算）"),
                        ("cpg_ref", "REF 边", edges["ref"], "标识符/调用/方法引用指向声明"),
                    ]])
    db.execute("UPDATE projects SET graph_nodes=?, graph_edges=? WHERE id=?",
               (counts["all"], sum(edges.values()), pid))


def _run_joern(pid, project_row, scan):
    db.clear_project(pid)
    retrieve.invalidate(pid)
    db.set_status(pid, step="解析结构")
    workdir = os.path.join(os.path.dirname(db.DB_PATH), "cpg", "joern")
    data = joern.analyze(project_row["root"], workdir)
    db.set_status(pid, step="解析调用")
    class_total, method_total, _ = _store_joern(pid, data, _method_docs(scan))
    _store_fields(pid, scan)

    db.set_status(pid, step="社区发现")
    adjacency, labels, quality, package_labels, classes, dep_edges = _build_graph(pid, scan)

    db.set_status(pid, step="归纳功能")
    _store_modules(pid, adjacency, labels, classes)
    _store_functions(pid)

    db.set_status(pid, step="恢复架构")
    _store_components(pid)

    db.set_status(pid, step="计算指标")
    _store_metrics(pid, adjacency, labels, quality, package_labels, classes, scan, method_total, dep_edges)
    _store_cpg_metrics(pid, data)  # _store_metrics 会先清空 metrics，属性图指标要在这之后写
    db.execute("UPDATE projects SET class_count=?, loc=?, build_tool=?, languages=? WHERE id=?",
               (class_total, scan["loc"], scan["build_tool"],
                db.dump_json(scan["languages"]), pid))


def run(pid):
    db.set_status(pid, status="running", step="扫描源码", error="")
    try:
        _run(pid)
        db.set_status(pid, status="analyzed", step="完成", error="")
    except Exception as error:  # 单次分析失败不应让服务挂掉
        db.set_status(pid, status="failed", error="%s: %s" % (type(error).__name__, error))
        traceback.print_exc()


def _run(pid):
    project_row = db.project(pid)
    if not project_row:
        raise RuntimeError("工程不存在")
    scan = repo.scan(project_row["root"])
    if not scan["java_files"]:
        raise RuntimeError("目录里没有找到 .java 源文件")

    if (project_row["engine"] or "self") == "joern":
        if not joern.available():
            raise RuntimeError("Joern 不可用：找不到 joern-parse 或 JDK")
        _run_joern(pid, project_row, scan)
        return

    db.clear_project(pid)
    retrieve.invalidate(pid)
    _store_files(pid, scan["java_files"])
    db.execute("UPDATE projects SET loc=?, build_tool=?, languages=? WHERE id=?",
               (scan["loc"], scan["build_tool"], db.dump_json(scan["languages"]), pid))

    db.set_status(pid, step="解析结构")
    class_total, method_total, _ = _store_structure(pid)
    _store_fields(pid, scan)

    db.set_status(pid, step="社区发现")
    adjacency, labels, quality, package_labels, classes, dep_edges = _build_graph(pid, scan)

    db.set_status(pid, step="归纳功能")
    _store_modules(pid, adjacency, labels, classes)
    _store_functions(pid)

    db.set_status(pid, step="恢复架构")
    _store_components(pid)

    db.set_status(pid, step="计算指标")
    _store_metrics(pid, adjacency, labels, quality, package_labels, classes, scan, method_total, dep_edges)
    db.execute("UPDATE projects SET class_count=? WHERE id=?", (class_total, pid))

    db.set_status(pid, step="导出代码属性图")
    _store_graph(pid)


def run_async(pid):
    thread = threading.Thread(target=run, args=(pid,), daemon=True)
    thread.start()
    return thread
