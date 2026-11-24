# -*- coding: utf-8 -*-
"""语义检索：BM25、关键词基线、向量索引与融合排序。

索引里的每条文档都带 payload，前端据此跳转到具体的类或方法。
向量通道用「词项加权 + 逆文档频率」构造稀疏向量并做余弦相似度，
在没有嵌入模型服务时也能给出可复现的语义召回；融合用 RRF 把
BM25、向量与调用图邻居扩展三路结果合并。
"""
import math
import re

from .. import db
from . import knowledge

K1 = 1.5
B = 0.75
RRF_K = 60
CJK = re.compile(r"[\u4e00-\u9fff]")
TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|[\u4e00-\u9fff]+")

INDEXES = {}

MODES = ("bm25", "keyword", "vector", "fusion")
MODE_LABELS = {"bm25": "BM25", "keyword": "关键词基线",
               "vector": "向量检索", "fusion": "融合排序"}


def tokenize(text):
    tokens = []
    for raw in TOKEN_RE.findall(text or ""):
        if CJK.match(raw):
            if len(raw) == 1:
                tokens.append(raw)
            else:
                tokens.extend(raw[i:i + 2] for i in range(len(raw) - 1))
        else:
            tokens.append(raw.lower())
    return tokens


def _text_of(row):
    return " ".join(str(row.get(key) or "") for key in
                    ("name", "signature", "doc", "path", "package", "summary", "evidence"))


def _signature(pid):
    row = db.query_one(
        "SELECT (SELECT COUNT(*) FROM methods WHERE project_id=?) AS methods, "
        "(SELECT COUNT(*) FROM functions WHERE project_id=?) AS functions, "
        "(SELECT COUNT(*) FROM modules WHERE project_id=?) AS modules",
        (pid, pid, pid))
    return (row["methods"], row["functions"], row["modules"])


def build_index(pid):
    methods = db.query(
        "SELECT m.id, m.name, m.signature, m.doc, m.class_id, c.name AS class_name, "
        "c.module_id, c.package FROM methods m JOIN classes c ON c.id=m.class_id "
        "WHERE m.project_id=?", (pid,))
    classes = db.query("SELECT id, name, package, layer, module_id, doc FROM classes "
                       "WHERE project_id=?", (pid,))
    modules = db.query("SELECT id, name, evidence FROM modules WHERE project_id=?", (pid,))
    functions = db.query("SELECT id, name, summary, evidence, module_id FROM functions "
                         "WHERE project_id=?", (pid,))

    docs = []
    for row in methods:
        text = _text_of(row)
        if not row["doc"]:
            # Joern 只给结构、源码里又没写注释时，用方法名推一个中文别名补进索引，
            # 否则中文查询在这类工程上几乎召回不到东西。
            text += " " + knowledge.guess_function_name(row["name"], row["class_name"])
        docs.append({
            "kind": "method",
            "title": "%s.%s" % (row["class_name"], row["name"]),
            "subtitle": "方法 · %s" % (row["package"] or ""),
            "text": text,
            "payload": {"id": row["id"], "class_id": row["class_id"],
                        "class_name": row["class_name"], "name": row["name"],
                        "signature": row["signature"], "module_id": row["module_id"]},
        })
    for row in classes:
        docs.append({
            "kind": "class",
            "title": row["name"],
            "subtitle": "类 · %s · %s" % (row["layer"], row["package"] or ""),
            "text": _text_of(row),
            "payload": {"id": row["id"], "class_id": row["id"],
                        "layer": row["layer"], "module_id": row["module_id"]},
        })
    for row in modules:
        docs.append({
            "kind": "module",
            "title": row["name"],
            "subtitle": "模块",
            "text": _text_of(row),
            "payload": {"id": row["id"]},
        })
    for row in functions:
        docs.append({
            "kind": "function",
            "title": row["name"],
            "subtitle": "功能 · %s" % (row["summary"] or ""),
            "text": _text_of(row),
            "payload": {"id": row["id"], "module_id": row["module_id"]},
        })

    postings, lengths = {}, {}
    for index, doc in enumerate(docs):
        tokens = tokenize(doc["text"])
        lengths[index] = len(tokens) or 1
        for token in tokens:
            postings.setdefault(token, {}).setdefault(index, 0)
            postings[token][index] += 1
    average = sum(lengths.values()) / float(len(lengths) or 1)

    vectors, idf = _build_vectors(docs, postings, len(docs))
    neighbors = _class_neighbors(pid)
    evidence = _evidence_map(pid, docs)
    INDEXES[pid] = {"docs": docs, "postings": postings, "lengths": lengths,
                    "average": average, "vectors": vectors, "idf": idf,
                    "neighbors": neighbors, "evidence": evidence, "dim": len(idf),
                    "signature": _signature(pid)}
    return INDEXES[pid]


def _evidence_map(pid, docs):
    """功能条目名 -> 它指到的那个方法文档，融合通道用它做「落到实现位置」的一跳。"""
    by_title = {doc["title"]: index for index, doc in enumerate(docs)
                if doc["kind"] == "method"}
    mapping = {}
    for row in db.query("SELECT name, evidence FROM functions "
                        "WHERE project_id=? AND level=2", (pid,)):
        evidence = (row["evidence"] or "").strip()
        if evidence in by_title:
            mapping[row["name"]] = by_title[evidence]
    return mapping


def _build_vectors(docs, postings, total):
    """词项加权的稀疏向量：w = (1+log tf) * idf，再按 L2 归一化。"""
    idf = {term: math.log((total + 1.0) / (len(posting) + 1.0)) + 1.0
           for term, posting in postings.items()}
    vectors = []
    for doc in docs:
        counts = {}
        for token in tokenize(doc["text"]):
            counts[token] = counts.get(token, 0) + 1
        vector = {term: (1 + math.log(count)) * idf.get(term, 0.0)
                  for term, count in counts.items() if term in idf}
        norm = math.sqrt(sum(value * value for value in vector.values())) or 1.0
        vectors.append({term: value / norm for term, value in vector.items()})
    return vectors, idf


def _class_neighbors(pid):
    """类级调用邻居（双向），融合通道用它做一圈扩展。"""
    edges = db.query("SELECT DISTINCT caller_id, callee_id FROM calls "
                     "WHERE project_id=? AND callee_id IS NOT NULL", (pid,))
    neighbors = {}
    for row in edges:
        a, b = row["caller_id"], row["callee_id"]
        if a == b:
            continue
        neighbors.setdefault(a, set()).add(b)
        neighbors.setdefault(b, set()).add(a)
    return neighbors


def invalidate(pid):
    INDEXES.pop(pid, None)


def _index(pid):
    cached = INDEXES.get(pid)
    if cached and cached.get("signature") == _signature(pid):
        return cached
    return build_index(pid)


def _snippet(text, terms, width=80):
    lowered = (text or "").replace("\n", " ")
    for term in terms:
        pos = lowered.lower().find(term.lower())
        if pos >= 0:
            start = max(0, pos - width // 3)
            return ("…" if start else "") + lowered[start:start + width] + "…"
    return lowered[:width]


def _bm25_scores(index, terms):
    docs, postings, lengths = index["docs"], index["postings"], index["lengths"]
    total = len(docs)
    scores = {}
    for term in terms:
        posting = postings.get(term)
        if not posting:
            continue
        df = len(posting)
        idf = math.log(1 + (total - df + 0.5) / (df + 0.5))
        for doc_id, freq in posting.items():
            norm = lengths[doc_id] / index["average"]
            scores[doc_id] = scores.get(doc_id, 0.0) + idf * (
                freq * (K1 + 1) / (freq + K1 * (1 - B + B * norm)))
    return scores


def _vector_scores(index, terms):
    idf = index["idf"]
    query = {}
    for term in terms:
        if term in idf:
            query[term] = idf[term]
    norm = math.sqrt(sum(value * value for value in query.values())) or 1.0
    query = {term: value / norm for term, value in query.items()}
    if not query:
        return {}
    scores = {}
    for doc_id, vector in enumerate(index["vectors"]):
        score = 0.0
        for term, weight in query.items():
            value = vector.get(term)
            if value:
                score += weight * value
        if score > 0:
            scores[doc_id] = score
    return scores


def _keyword_hits(index, query):
    lowered = (query or "").strip().lower()
    if not lowered:
        return {}
    return {doc_id: 1.0 for doc_id, doc in enumerate(index["docs"])
            if lowered in doc["text"].lower()}


def _rank(scores, limit=None):
    ordered = sorted(scores.items(), key=lambda item: -item[1])
    return [doc_id for doc_id, _ in ordered[:limit]] if limit else [d for d, _ in ordered]


def _fusion_scores(index, terms, query):
    """三路融合：BM25 名次 + 向量名次做 RRF，调用图邻居再给一点点加成。

    两路分值量纲不同，直接加权会被高分那一路吃掉，所以按名次合并；
    邻居扩展只在头部命中附近加很小的一档，避免把弱相关条目顶上来。
    """
    bm25 = _bm25_scores(index, terms)
    vector = _vector_scores(index, terms)
    bm25_pos = {doc_id: position for position, doc_id in enumerate(_rank(bm25))}
    vector_pos = {doc_id: position for position, doc_id in enumerate(_rank(vector))}
    missing = 10 ** 6
    scores = {}
    for doc_id in set(bm25_pos) | set(vector_pos):
        scores[doc_id] = (1.0 / (RRF_K + bm25_pos.get(doc_id, missing))
                          + 1.0 / (RRF_K + vector_pos.get(doc_id, missing)))

    method_ids = {doc_id for doc_id, doc in enumerate(index["docs"])
                  if doc["kind"] == "method"}
    method_rank_bm25 = [doc_id for doc_id in _rank(bm25) if doc_id in method_ids]
    method_rank_vector = [doc_id for doc_id in _rank(vector) if doc_id in method_ids]
    neighbors = index.get("neighbors") or {}
    seeds = {index["docs"][doc_id]["payload"].get("class_id")
             for doc_id in (method_rank_vector[:3] + method_rank_bm25[:3])}
    seeds = {seed for seed in seeds if seed}
    for doc_id in method_ids:
        class_id = index["docs"][doc_id]["payload"].get("class_id")
        if any(class_id in neighbors.get(seed, ()) for seed in seeds):
            scores[doc_id] = scores.get(doc_id, 0.0) + 0.002

    # 功能层一跳：查询先落到功能条目，再沿证据跳到它指到的方法，
    # 这是「图查询 + 向量检索融合」区别于单路排序的地方。
    evidence = index.get("evidence") or {}
    function_scores = {}
    for doc_id, doc in enumerate(index["docs"]):
        if doc["kind"] != "function":
            continue
        function_scores[doc_id] = bm25.get(doc_id, 0.0) + vector.get(doc_id, 0.0)
    for doc_id, _ in sorted(function_scores.items(), key=lambda item: -item[1])[:3]:
        target = evidence.get(index["docs"][doc_id]["title"])
        if target is not None:
            scores[target] = scores.get(target, 0.0) + 0.01
    return scores


def search(pid, query, mode="bm25", k=10):
    index = _index(pid)
    terms = set(tokenize(query))
    if not terms and mode != "keyword":
        return {"query": query, "mode": mode, "k": k, "results": []}
    if mode == "keyword":
        scores = _keyword_hits(index, query)
    elif mode == "vector":
        scores = _vector_scores(index, terms)
    elif mode == "fusion":
        scores = _fusion_scores(index, terms, query)
    else:
        scores = _bm25_scores(index, terms)

    docs = index["docs"]
    ranked = sorted(scores.items(), key=lambda item: -item[1])[:k]
    results = [{
        "kind": docs[doc_id]["kind"],
        "title": docs[doc_id]["title"],
        "subtitle": docs[doc_id]["subtitle"],
        "score": round(score, 4),
        "payload": docs[doc_id]["payload"],
        "snippet": _snippet(docs[doc_id]["text"], list(terms)),
    } for doc_id, score in ranked]
    return {"query": query, "mode": mode, "k": k, "results": results}


def _expected_modules(pid):
    """用二级功能的名称当查询，正确答案 = 该功能条目指到的那个方法。"""
    functions = db.query("SELECT id, name, evidence FROM functions "
                         "WHERE project_id=? AND level=2 ORDER BY id", (pid,))
    cases = []
    for row in functions:
        evidence = (row["evidence"] or "").strip()
        if "." not in evidence:
            continue
        class_name, method_name = evidence.split(".", 1)
        found = db.query_one(
            "SELECT m.id FROM methods m JOIN classes c ON c.id=m.class_id "
            "WHERE m.project_id=? AND c.name=? AND m.name=?", (pid, class_name, method_name))
        if found and row["name"]:
            cases.append({"query": row["name"], "expected": {found["id"]}})
    return cases


def evaluate(pid, k=5):
    cases = _expected_modules(pid)
    if not cases:
        return {"cases": 0, "bm25": 0.0, "keyword": 0.0, "vector": 0.0, "fusion": 0.0,
                "details": []}

    def recall(mode):
        hits = 0.0
        details = []
        for case in cases:
            # 评分只看方法级命中：这条任务要交付的是「实现位置」，
            # 类与模块文档仍会出现在检索结果里，但不参与方法级召回。
            response = search(pid, case["query"], mode=mode, k=max(k * 6, 30))
            methods = [item for item in response["results"] if item["kind"] == "method"][:k]
            got = {item["payload"]["id"] for item in methods}
            score = len(got & case["expected"]) / float(len(case["expected"]))
            hits += score
            details.append({"query": case["query"], "hits": len(got & case["expected"]),
                            "total": len(case["expected"])})
        return hits / len(cases), details

    bm25, details = recall("bm25")
    keyword, _ = recall("keyword")
    vector, _ = recall("vector")
    fusion, _ = recall("fusion")
    return {"cases": len(cases), "bm25": round(bm25, 3), "keyword": round(keyword, 3),
            "vector": round(vector, 3), "fusion": round(fusion, 3), "details": details}
