# AI 赋能的软件逆向工程系统

面向遗留 Java 系统的逆向工程演示系统：输入一个 Java 工程（本地目录 / zip / Git 仓库），
输出**代码结构、功能树、架构视图、语义检索、变更影响与三类文档**。
题目对应本科毕业设计《AI 赋能的软件逆向工程系统设计与实现》。

系统把「结构事实」与「语义归纳」分开：结构一侧用代码属性图（CPG）与调用图给出可核查的事实，
语义一侧用大模型（可缺省为规则）在结构约束下做命名与归纳，**每条结论都能回指到具体的类、方法、行号**。

## 目录

| 路径 | 说明 |
| --- | --- |
| [`demo/backend`](demo/backend) | FastAPI + SQLite，双解析引擎（Joern CPG / 自研解析器）、六模块流水线 |
| [`demo/frontend`](demo/frontend) | 原生 HTML/JS，八个视图：总览、代码结构、功能需求、系统架构、语义检索、变更影响、评测对比、文档生成 |
| [`demo/samples/minishop`](demo/samples/minishop) | 自带的小示例工程（20 个 Java 类，秒级跑完） |
| [`demo/docs/系统框架设计.md`](demo/docs/系统框架设计.md) | 框架设计：六模块映射、数据模型、算法接入、Joern 实装说明 |
| [`毕设简介.md`](毕设简介.md) | 课题简介（目的意义、主要工作任务、算法应用） |
| [`模块核验.md`](模块核验.md) | 简介要求 → 开题报告承诺 → demo 实现的逐条核验 |

更完整的运行说明、接口表与指标见 [`demo/README.md`](demo/README.md)。

## 快速开始

```bash
cd demo/backend
pip install -r requirements.txt
python run.py            # http://127.0.0.1:8100
```

打开页面后「接入新工程」，目录填 `demo/samples/minishop` 即可看到完整流程；
接入表单里可以选解析引擎：

- `self`：自研解析器，不需要 JDK，适合小工程与离线演示；
- `joern`：调用 Joern 生成 CPG（需 JDK 17 与 joern-cli，安装步骤见设计文档第 9 节）。

大示例用 [SpringBlade](https://gitee.com/smallc/SpringBlade)（253 个 Java 类）：

```bash
python demo/scripts/fetch_springblade.py     # 克隆到 demo/samples/springblade（不入库）
```

## 两个示例工程的结果

| 指标 | minishop（self） | SpringBlade（joern） |
| --- | --- | --- |
| 类 / 方法 / 调用点 | 20 / 90 / 70 | 253 / 933 / 4289 |
| 属性图 | 246 节点 / 372 边 | 38397 节点 / 50027 边（AST 28169、CFG 4357、CDG 2694、DDG 9120、REF 5687、CALL 4289） |
| 社区 | 3 个，Q=0.540，NMI=0.135 | 12 个，Q=0.323，NMI=0.638 |
| 功能树 | 3 个一级模块 / 20 条二级功能 | 12 个一级模块 / 83 条二级功能 |
| 检索 Recall@5 | 融合 100%、BM25 75%、向量 75%、关键词 45% | 融合 51.8%、关键词 48.2%、向量 39.8%、BM25 38.6% |

## 仓库约定

- `tools/`（Joern + JDK，约 4.2 GB）、`demo/data/`（SQLite 库与 CPG 产物）、`demo/shots/`（截图）
  都在 `.gitignore` 中，不入库；
- `demo/samples/springblade/` 是外部仓库，用 `demo/scripts/fetch_springblade.py` 拉取，许可证归原作者；
- 未配置大模型时模块命名与功能摘要走启发式规则，界面与 `/api/health` 会显示当前状态
  （环境变量 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`）。
