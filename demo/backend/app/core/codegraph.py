# -*- coding: utf-8 -*-
"""调用图上的社区发现、模块度、内聚度与变更影响分析。

只依赖标准库：图用 {节点: {邻居: 权重}} 表示，节点是类 id。
"""
import random
from collections import defaultdict

from .. import db

LAYER_RULES = [
    ("接入层", ("controller", "resource", "handler", "endpoint", "api", "filter")),
    ("业务层", ("service", "manager", "usecase", "facade", "biz")),
    ("数据层", ("dao", "repository", "mapper", "store", "gateway", "jdbc", "feign", "client")),
    ("公共层", ("util", "utils", "helper", "common", "support", "config", "constant",
                "props", "properties", "exception", "aspect", "cache", "tool", "core",
                "launcher", "advice")),
    ("领域层", ("model", "entity", "vo", "po", "dto", "domain", "value")),
]


def guess_layer(name, package=""):
    """按包名分段优先、类名后缀兜底的顺序猜分层。"""
    segments = [part.lower() for part in (package or "").split(".") if part]
    for layer, tokens in LAYER_RULES:
        for token in tokens:
            if token in segments:
                return layer

    lowered = (name or "").lower()
    for layer, suffixes in LAYER_RULES:
        for suffix in suffixes:
            if lowered.endswith(suffix):
                return layer
    return "其他"


def build_class_graph(class_ids, call_pairs):
    """call_pairs: [(caller_id, callee_id)]，返回无向加权邻接表。"""
    adj = defaultdict(lambda: defaultdict(float))
    for caller, callee in call_pairs:
        if caller is None or callee is None or caller == callee:
            continue
        if caller not in class_ids or callee not in class_ids:
            continue
        adj[caller][callee] += 1.0
        adj[callee][caller] += 1.0
    for node in class_ids:
        adj[node]
    return adj


def add_type_edges(adj, class_ids, type_pairs, weight=0.4):
    """把类型依赖（继承、实现、字段与签名类型）并入调用图。

    调用边权重 1.0，类型依赖权重 0.4：让「同一业务模块里方法互相调用」仍占主导，
    但仅靠类型引用串联的类（DTO 与 Service、Controller 与 DTO）也能进同一社区。
    返回新增的边数。
    """
    added = 0
    for left, right in type_pairs:
        if left is None or right is None or left == right:
            continue
        if left not in class_ids or right not in class_ids:
            continue
        before = adj[left].get(right, 0.0)
        adj[left][right] = before + weight
        adj[right][left] = adj[right].get(left, 0.0) + weight
        if before == 0.0:
            added += 1
    return added


def modularity(adj, labels):
    """加权无向图的模块度 Q。labels: {node: community}。"""
    nodes = list(adj.keys())
    if not nodes:
        return 0.0
    total = 0.0
    degree = {node: 0.0 for node in nodes}
    for node, neighbours in adj.items():
        for weight in neighbours.values():
            degree[node] += weight
            total += weight
    if total <= 0:
        return 0.0
    half = total / 2.0  # 每条边被计了两次，m = half
    communities = defaultdict(list)
    for node in nodes:
        communities[labels.get(node, -1)].append(node)
    score = 0.0
    for members in communities.values():
        inner = 0.0
        degree_sum = 0.0
        for node in members:
            degree_sum += degree[node]
            for other, weight in adj[node].items():
                if labels.get(other, -1) == labels.get(node, -1):
                    inner += weight
        score += inner / total - (degree_sum / total) ** 2
    return score


def _louvain_pass(adj):
    """一次 Louvain 局部移动，返回 (labels, improved)。"""
    nodes = list(adj.keys())
    labels = {node: index for index, node in enumerate(nodes)}
    degree = {node: sum(adj[node].values()) for node in nodes}
    total = sum(degree.values()) or 1.0
    community_degree = defaultdict(float)
    for node in nodes:
        community_degree[labels[node]] += degree[node]
    improved = False
    order = list(nodes)
    random.shuffle(order)
    for node in order:
        current = labels[node]
        weights = defaultdict(float)
        for neighbour, weight in adj[node].items():
            weights[labels[neighbour]] += weight
        if not weights:
            continue
        community_degree[current] -= degree[node]
        best, best_gain = current, 0.0
        for community, weight in weights.items():
            gain = weight - community_degree[community] * degree[node] / total
            if gain > best_gain + 1e-12:
                best, best_gain = community, gain
        community_degree[best] += degree[node]
        if best != current:
            labels[node] = best
            improved = True
    return labels, improved


def louvain(adj, rounds=8):
    """两阶段 Louvain：局部移动 + 社区聚合，返回 ({原始节点: 社区}, Q)。"""
    mapping = {node: node for node in adj}
    current = {node: {nb: w for nb, w in adj[node].items()} for node in adj}
    q = 0.0
    for _ in range(rounds):
        labels, improved = _louvain_pass(current)
        q = modularity(current, labels)
        # 聚合：社区 -> 新节点
        groups = defaultdict(list)
        for node, label in labels.items():
            groups[label].append(node)
        merged = {}
        for label, members in groups.items():
            merged[label] = defaultdict(float)
        for node, neighbours in current.items():
            src = labels[node]
            for other, weight in neighbours.items():
                dst = labels[other]
                if src != dst:
                    merged[src][dst] += weight
        new_adj = defaultdict(lambda: defaultdict(float))
        for label, neighbours in merged.items():
            new_adj[label]
            for dst, weight in neighbours.items():
                new_adj[label][dst] += weight
        mapping = {origin: labels[community] if community in labels else community
                   for origin, community in mapping.items()}
        if not improved:
            break
        current = new_adj
    # 原始节点 -> 最终社区编号（压缩成 0..k-1）
    order = {}
    final = {}
    for node in sorted(mapping):
        community = mapping[node]
        if community not in order:
            order[community] = len(order)
        final[node] = order[community]
    return final, q


def merge_small(adj, labels, min_size=2, rounds=4):
    """把过小的社区并入联系最紧密的邻社。"""
    labels = dict(labels)
    for _ in range(rounds):
        sizes = defaultdict(int)
        for label in labels.values():
            sizes[label] += 1
        small = [label for label, size in sizes.items() if size < min_size]
        if not small:
            break
        for label in small:
            members = [node for node, lab in labels.items() if lab == label]
            weights = defaultdict(float)
            for node in members:
                for other, weight in adj[node].items():
                    if labels[other] != label:
                        weights[labels[other]] += weight
            if weights:
                target = max(weights.items(), key=lambda item: item[1])[0]
                for node in members:
                    labels[node] = target
    return _compact(labels)


def attach_isolated(adj, labels, classes):
    """无调用关系的类按「同包 + 类名前缀」并入相邻社区。"""
    labels = dict(labels)
    packages = defaultdict(list)
    for cls in classes:
        packages[cls.get("package") or ""].append(cls)
    for cls in classes:
        node = cls["id"]
        if adj.get(node):
            continue
        same_pkg = [c for c in packages[cls.get("package") or ""] if c["id"] != node]
        best, best_score = None, -1
        for other in same_pkg:
            score = _prefix_len(cls["name"], other["name"])
            if score > best_score:
                best, best_score = other, score
        if best and best_score >= 3:
            labels[node] = labels.get(best["id"], labels.get(node, 0))
        elif same_pkg:
            labels[node] = labels.get(same_pkg[0]["id"], labels.get(node, 0))
    return _compact(labels)


def split_large(labels, classes, limit=30):
    """把过大的社区按包名片段切开，避免出现「一个模块装下半个系统」。"""
    sizes = defaultdict(int)
    for label in labels.values():
        sizes[label] += 1
    big = {label for label, size in sizes.items() if size > limit}
    if not big:
        return dict(labels)
    by_id = {cls["id"]: cls for cls in classes}
    out, next_label = {}, max(labels.values()) + 1 if labels else 0
    for node, label in labels.items():
        if label not in big:
            out[node] = label
    for label in sorted(big):
        members = [node for node, lab in labels.items() if lab == label]
        buckets = defaultdict(list)
        for node in members:
            package = (by_id.get(node) or {}).get("package") or ""
            parts = [part for part in package.split(".") if part]
            key = ".".join(parts[-2:]) if len(parts) >= 2 else package
            buckets[key].append(node)
        for key, nodes in sorted(buckets.items()):
            if len(nodes) >= max(3, limit // 6):
                assigned = next_label
                next_label += 1
            else:
                assigned = label
            for node in nodes:
                out[node] = assigned
    return _compact(out)


def _prefix_len(a, b):
    count = 0
    for left, right in zip(a.lower(), b.lower()):
        if left != right:
            break
        count += 1
    return count


def group_isolated(adj, labels, classes):
    """孤立类（无调用边）先按包名聚成一组，避免大工程被切成几十个单类模块。

    包内成员不足 2 个时退到上一级包名；仍不足则留待 merge_small 处理。
    """
    labels = dict(labels)
    free = [cls for cls in classes if not adj.get(cls["id"])]
    if not free:
        return labels
    buckets = defaultdict(list)
    for cls in free:
        package = cls.get("package") or ""
        parts = [part for part in package.split(".") if part]
        key = ".".join(parts[-2:]) if len(parts) >= 2 else package
        buckets[key].append(cls)
    used = set(labels.values())
    for key, members in sorted(buckets.items()):
        if len(members) < 2:
            continue
        if not key:
            label = max(used) + 1 if used else 0
        else:
            label = max(used) + 1 if used else 0
        used.add(label)
        for cls in members:
            labels[cls["id"]] = label
    return _compact(labels)


def consolidate(adj, labels, classes, target_max=None, min_size=None):
    """把碎社区收敛到可读的规模：孤立类按包聚合 → 小社区并邻 → 限制模块数。"""
    total = max(1, len(labels))
    if target_max is None:
        target_max = max(6, min(14, round(total / 25) + 5))
    if min_size is None:
        min_size = max(2, round(total / 40))

    labels = dict(labels)
    labels = group_isolated(adj, labels, classes)

    for _ in range(6):
        sizes = defaultdict(int)
        for label in labels.values():
            sizes[label] += 1
        small = [label for label, size in sizes.items() if size < min_size]
        if not small:
            break
        for label in small:
            members = [node for node, lab in labels.items() if lab == label]
            weights = defaultdict(float)
            for node in members:
                for other, weight in adj[node].items():
                    if labels[other] != label:
                        weights[labels[other]] += weight
            if weights:
                target = max(weights.items(), key=lambda item: item[1])[0]
                for node in members:
                    labels[node] = target
            elif len(sizes) > target_max:
                # 没有邻居可并时，按包名就近挂靠，仍不行就保持独立
                package = next((c.get("package") for c in classes if c["id"] == members[0]), "")
                for other_node, other_label in labels.items():
                    if other_label == label:
                        continue
                    other = next((c for c in classes if c["id"] == other_node), None)
                    if other and other.get("package") == package:
                        for node in members:
                            labels[node] = other_label
                        break

    while len(set(labels.values())) > target_max:
        sizes = defaultdict(int)
        for label in labels.values():
            sizes[label] += 1
        smallest = min(sizes.items(), key=lambda item: item[1])[0]
        members = [node for node, lab in labels.items() if lab == smallest]
        weights = defaultdict(float)
        for node in members:
            for other, weight in adj[node].items():
                if labels[other] != smallest:
                    weights[labels[other]] += weight
        if weights:
            target = max(weights.items(), key=lambda item: item[1])[0]
        else:
            package = next((c.get("package") for c in classes if c["id"] == members[0]), "")
            target = None
            for other_node, other_label in labels.items():
                other = next((c for c in classes if c["id"] == other_node), None)
                if other and other.get("package") == package and other_label != smallest:
                    target = other_label
                    break
            if target is None:
                target = max(sizes.items(), key=lambda item: item[1])[0]
                if target == smallest:
                    break
        for node in members:
            labels[node] = target
    return _compact(labels)


def _compact(labels):
    order, final = {}, {}
    for node in sorted(labels):
        label = labels[node]
        if label not in order:
            order[label] = len(order)
        final[node] = order[label]
    return final


def cohesion(adj, labels, community):
    members = [node for node, label in labels.items() if label == community]
    if len(members) < 2:
        return 0.0
    possible = len(members) * (len(members) - 1) / 2.0
    actual = 0.0
    for index, node in enumerate(members):
        for other in members[index + 1:]:
            if adj.get(node, {}).get(other):
                actual += 1
    return actual / possible


def nmi(labels_a, labels_b):
    """两套划分的标准化互信息。"""
    from math import log

    nodes = sorted(set(labels_a) & set(labels_b))
    if not nodes:
        return 0.0
    total = float(len(nodes))
    a_counts, b_counts, joint = defaultdict(float), defaultdict(float), defaultdict(float)
    for node in nodes:
        a, b = labels_a[node], labels_b[node]
        a_counts[a] += 1
        b_counts[b] += 1
        joint[(a, b)] += 1
    mi = 0.0
    for (a, b), count in joint.items():
        mi += count / total * log((count * total) / (a_counts[a] * b_counts[b]) + 1e-12, 2)
    ha = -sum(c / total * log(c / total, 2) for c in a_counts.values())
    hb = -sum(c / total * log(c / total, 2) for c in b_counts.values())
    if ha <= 0 or hb <= 0:
        return 0.0
    return max(0.0, mi / ((ha + hb) / 2.0))


def class_package_labels(classes):
    packages = {}
    for cls in classes:
        packages[cls["id"]] = cls.get("package") or "(default)"
    return packages


def class_graph(pid):
    """从库里重建有向调用关系与类索引，供图查询与关键路径复用。"""
    classes = db.query("SELECT id, name, layer, module_id, package FROM classes "
                       "WHERE project_id=?", (pid,))
    by_id = {row["id"]: row for row in classes}
    edges = db.query("SELECT caller_id, callee_id FROM calls WHERE project_id=? "
                     "AND callee_id IS NOT NULL AND caller_id IS NOT NULL", (pid,))
    out_edges, in_edges = defaultdict(set), defaultdict(set)
    for row in edges:
        src, dst = row["caller_id"], row["callee_id"]
        if src == dst or src not in by_id or dst not in by_id:
            continue
        out_edges[src].add(dst)
        in_edges[dst].add(src)
    return by_id, out_edges, in_edges


def callers(pid, class_id):
    by_id, _, in_edges = class_graph(pid)
    row = by_id.get(int(class_id))
    if not row:
        return None
    return {"origin": {"id": row["id"], "name": row["name"], "layer": row["layer"]},
            "nodes": [{"id": by_id[i]["id"], "name": by_id[i]["name"],
                       "layer": by_id[i]["layer"]} for i in sorted(in_edges.get(row["id"], ()))]}


def callees(pid, class_id):
    by_id, out_edges, _ = class_graph(pid)
    row = by_id.get(int(class_id))
    if not row:
        return None
    return {"origin": {"id": row["id"], "name": row["name"], "layer": row["layer"]},
            "nodes": [{"id": by_id[i]["id"], "name": by_id[i]["name"],
                       "layer": by_id[i]["layer"]} for i in sorted(out_edges.get(row["id"], ()))]}


def shortest_path(pid, src_name, dst_name):
    """类名到类名的最短调用路径（BFS），用于解释「这个入口怎么走到那段逻辑」。"""
    by_id, out_edges, _ = class_graph(pid)
    lookup = {}
    for row in by_id.values():
        lookup.setdefault(row["name"], row["id"])
    src, dst = lookup.get(src_name), lookup.get(dst_name)
    if not src or not dst:
        return {"found": False, "path": [],
                "message": "未知的类名：%s" % (src_name if not src else dst_name)}
    previous = {src: None}
    queue = [src]
    while queue:
        current = queue.pop(0)
        if current == dst:
            break
        for nxt in sorted(out_edges.get(current, ())):
            if nxt not in previous:
                previous[nxt] = current
                queue.append(nxt)
    if dst not in previous:
        return {"found": False, "path": []}
    chain, node = [], dst
    while node is not None:
        chain.append({"id": node, "name": by_id[node]["name"], "layer": by_id[node]["layer"]})
        node = previous[node]
    chain.reverse()
    return {"found": True, "path": chain}


def critical_paths(pid, limit=3):
    """关键路径：从接入层入口出发，沿调用图找最长的一条链（入口 → 核心流程）。"""
    by_id, out_edges, _ = class_graph(pid)
    if not by_id:
        return []
    entries = [row["id"] for row in by_id.values() if row["layer"] == "接入层"]
    if not entries:
        entries = [row["id"] for row in by_id.values() if not _in_degree(by_id, out_edges)[row["id"]]]

    def longest(start):
        best, best_path = 0, [start]
        stack = [(start, [start])]
        while stack:
            node, path = stack.pop()
            if len(path) - 1 > best:
                best, best_path = len(path) - 1, list(path)
            for nxt in sorted(out_edges.get(node, ())):
                if nxt in path:  # 防环
                    continue
                stack.append((nxt, path + [nxt]))
        return best_path

    chains = []
    for entry in entries:
        path = longest(entry)
        if len(path) > 1:
            chains.append(path)
    chains.sort(key=lambda item: -len(item))
    result = []
    for chain in chains[:limit]:
        result.append([{"id": node, "name": by_id[node]["name"], "layer": by_id[node]["layer"]}
                       for node in chain])
    return result


def _in_degree(by_id, out_edges):
    degree = {node: 0 for node in by_id}
    for targets in out_edges.values():
        for target in targets:
            degree[target] = degree.get(target, 0) + 1
    return degree


def impact(pid, class_id, method=None):
    """沿调用图反向 BFS：谁调用了它，谁又调用了那些人。

    给了 method 时，第一跳只保留「确实调用了这个方法」的类；再往上仍按类级调用扩散
    （调用表只记到类，方法级再往上的精度并不存在）。
    """
    classes = db.query("SELECT id, name, layer, module_id FROM classes WHERE project_id=?", (pid,))
    by_id = {row["id"]: row for row in classes}
    if class_id not in by_id:
        return None
    callers = db.query("SELECT caller_id, callee_id FROM calls WHERE project_id=? "
                       "AND callee_id IS NOT NULL", (pid,))
    reverse = defaultdict(set)
    for row in callers:
        reverse[row["callee_id"]].add(row["caller_id"])

    seen = {class_id}
    dist = {class_id: 0}
    parent = {}
    queue = [class_id]
    if method:
        first = [row["caller_id"] for row in db.query(
            "SELECT DISTINCT caller_id FROM calls WHERE project_id=? AND callee_id=? "
            "AND callee_name=?", (pid, class_id, method))]
        queue = []
        for caller in sorted(set(first)):
            if caller in seen:
                continue
            seen.add(caller)
            dist[caller] = 1
            parent[caller] = class_id
            queue.append(caller)
    while queue:
        current = queue.pop(0)
        for caller in sorted(reverse.get(current, ())):
            if caller not in seen:
                seen.add(caller)
                dist[caller] = dist[current] + 1
                parent[caller] = current
                queue.append(caller)

    origin = by_id[class_id]
    modules = db.query("SELECT id, name FROM modules WHERE project_id=? ORDER BY id", (pid,))
    module_names = {row["id"]: row["name"] for row in modules}
    functions = db.query("SELECT id, name, module_id, summary FROM functions "
                         "WHERE project_id=? AND parent_id IS NOT NULL", (pid,))

    touched_modules = set()
    for node in seen:
        module_id = by_id[node].get("module_id")
        if module_id:
            touched_modules.add(module_id)

    function_rows = [row for row in functions if row["module_id"] in touched_modules]

    def node(n):
        return {"id": by_id[n]["id"], "name": by_id[n]["name"], "layer": by_id[n]["layer"],
                "module": module_names.get(by_id[n].get("module_id"), "")}

    # 最深的几条影响链，给前端画「影响路径」
    chains = []
    for target in sorted((n for n in dist if n != class_id), key=lambda n: -dist[n])[:4]:
        path = [target]
        while path[-1] != class_id and path[-1] in parent:
            path.append(parent[path[-1]])
        chains.append([node(n) for n in path])

    return {
        "origin": {"id": origin["id"], "name": origin["name"], "layer": origin["layer"],
                   "method": method or ""},
        "classes": [{**node(n), "hop": dist[n]} for n in sorted(seen, key=lambda x: (dist[x], x))],
        "chains": chains,
        "max_hop": max(dist.values()) if dist else 0,
        "modules": [{"id": mid, "name": module_names.get(mid, "")}
                    for mid in sorted(touched_modules)],
        "functions": [{"id": row["id"], "name": row["name"],
                       "module": module_names.get(row["module_id"], ""),
                       "summary": row.get("summary") or ""} for row in function_rows],
    }
