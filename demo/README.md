# AI 赋能的软件逆向工程系统（demo）

一个可运行的端到端演示：输入 Java 工程目录（或 zip、Git 仓库），输出**功能树、架构视图、检索结果、变更影响与三类文档**。
后端 FastAPI + SQLite，前端原生 HTML/JS（无构建步骤）。自带两个示例工程：
`demo/samples/minishop`（20 个业务类，自研解析器即可跑通）与 `demo/samples/springblade`
（SpringBlade，253 个类，走 Joern 的 CPG）。

两种解析引擎可在接入工程时选择：

| engine | 说明 |
| --- | --- |
| `joern` | 用 Joern 4.0.690 生成 CPG（`joern-parse` → 起本地 CPGQL 服务 → 抽节点/边），类、方法、调用点与 AST/CFG/CDG/DDG/REF 边都来自 CPG |
| `self` | 自研解析器（`app/core/javaparse.py` + `app/core/cpg.py`），不依赖 JDK，适合小工程与离线演示 |

Joern 引擎需要 JDK 17 与 joern-cli，默认从 `tools/` 下找（也可用环境变量覆盖）：

```bash
tools/jdk17/jdk-17.0.2              # JAVA_HOME
tools/joern/joern-cli               # JOERN_HOME，含 joern-parse.bat / joern.bat
tools/tmp                           # TMP/TEMP，joern-parse 的临时目录必须可写
```

## 运行

```bash
cd demo/backend
pip install -r requirements.txt
python run.py           # 默认 http://127.0.0.1:8100
```

首次启动会自动建库 `demo/data/reverse.db`。页面打开后：

1. 点「接入新工程」：目录填 `D:\...\demo\samples\minishop`（或任意 Java 工程目录），
   「解析引擎」选自研或 Joern；也可以在下方的 Git 地址里填仓库 URL，或点「上传 zip」；
2. 分析完成后从顶栏切换八个视图；
3. 「文档生成」里可生成接口文档 / 用户手册 / 项目报告，并导出 Markdown。

完整的模块划分、数据模型与「毕设简介逐条对照」见 [docs/系统框架设计.md](docs/系统框架设计.md)。

## 数据流

```
Java 源码 → repo.scan（文件分类、语言统计、构建方式、测试文件剔除）
          → engine=joern：joern-parse 生成 CPG → CPGQL 抽类/方法/调用与六类边
            engine=self ：javaparse 解析 + cpg 导出（AST/CALL/CFG/CDG/DDG/REF）
          → 调用图 & 社区发现（Louvain，Q/NMI）→ 大工程再做同名主语归并
          → 模块命名（LLM 或启发式）→ 功能树（一级模块 / 二级方法）
          → 组件图（分层、依赖矩阵、关键路径）→ 文档（接口/手册/报告，可导出）
          → 检索索引（BM25 / 向量 / 融合）与评测（Recall@5 vs 关键词基线）
```

所有结论都带证据：功能条目指向 `Class.method`，模块指向类集合，组件指向类与依赖，文档条目带源码行号。

## 目录

```
demo/
  backend/
    app/
      main.py            FastAPI 入口（挂 API 与前端静态资源）
      db.py              SQLite 表结构与读写（含列迁移）
      services.py        把库里的结果整理成前端要的 JSON
      core/repo.py       仓库接入（目录/zip/Git、文件分类、构建方式、语言统计）
      core/javaparse.py  Java 解析器（类、方法、调用点、javadoc、分支/循环/捕获）
      core/cpg.py        代码属性图导出（六类边，Joern 未就绪时的自研实现）
      core/codegraph.py  调用图、模块度、NMI、Louvain、分层、关键路径、影响分析、图查询
      core/knowledge.py  模块命名与功能摘要（LLM 优先，失败走启发式）
      core/retrieve.py   BM25 / 向量 / 融合检索与 Recall@5 评测
      core/pipeline.py   一次分析的完整流水线（后台线程执行）
      core/docs.py       接口文档 / 用户手册 / 项目报告 + Markdown 导出
      routers/*.py       projects / analysis / search / docs_api
    run.py               python run.py
    requirements.txt
  frontend/
    index.html           单页壳，八个 hash 路由
    assets/app.js        渲染与交互
    assets/style.css     样式
  samples/minishop/      示例 Java 工程（com.shop.web/service/dao/model/util）
  data/                  SQLite 库（运行时生成）
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回是否配置了大模型 |
| GET | `/api/projects` | 工程列表 |
| POST | `/api/projects` | 接入工程，body `{name, root}` 或 `{name, git_url}`（Git 克隆） |
| POST | `/api/projects/upload` | 上传 zip（form: `file`, `name`） |
| DELETE | `/api/projects/{pid}` | 删除工程及其分析结果 |
| POST | `/api/projects/{pid}/analyze` | 触发分析（后台线程） |
| GET | `/api/projects/{pid}/status` | 进度：`status/step/percent/running/error` |
| GET | `/api/projects/{pid}/overview` | 指标、构建方式/语言构成、模块划分、产物计数 |
| GET | `/api/projects/{pid}/structure` | 文件（分类）→ 类 → 方法（分支/循环/捕获）→ 调用点 |
| GET | `/api/projects/{pid}/functions` | 功能树（一级模块 + 二级条目） |
| GET | `/api/projects/{pid}/architecture` | 分层组件、层间依赖矩阵、组件—功能映射、入口关键路径 |
| GET | `/api/projects/{pid}/compare` | 模块度、NMI、检索评测 |
| GET | `/api/projects/{pid}/search?q=&mode=&k=` | `mode=bm25\|keyword\|vector\|fusion` |
| GET | `/api/projects/{pid}/graph?op=callers\|callees\|path&class=&from=&to=` | 知识库图查询：谁调用它 / 它调用谁 / 两类间最短调用链 |
| GET | `/api/projects/{pid}/impact/{class_id}` | 变更影响：类 → 模块 → 功能 |
| GET | `/api/projects/{pid}/documents` | 文档列表 |
| GET | `/api/projects/{pid}/documents/{doc_id}` | 单篇（`html` 为渲染结果） |
| GET | `/api/projects/{pid}/documents/{doc_id}/export` | 导出 Markdown 附件 |
| POST | `/api/projects/{pid}/documents/{kind}` | 生成 `api\|manual\|report` |

## 示例工程的指标（minishop）

20 个类、90 个方法、70 个可解析调用点；内置 `pom.xml`，因此识别为 maven 工程，
1 个测试文件不计入分析、1 个配置文件计入分类。Louvain 得到 3 个社区，模块度 Q=0.540，
与包结构划分的 NMI=0.135（包结构模块度 −0.262），平均内聚 0.476；功能树 3 个一级模块、20 条二级功能；
层间依赖矩阵 6×6、入口关键路径 3 条（5/4/4 跳）；
属性图 246 节点 / 372 边（AST 156、CALL 70、CFG 88、CDG 21、DDG 7、REF 30）；
检索 Recall@5：融合 100%、BM25 75%、向量 75%、整串关键词 45%（20 条功能条目查询）。

## 大示例：SpringBlade（engine=joern）

`demo/samples/springblade` 取自 Gitee 上的 SpringBlade（GitHub 不可达时代替），253 个 Java 类、8 个测试文件、
90 个配置文件，`engine=joern` 分析约 85 秒（含 `joern-parse` 与本地 CPGQL 服务启动）。结果：

| 项目 | 数值 |
| --- | --- |
| 类 / 方法 / 调用点 | 253 / 933 / 4289 |
| 属性图 | 38397 节点 / 68141 边（AST 34860、CALL 4434、CFG 12672、CDG 2738、DDG 9120、REF 4317） |
| 社区 | 12 个（同名主语归并后），Q=0.323，包结构模块度 −0.066，NMI=0.638，内聚 0.121 |
| 功能树 | 12 个一级模块、83 条二级功能 |
| 检索 Recall@5 | 融合 51.8%、关键词 48.2%、向量 39.8%、BM25 38.6%（83 条查询） |

对比自研解析器（同一工程、`engine=self`）：253 类 / 420 方法（Lombok 与注解方法解析不全）、
属性图 1902 节点 / 5188 边——这也是把 Joern 作为默认大工程引擎的原因。

## 大模型（可选）

设置环境变量后，模块命名与功能摘要会走模型；未设置时用启发式（动词/名词映射表），
界面上 `总览` 的措辞与 `/api/health` 会反映当前状态。

```
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o-mini
```

## 已知边界

- 只解析 Java 源码的类/方法/调用点，不做跨文件类型推断，重载按名称合并；
- 调用点解析只看「最近声明的类名 / new 表达式」，反射与接口多态不计；
- 自研引擎（`engine=self`）的属性图由 `core/cpg.py` 导出：语句级节点覆盖常见写法，
  CFG/CDG/DDG 是基于语句序列与分支块的近似，不等同 Joern 的完整 CPG 语义；
  Joern 引擎（`engine=joern`）的属性图直接取自 CPG（节点/边统计见总览与对比页）；
  REF 边用的是 Joern 自己的引用边（`cpg.all.out("REF")`，SpringBlade 4317 条），
  DDG 要单独说明：图里不落盘（`all.out("DDG")` 为 0），9120 条是 `cpg.call.ddgIn`
  让数据流引擎按需算出来的，界面上标了「数据流引擎按需计算」；
- 向量通道是「词项加权 + 逆文档频率」的稀疏向量（`core/retrieve.py`），不是神经嵌入；
  接口按向量检索的形状写，接入真实 embedding 时替换 `_build_vectors` / `_vector_scores`；
- 检索评测的查询集由功能条目构造，融合通道会经「功能条目 → 证据方法」一跳，因此在该集合上领先；
  换成人写提问，各通道差距会收窄；SpringBlade 这类注释稀疏的工程里，方法文档会用方法名推的中文
  别名补全，检索指标因此比带 javadoc 的工程低（83 条查询：融合 51.8%、关键词 48.2%、向量 39.8%、BM25 38.6%）；
- Git 接入是「克隆 / 拉取」级别的增量，不做提交级差分；
- 检索索引按「计数 + 最大行号」判过期：在别的进程里重跑分析后，服务端下一次检索会自动重建，
  不需要重启；`/api/projects/{id}/status` 的 `index_stale` 会给出当前状态；
- 社区发现跑在类级调用图上，示例工程规模小，社区粒度偏粗（3 个）；
- 关键词基线定义为整串子串匹配，只用于体现检索差距。

## 自检

```bash
cd demo/backend
python -c "from app import db, services; from app.core import pipeline; db.init(); \
print(services.overview(1)['metrics'])"
```
