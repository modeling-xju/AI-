# -*- coding: utf-8 -*-
"""文档生成：接口文档、用户手册、项目报告。

生成的是 Markdown，落库后由前端渲染（本模块自带极简渲染器，
frontend 也可以直接用 html 字段）。
"""
import html
import re

from .. import db

# Joern 的签名带全限定名（org.springblade.core.tool.api.R），文档表格里读起来太吵：
# 去掉包前缀只留简单类名，泛型里的全名也一并处理。
_FQN_RE = re.compile(r"\b(?:[a-z_$][\w$]*\.)+([A-Z][\w$]*)")


def _simple(text):
    if not text:
        return text
    return _FQN_RE.sub(r"\1", str(text))

KINDS = {
    "api": "接口文档",
    "manual": "用户手册",
    "report": "项目报告",
}


def _metric_map(pid):
    return {row["key"]: row for row in
            db.query("SELECT key, label, value, note FROM metrics WHERE project_id=?", (pid,))}


def generate(pid, kind):
    if kind not in KINDS:
        raise ValueError("未知文档类型：%s" % kind)
    builder = {"api": api_doc, "manual": manual_doc, "report": report_doc}[kind]
    content = builder(pid)
    title = KINDS[kind]
    old = db.query_one("SELECT id FROM documents WHERE project_id=? AND kind=?", (pid, kind))
    if old:
        db.execute("UPDATE documents SET title=?, content=?, created_at=? WHERE id=?",
                   (title, content, db.now(), old["id"]))
        return old["id"]
    return db.execute("INSERT INTO documents(project_id, kind, title, content, created_at) "
                      "VALUES(?,?,?,?,?)", (pid, kind, title, content, db.now()))


def api_doc(pid):
    project_row = db.project(pid)
    controllers = db.query(
        "SELECT id, name, package, doc FROM classes WHERE project_id=? AND layer='接入层' "
        "ORDER BY name", (pid,))
    lines = ["# 接口文档", "",
             "工程：**%s**" % (project_row["name"] if project_row else pid), "",
             "本文档由代码结构事实自动生成：接口清单来自接入层类，参数与返回值来自方法签名。", ""]
    if not controllers:
        lines.append("未识别到接入层类（类名以 Controller/Resource/Handler 结尾）。")
    for controller in controllers:
        lines.append("## %s" % controller["name"])
        if controller["package"]:
            lines.append("")
            lines.append("包：`%s`" % controller["package"])
        if controller["doc"]:
            lines.append("")
            lines.append(controller["doc"])
        methods = db.query(
            "SELECT name, signature, return_type, params, line, doc FROM methods "
            "WHERE project_id=? AND class_id=? AND is_public=1 ORDER BY line",
            (pid, controller["id"]))
        if not methods:
            lines.append("")
            lines.append("（该类没有公开方法）")
            continue
        lines += ["", "| 方法 | 说明 | 入参 | 返回 | 位置 |",
                  "| --- | --- | --- | --- | --- |"]
        for method in methods:
            doc = method["doc"] or "—"
            params = _simple(method["params"]) or "—"
            lines.append("| `%s` | %s | %s | %s | 第 %d 行 |" % (
                html.escape(_simple(method["signature"])), doc, params,
                _simple(method["return_type"]) or "void", method["line"]))
        lines.append("")
    return "\n".join(lines)


def manual_doc(pid):
    project_row = db.project(pid)
    modules = db.query("SELECT id, name, evidence, size, cohesion FROM modules "
                       "WHERE project_id=? ORDER BY id", (pid,))
    lines = ["# 用户手册", "",
             "工程：**%s**" % (project_row["name"] if project_row else pid), "",
             "本系统用来把一份看不懂的 Java 源码，变成能读的功能清单、架构视图与项目文档。",
             ""]
    lines += ["## 一、准备", "",
              "1. 在「工程接入」里选择服务器上的源码目录，或直接上传 zip；",
              "2. 点击「重新分析」，等待进度条走到 100%；",
              "3. 从左到右依次查看：代码结构 → 模块划分 → 功能需求 → 系统架构。", ""]
    lines += ["## 二、功能说明", ""]
    for module in modules:
        lines.append("### %s" % module["name"])
        lines.append("")
        lines.append("范围：%d 个类，内聚度 %.2f。%s" % (
            module["size"], module["cohesion"], module["evidence"] or ""))
        functions = db.query("SELECT name, summary, evidence FROM functions WHERE project_id=? "
                             "AND module_id=? AND level=2 ORDER BY id",
                             (pid, module["id"]))
        lines.append("")
        for function in functions:
            summary = function["summary"] or "—"
            evidence = (function["evidence"] or "").strip()
            # 摘要里通常已经写了「入口 Class.method」，重复的证据不再加括号
            if evidence and evidence not in summary:
                lines.append("- **%s**：%s（%s）" % (function["name"], summary, evidence))
            else:
                lines.append("- **%s**：%s" % (function["name"], summary))
        lines.append("")
    lines += ["## 三、局限", "",
              "结构事实来自源码解析，动态分派与反射调用的目标可能缺失；"
              "功能命名由模型或启发式给出，需要在抽样校验后再采信。", ""]
    return "\n".join(lines)


def report_doc(pid):
    project_row = db.project(pid) or {}
    metrics = _metric_map(pid)
    modules = db.query("SELECT name, size, cohesion, method_count, evidence FROM modules "
                       "WHERE project_id=? ORDER BY size DESC", (pid,))
    comparisons = db.query("SELECT name, layer, provides, depends_on FROM components "
                           "WHERE project_id=? ORDER BY id", (pid,))
    evaluation = _retrieval_row(metrics)

    lines = ["# 项目报告", "",
             "工程：**%s**　源码根目录：`%s`" % (project_row.get("name", pid),
                                              project_row.get("root", "")), "", "## 一、结构指标", "",
             "| 指标 | 数值 | 说明 |", "| --- | --- | --- |"]
    for key in ("classes", "methods", "calls", "modules", "modularity",
                "package_modularity", "nmi", "cohesion"):
        row = metrics.get(key)
        if row:
            lines.append("| %s | %s | %s |" % (row["label"], _fmt(row["value"]), row["note"]))
    lines += ["", "## 二、模块划分", "",
              "| 模块 | 类数 | 方法数 | 内聚度 | 依据 |", "| --- | --- | --- | --- | --- |"]
    for module in modules:
        lines.append("| %s | %d | %d | %.2f | %s |" % (
            module["name"], module["size"], module["method_count"],
            module["cohesion"], module["evidence"] or ""))
    lines += ["", "## 三、架构视图", ""]
    for component in comparisons:
        provides = "、".join(db.load_json(component["provides"])[:6]) or "—"
        depends = "、".join(db.load_json(component["depends_on"])[:6]) or "—"
        lines.append("- **%s**（%s）：提供 %s；依赖 %s" % (
            component["name"], component["layer"], provides, depends))
    lines += ["", "## 四、属性图统计", "",
              "| 类别 | 数量 | 说明 |", "| --- | --- | --- |"]
    for key, label, note in (
            ("cpg_nodes", "节点", "方法节点与语句节点"),
            ("cpg_edges", "边", "AST/CALL/CFG/CDG/DDG/REF 合计"),
            ("cpg_ast", "AST 边", "方法到语句的包含关系"),
            ("cpg_call", "CALL 边", "调用点指到被调用类"),
            ("cpg_cfg", "CFG 边", "语句执行先后"),
            ("cpg_cdg", "CDG 边", "分支对语句的控制依赖"),
            ("cpg_ddg", "DDG 边", "变量定义到使用"),
            ("cpg_ref", "引用边", "继承、实现、字段、参数与返回值")):
        row = metrics.get(key)
        if row:
            lines.append("| %s | %s | %s |" % (label, _fmt(row["value"]), note))
    lines += ["", "## 五、方法评测", "",
              "| 环节 | 输入 | 输出 | 对比 |", "| --- | --- | --- | --- |",
              "| 社区发现 | 方法级调用图 | 候选模块 | 与包结构对比：Q=%.3f vs %.3f，NMI=%.3f |" % (
                  metrics.get("modularity", {}).get("value", 0),
                  metrics.get("package_modularity", {}).get("value", 0),
                  metrics.get("nmi", {}).get("value", 0)),
              "| 语义检索 | 自然语言查询 | 排序后的方法 | Recall@5：BM25=%.3f、向量=%.3f、"
              "融合=%.3f、关键词=%.3f |" % (
                  evaluation.get("bm25", 0), evaluation.get("vector", 0),
                  evaluation.get("fusion", 0), evaluation.get("keyword", 0)),
              "| 功能归纳 | 结构证据 | 功能名与说明 | 抽样人工判定（待补） |", "",
              "## 六、局限", "",
              "1. 只解析静态结构，动态代理、反射、字符串拼接的类名不在覆盖范围内；",
              "2. 功能命名与摘要是模型输出，评审时需要回指到条目证据；",
              "3. 检索评测的查询集由功能条目构造，融合通道借「功能条目 → 证据方法」一跳占优，"
              "换成人写提问时各通道差距会收窄；",
              "4. 属性图由自研解析器导出，语句级节点覆盖常见写法，不对应 Joern 的完整 CPG 语义。", ""]
    return "\n".join(lines)


def _retrieval_row(metrics):
    return {"bm25": metrics.get("recall_bm25", {}).get("value", 0),
            "keyword": metrics.get("recall_keyword", {}).get("value", 0),
            "vector": metrics.get("recall_vector", {}).get("value", 0),
            "fusion": metrics.get("recall_fusion", {}).get("value", 0)}


def _fmt(value):
    if isinstance(value, float):
        if value.is_integer():
            return int(value)  # 计数类指标不要写成 20.0
        return round(value, 3)
    return value


def _inline(text):
    text = html.escape(text)
    while "`" in text:
        start = text.find("`")
        end = text.find("`", start + 1)
        if end < 0:
            break
        text = text[:start] + "<code>" + text[start + 1:end] + "</code>" + text[end + 1:]
    for marker, tag in (("**", "strong"),):
        while marker in text:
            start = text.find(marker)
            end = text.find(marker, start + 2)
            if end < 0:
                break
            text = text[:start] + "<%s>%s</%s>" % (tag, text[start + 2:end], tag) + text[end + 2:]
    return text


def render(markdown):
    """极简 Markdown -> HTML，够渲染本模块自己的产出。"""
    lines = (markdown or "").splitlines()
    output, index = [], 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        if stripped.startswith("#"):
            level = len(stripped) - len(stripped.lstrip("#"))
            output.append("<h%d>%s</h%d>" % (level, _inline(stripped[level:].strip()), level))
            index += 1
            continue
        if stripped.startswith("|"):
            rows = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append([cell.strip() for cell in lines[index].strip().strip("|").split("|")])
                index += 1
            header, body = rows[0], [row for row in rows[1:]
                                     if not set("".join(row)) <= set("-: ")]
            output.append("<table><thead><tr>%s</tr></thead><tbody>%s</tbody></table>" % (
                "".join("<th>%s</th>" % _inline(cell) for cell in header),
                "".join("<tr>%s</tr>" % "".join("<td>%s</td>" % _inline(cell) for cell in row)
                        for row in body)))
            continue
        if stripped.startswith("- "):
            items = []
            while index < len(lines) and lines[index].strip().startswith("- "):
                items.append(_inline(lines[index].strip()[2:]))
                index += 1
            output.append("<ul>%s</ul>" % "".join("<li>%s</li>" % item for item in items))
            continue
        if stripped[0].isdigit() and "." in stripped[:3]:
            items = []
            while index < len(lines) and lines[index].strip()[:1].isdigit():
                text = lines[index].strip()
                items.append(_inline(text.split(".", 1)[1].strip()))
                index += 1
            output.append("<ol>%s</ol>" % "".join("<li>%s</li>" % item for item in items))
            continue
        paragraph = []
        while index < len(lines) and lines[index].strip() and not lines[index].strip()[0] in "#|-":
            paragraph.append(lines[index].strip())
            index += 1
        output.append("<p>%s</p>" % _inline(" ".join(paragraph)))
    return "\n".join(output)
