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
3. 「文档生成」里可生成接口文档 / 用户手册 / 项目报告：三类文档做成标签页，左侧按正文 `h2`
   自动生成目录（点击在预览框内平滑滚动并高亮），右侧是独立滚动的正文，可导出 Markdown。
4. 每页底部有状态页脚（工程、引擎、分析状态），右侧「打印 / 导出 PDF」走浏览器打印样式：
   隐藏顶栏与按钮、展开所有折叠块、正文允许跨页，适合直接交报告。

完整的模块划分、数据模型与「毕设简介逐条对照」见 [docs/系统框架设计.md](docs/系统框架设计.md)；分析过程的声明与独创性论证见 [docs/分析过程与独创性.md](docs/分析过程与独创性.md)（源头 `docs/analysis-pipeline.yaml`，二维流水线图由 `scripts/render_pipeline.py` 生成）。

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
| GET | `/api/projects/{pid}/architecture` | 分层组件、层间依赖矩阵、组件—功能映射、关键路径（含链上外部依赖与 Feign 远程终点）、外部依赖汇总 |
| GET | `/api/projects/{pid}/compare` | 模块度、NMI、检索评测 |
| GET | `/api/projects/{pid}/search?q=&mode=&k=` | `mode=bm25\|keyword\|vector\|fusion` |
| GET | `/api/projects/{pid}/graph?op=callers\|callees\|path&class=&from=&to=` | 知识库图查询：谁调用它 / 它调用谁 / 两类间最短调用链 |
| GET | `/api/projects/{pid}/impact/{class_id}?method=` | 变更影响：类 → 模块 → 功能；给 `method` 时先只看该方法的调用方 |
| GET | `/api/projects/{pid}/documents` | 文档列表 |
| GET | `/api/projects/{pid}/documents/{doc_id}` | 单篇（`html` 为渲染结果） |
| GET | `/api/projects/{pid}/documents/{doc_id}/export` | 导出 Markdown 附件 |
| POST | `/api/projects/{pid}/documents/{kind}` | 生成 `api\|manual\|report` |
| POST | `/api/projects/upload-files` | 上传一个文件夹（form: `files[]` + `paths` JSON + `name` + `engine`），按相对路径落盘后建工程 |
| GET | `/api/projects/{pid}/files` | 工程源码文件清单（`path/package/loc/category`），供「工程管理」逐个下载 |
| GET | `/api/projects/{pid}/files/{file_id}/download` | 下载单个源文件（Joern 工程按 `projects.root` 回读磁盘） |
| GET | `/api/projects/{pid}/export.zip?sub=` | 把整个工程（或 `sub` 子目录）打成 zip，`X-File-Count` 给出文件数 |
| GET | `/api/fs/list?path=` | 只读列服务器目录，供「接入新工程 → 本地目录」逐级浏览 |

## 示例工程的指标（minishop）

20 个类、90 个方法、70 个可解析调用点；内置 `pom.xml`，因此识别为 maven 工程，
1 个测试文件不计入分析、1 个配置文件计入分类。Louvain 得到 3 个社区，模块度 Q=0.533，
与包结构划分的 NMI=0.135（包结构模块度 −0.226），平均内聚 0.571；功能树 3 个一级模块、20 条二级功能；
层间依赖矩阵 6×6、入口关键路径 3 条（4/3/3 跳，按边数计）；属性图 246 节点 / 372 边（AST 156、CALL 70、CFG 88、CDG 21、DDG 7、REF 30）；
检索 Recall@5：融合 100%、向量 85%、BM25 70%、整串关键词 45%（20 条功能条目查询）。

## 大示例：SpringBlade（engine=joern）

`demo/samples/springblade` 取自 Gitee 上的 SpringBlade（GitHub 不可达时代替），253 个 Java 类、8 个测试文件、
90 个配置文件，`engine=joern` 分析约 85 秒（含 `joern-parse` 与本地 CPGQL 服务启动）。结果：

| 项目 | 数值 |
| --- | --- |
| 类 / 方法 / 调用点 | 253 / 933 / 4289 |
| 属性图 | 38397 节点 / 68141 边（AST 34860、CALL 4434、CFG 12672、CDG 2738、DDG 9120、REF 4317） |
| 社区 | 16 个（同名主语归并后），Q=0.355，包结构模块度 −0.05，NMI=0.646，内聚 0.204；类依赖边 192 条 |
| 功能树 | 16 个一级模块、60 条二级功能 |
| 检索 Recall@5 | 融合 63.3%、关键词 31.7%、BM25 31.7%、向量 28.3%（60 条查询） |

对比自研解析器（同一工程、`engine=self`）：253 类 / 420 方法（Lombok 与注解方法解析不全）、
属性图 1902 节点 / 5188 边——这也是把 Joern 作为默认大工程引擎的原因。

> 说明：60 条查询是按「方法名 + 中文别名」构造的中文查询，合成分母较小，数值用于同工程内的横向量比较，
> 不代表对外部数据的绝对效果。关键词通道在这类查询上偏高（31.7%）——证据串里常直接含类名，子串命中容易；
> 融合通道把 BM25、LSA 向量与调用图邻居一起用，达到 63.3%。换成人写的口语提问，关键词通道会明显掉下去。
> minishop 那组查询（20 条）里融合 100%、向量 85%、BM25 70%、关键词 45%，可以对照看。

## 前端交互（大工程可读性）

视觉参考 [bladex.cn](https://bladex.cn/) 的落地页语言：近白底 + 点阵网格、1px 细边框、圆角 6px，
主色 `#0074c9`（配 `#24a8d8` 渐变），眉标用等宽小字（`01 · 总览`），主按钮黑底白字（`#0d0d0d`），
表格表头与 HUD 文本走等宽大写字母间距；顶栏右侧是 `ENGINE / SYNC` 的仪表式状态，总览右上角
还有一块 `CPG · EDGES · MODULES · RECOVERY` 的虚线引导文本块。窄屏（≤960px）顶栏折成两行、
导航横向滚动，≤640px 收掉模块表的「包含的类」列。
以 SpringBlade 为规模样本（253 文件 / 933 方法 / 16 模块 / 60 条功能）打磨过一轮：

- **三种接入方式（不跳页）**：顶部「接入新工程」打开弹窗，三个 tab —— Git 仓库（`https://…/repo.git`）、
  本地目录（填服务器路径，或「浏览目录」逐级选、或「上传本地文件夹」直接传整个目录）、压缩包（拖放或选择）；
  提交后关弹窗、切到新工程并自动开始分析，全程留在当前页。
- **工程管理**：顶部「工程管理」弹窗里列出所有工程（状态、类/方法规模、切换、下载 zip、删除），
  下方是当前工程的 252 个源文件，可逐个「下载」，也可「下载整个工程 zip」（`export.zip`）。
- **四页图谱（可下钻）**：代码结构 / 功能需求 / 系统架构 / 变更影响每页右上角有「图谱 / 列表」切换；
  配色与面板结构参考 [Qiuner/birdview](https://github.com/Qiuner/birdview) 与本地项目 `D:\Projects\Software-TransSpect`
  （`prototype.css` 的浅/深两套 token、`VIEW MATRIX` 式左栏、右侧检查器与代码框），图谱跟随页面主题；
  - 代码结构：矩形树（模块 → 包 → 文件，面积按 loc），点色块下钻、面包屑回退，右侧检查器给类/方法/字段与「在列表里定位」「下载该文件」；
  - 功能需求：模块 → 功能条目树图，点条目给说明、证据方法与「在代码结构里定位」「按证据检索」；
  - 系统架构：五列（接入/业务/数据/领域/公共）组件图 + 依赖曲线 + 外部依赖行，横向滚动保持可读，点组件给分层、规模、依赖、类 chips 与承载功能；
  - 变更影响：以起点为圆心的同心圆（1 跳 / 2 跳…），按层着色，点节点看所属模块、跳数并跳回代码结构。
- **代码结构**：按「模块 → 包目录 → 文件 → 类 → 方法」两级折叠，默认全部收起，页面从 ~12000px 降到 6 行模块；
  顶部过滤框支持按路径、包名、类名实时筛选（命中时自动展开），并有展开/折叠全部。
- **功能需求**：模块级折叠 + 过滤框（匹配功能名、说明、证据方法），顶部显示「N 个模块 · 显示 M 条」。
- **总览**：首屏是一句 hero（「把遗留 Java 代码，还原成<b>需求与架构</b>。」，关键词走蓝青渐变），
  右边是 `CPG / EDGES / MODULES / RECOVERY` 的等宽 HUD；模块表的类 chip 默认只显示 8 个，其余折叠为 `+N`，点一下就地展开。
- **语义检索**：左列表右详情——点一条看完整签名、所属模块与证据片段，详情里可直接「看调用方 / 看被调方」
  跳到下方调用链查询；顶部显示命中条数与当前模式，提供「登录 / 订单 / 菜单 / 令牌 / 用户 / 租户」快捷查询；
  未输入时按工程规模给默认查询（小工程「加入购物车」、大工程「登录」）。
- **系统架构**：分层组件在上，层间依赖矩阵与组件—功能对齐收进两个折叠块，页面高度减半；组件里的类 chip
  默认显示 8 个，其余折成 `+N` 就地展开；「外部依赖」区块把缓存、消息、对象存储、数据访问库按类型与调用次数列出。
- **变更影响**：起点可选类或**方法**——选方法时只从该方法的调用方开始扩散；页面上是四个大数字
  （受影响类 / 波及模块 / 涉及功能 / 最大跳数）、按跳数分栏的扩散视图，以及从最深目标回溯出的示例影响链。
- **交叉跳转**：功能条目名、影响页的类名、检索详情的类名都可点，跳到结构页并自动过滤、展开、滚动定位到那个类
  （`#/structure?focus=Class.method`，类行高亮 2 秒）。
- **失败重试**：视图加载出错时给「重试」（只重跑当前视图）与「刷新页面」两个选项。
- **键盘**：`/` 聚焦当前页的过滤框或搜索框，`Esc` 清空。
- **对比页**：「复制为 Markdown」把两张指标表生成 Markdown，便于直接粘进论文；
  每次分析会把指标写进 `metrics_history`，页头显示「本次 vs 上次」的时间与变化量（▲/▼）。
- **文档页**：目录每节带勾选框，可「导出所选章节」（客户端按 `## ` 切分整篇 Markdown 再拼回）；
  另有「整篇 Markdown」直连后端导出。
- **明暗主题**：顶栏右侧按钮切换，默认跟随系统 `prefers-color-scheme`，选择存进 `localStorage`。
- **打印 / 导出 PDF**：页脚按钮，打印前自动展开所有折叠块，打印样式隐藏顶栏、按钮与标签栏。
- **空状态**：没有任何工程时给三张接入卡片（本地目录 / 上传 zip / Git 克隆）。


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
  别名补全，检索指标因此比带 javadoc 的工程低（60 条查询：融合 63.3%、关键词 31.7%、向量 31.7%、BM25 31.7%）；
- 外部依赖按包名/类名的整段前缀归类（缓存、消息、对象存储、数据访问等），是启发式规则，
  第三方通用库会被归到「数据访问」或直接忽略；工具类（`*Util/*Utils/*Helper/*Constant`）下的方法
  不计入功能条目，因此工具类的方法不会出现在功能树里；
- Git 接入是「克隆 / 拉取」级别的增量，不做提交级差分；
- 检索索引按「计数 + 最大行号」判过期：在别的进程里重跑分析后，服务端下一次检索会自动重建，
  不需要重启；`/api/projects/{id}/status` 的 `index_stale` 会给出当前状态；
- 社区发现跑在类级调用图上，示例工程规模小，社区粒度偏粗（3 个）；
- 关键词基线定义为整串子串匹配，只用于体现检索差距；
- 「本地目录」浏览只列**服务器进程可读**的路径（`/api/fs/list` 只读、跳过点开头项、最多 500 条）；
  「上传本地文件夹」把文件按相对路径传到 `demo/data/uploads/`，会占用磁盘，单个文件没有大小上限；
- 单文件下载与 zip 导出：自研引擎的工程用库里存的 `files.content`，Joern 工程库里没存内容，
  按 `projects.root + path` 回读磁盘（换机器或删源码后下载会失败）；
- 图谱用原生 DOM/SVG 绘制，节点数超过千级时（例如把整个 SpringBlade 一次展开）会明显变卡，
  所以结构图谱是逐层下钻、不是一次性画完。

## 自检

```bash
cd demo/backend
python -c "from app import db, services; from app.core import pipeline; db.init(); \
print(services.overview(1)['metrics'])"
```
