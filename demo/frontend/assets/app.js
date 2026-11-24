/* AI 赋能的软件逆向工程系统 demo — 前端（原生 JS，无构建步骤）
 * 数据全部来自 /api/*，页面只做展示与交互。
 */
'use strict';

const state = {
  pid: Number(localStorage.getItem('pid') || 0),
  projects: [],
  poll: null,
  search: { q: '', mode: 'fusion' },
  graph: { op: 'callers', cls: 0, from: '', to: '' },
  impactClass: 0,
  docId: 0,
  docKind: '',
  searchSel: 0,
};

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');

/* ------------------------------------------------------------------ 基础工具 */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const fmt = (v, digits = 3) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(digits))) : String(v);
};

function metricValue(m) {
  const key = m.key || '';
  const value = Number(m.value);
  if (!Number.isFinite(value)) return '—';
  if (key.startsWith('recall')) return `${(value * 100).toFixed(1)}%`;
  if (key.includes('modularity') || key === 'nmi' || key === 'cohesion' || key === 'modularity') {
    return value.toFixed(3);
  }
  return String(Math.round(value));
}

/** 评测表用：召回类指标按百分比显示，其余按三位小数。 */
const pct = (v) => `${(Number(v) * 100).toFixed(1)}%`;
const metricText = (m) => ((m.key || '').startsWith('recall') ? pct(m.value) : fmt(m.value, 3));

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { detail: text }; }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || res.statusText;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data;
}

function toast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

const VIEW_LABELS = {
  overview: '总览', structure: '代码结构', functions: '功能需求', architecture: '系统架构',
  search: '语义检索', impact: '变更影响', compare: '评测对比', docs: '文档生成',
};

function view(name) {
  $nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.view === name));
}

function currentRoute() {
  const raw = (location.hash || '#/overview').replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  return { name: name || 'overview', rest };
}

/* ------------------------------------------------------------------ 项目选择 */
async function loadProjects() {
  const data = await api('/api/projects');
  state.projects = data.projects || [];
  if (!state.projects.some((p) => p.id === state.pid)) {
    state.pid = state.projects.length ? state.projects[0].id : 0;
  }
  if (state.pid) localStorage.setItem('pid', state.pid);
}

function shell(body) {
  return `
    <div class="project-bar">
      <label>当前工程
        <select id="pid-select">${state.projects.map((p) =>
          `<option value="${p.id}" ${p.id === state.pid ? 'selected' : ''}>${esc(p.name)}（${STATUS_LABEL[p.status] || p.status}）</option>`
        ).join('')}</select>
      </label>
      <button class="ghost" id="btn-new">接入新工程</button>
      <button class="ghost" id="btn-upload">上传 zip</button>
      ${state.pid ? `<button class="primary" id="btn-analyze">重新分析</button>` : ''}
      <div id="progress" class="progress" hidden><div class="bar"></div><span></span></div>
    </div>
    <div class="content">${body}</div>`;
}

function bindProjectBar(rerender) {
  const sel = document.getElementById('pid-select');
  if (sel) sel.onchange = (e) => {
    stopPolling();
    state.pid = Number(e.target.value);
    localStorage.setItem('pid', state.pid);
    rerender();
  };
  const nw = document.getElementById('btn-new');
  if (nw) nw.onclick = () => showNewProjectForm(rerender);
  const up = document.getElementById('btn-upload');
  if (up) up.onclick = () => pickZip(rerender);
  const an = document.getElementById('btn-analyze');
  if (an) an.onclick = () => startAnalyze(state.pid, rerender);
}

/* ------------------------------------------------------------------ 分析进度 */
function stopPolling() {
  if (state.poll) { clearInterval(state.poll); state.poll = null; }
}

function showProgress(s) {
  const box = document.getElementById('progress');
  if (!box) return;
  if (!s || (!s.running && s.status !== 'failed')) { box.hidden = true; return; }
  box.hidden = false;
  box.querySelector('.bar').style.width = `${s.percent || 0}%`;
  box.querySelector('span').textContent = s.error ? '分析失败' : `${s.percent || 0}% · ${s.step || s.status}`;
  box.classList.toggle('failed', s.status === 'failed');
}

async function startAnalyze(pid, rerender) {
  try {
    await api(`/api/projects/${pid}/analyze`, { method: 'POST' });
  } catch (err) {
    toast(err.message);
    return;
  }
  toast('已开始分析…');
  stopPolling();
  state.poll = setInterval(async () => {
    try {
      const s = await api(`/api/projects/${pid}/status`);
      showProgress(s);
      if (!s.running) {
        stopPolling();
        await loadProjects();
        rerender();
        toast(s.status === 'failed' ? `分析失败：${s.error}`
          : '分析完成；检索索引已刷新');
      }
    } catch (err) {
      stopPolling();
      toast(err.message);
    }
  }, 700);
}

/* ------------------------------------------------------------------ 接入工程 */
function showNewProjectForm(rerender) {
  const body = `
    <h1>接入新工程</h1>
    <p class="muted">三种接入方式：填服务器上的 Java 目录，或填 Git 地址由后端克隆；也可以直接上传 zip。</p>
    <div class="panel form-panel">
      <label>项目名称<input id="f-name" placeholder="如 minishop"></label>
      <label>服务器目录<input id="f-root" placeholder="D:\\...\\demo\\samples\\minishop"></label>
      <label>Git 地址（填了它就不用填目录）<input id="f-git" placeholder="https://github.com/owner/repo.git"></label>
      <label>解析引擎
        <select id="f-engine">
          <option value="self">自研解析器（零依赖，秒级）</option>
          <option value="joern">Joern CPG（真 CPG，首次解析较慢）</option>
        </select>
      </label>
      <button class="primary" id="f-submit">开始分析</button>
    </div>`;
  $app.innerHTML = body;
  document.getElementById('f-submit').onclick = async () => {
    const name = document.getElementById('f-name').value.trim();
    const root = document.getElementById('f-root').value.trim();
    const gitUrl = document.getElementById('f-git').value.trim();
    const engine = document.getElementById('f-engine').value;
    if (!gitUrl && (!name || !root)) { toast('填 Git 地址，或填名称与目录'); return; }
    try {
      const data = await api('/api/projects', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, root, git_url: gitUrl, engine }),
      });
      state.pid = data.id;
      localStorage.setItem('pid', state.pid);
      await loadProjects();
      startAnalyze(state.pid, rerender);
      rerender();
    } catch (err) { toast(err.message); }
  };
}

function pickZip(rerender) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', file.name.replace(/\.zip$/i, ''));
    toast('上传中…');
    try {
      const data = await api('/api/projects/upload', { method: 'POST', body: fd });
      state.pid = data.id;
      localStorage.setItem('pid', state.pid);
      await loadProjects();
      startAnalyze(state.pid, rerender);
      rerender();
    } catch (err) { toast(err.message); }
  };
  input.click();
}

/* ------------------------------------------------------------------ 视图：总览 */
function projectMeta(p) {
  const langs = Object.entries(p.languages || {}).slice(0, 3)
    .map(([ext, info]) => `${esc(ext)} ${info.files}`).join(' · ');
  const items = [
    p.build_tool && p.build_tool !== 'none' ? `构建方式 ${esc(p.build_tool)}` : '未识别构建文件',
    p.test_count ? `测试文件 ${p.test_count}` : '',
    p.config_count ? `配置文件 ${p.config_count}` : '',
    langs ? `语言构成 ${langs}` : '',
    p.graph_nodes ? `属性图 ${p.graph_nodes} 节点 / ${p.graph_edges} 边` : '',
    `解析引擎 ${(p.engine === 'joern') ? 'Joern CPG' : '自研解析器'}`,
  ].filter(Boolean);
  return `<p class="meta">${items.map((x) => `<span>${x}</span>`).join('')}</p>`;
}

async function renderOverview() {
  const data = await api(`/api/projects/${state.pid}/overview`);
  const p = data.project;
  // 首屏只留四个能一眼说清规模的大数；其余指标降级成一行等宽小字
  const HEADLINE = ['classes', 'methods', 'modules'];
  const bigNums = [
    { v: p.class_count, label: '类 / 接口', note: '源码中的 class / interface 声明' },
    { v: p.method_count, label: '方法', note: '含私有方法与访问器' },
    { v: data.modules.length, label: '功能模块', note: 'Louvain 在调用图上的划分' },
    { v: data.function_count, label: '功能条目', note: '可核对到方法的原子功能' },
  ].map((x) => `<div><b>${fmt(x.v, 0)}</b><span>${esc(x.label)}</span><em>${esc(x.note)}</em></div>`).join('');
  const restMetrics = data.metrics.filter((m) => !HEADLINE.includes(m.key));
  const strip = restMetrics.map((m) =>
    `<span>${esc(m.label)} <b>${metricValue(m)}</b></span>`).join('');
  const classChips = (list, limit = 6) => {
    const shown = list.slice(0, limit);
    const rest = list.length - shown.length;
    return shown.map((c) => `<span class="chip">${esc(c.name)}</span>`).join('') +
      (rest > 0 ? `<span class="chip more" data-more="${list.slice(shown.length).map((c) => esc(c.name)).join('|')}">+${rest}</span>` : '');
  };
  // 模块卡片：参考页的产品区是卡片网格，比 12 行长表格更好扫
  const cards = data.modules.map((m) => `
    <article class="mod-card">
      <div class="mod-head">
        <a href="#/functions" title="${esc(m.name)}">${esc(m.name)}</a>
        <span class="chip soft">${m.size} 类 · ${m.method_count} 方法</span>
      </div>
      <p class="mod-meta">内聚度 ${Number(m.cohesion || 0).toFixed(3)}</p>
      <div class="classes">${classChips(m.classes)}</div>
    </article>`).join('');
  const body = `
    <section class="hero">
      <div class="hero-left">
        <p class="hero-kicker">PROJECT · ${esc(p.name)}</p>
        <h1 class="hero-title">把遗留 Java 代码，<br>还原成<span class="grad">需求与架构</span>。</h1>
        <p class="hero-sub">结构事实保证每条结论都能回到源文件与行号，语义归纳补上「这段代码在实现什么」。
          六模块从仓库接入一路走到接口文档、用户手册与完整报告。</p>
        <div class="hero-meta">${projectMeta(p)}</div>
      </div>
      <div class="hud-block">
        <div><span>CPG</span><i></i><b>${p.graph_nodes ? `${p.graph_nodes} nodes` : 'not exported'}</b></div>
        <div><span>EDGES</span><i></i><b>${p.graph_edges ? `${p.graph_edges} edges` : '—'}</b></div>
        <div><span>MODULES</span><i></i><b>${data.modules.length} groups</b></div>
        <div><span>RECOVERY</span><i></i><b>${data.function_count} leaves</b></div>
      </div>
    </section>
    <div class="numbers">${bigNums}</div>
    <p class="metrics-strip">${strip}</p>
    <h2>模块划分</h2>
    <div class="module-grid">${cards || '<p class="muted">还没有分析结果</p>'}</div>
    <div class="two">
      <div><h2>产物</h2>
        <p>已恢复功能条目 <b>${data.function_count}</b> 条；已生成文档 <b>${data.document_count}</b> 份。</p>
        <p><a class="btn" href="#/functions">查看功能树</a>
           <a class="btn" href="#/docs">生成文档</a></p></div>
      <div><h2>怎么读这个系统</h2>
        <ul class="plain">
          <li>「代码结构」看解析出的类、方法与调用点</li>
          <li>「语义检索」用自然语言定位实现位置</li>
          <li>「变更影响」看改一个类会波及哪些功能</li>
          <li>「评测对比」看模块度、NMI 与检索召回</li>
        </ul></div>
    </div>`;
  draw(body);

  // 类 chip 折叠：点 +N 就地展开，避免 60 多个类把卡片撑高
  document.querySelectorAll('.module-grid .chip.more').forEach((el) => {
    el.onclick = () => {
      const names = (el.dataset.more || '').split('|').filter(Boolean);
      el.insertAdjacentHTML('beforebegin', names.map((n) => `<span class="chip">${esc(n)}</span>`).join(''));
      el.remove();
    };
  });
}

/* ------------------------------------------------------------------ 视图：结构 */
const STRUCT = { query: '' };

/** 按目录（包）分组；带过滤时只保留命中的文件/类。 */
function structureGroups(data, query) {
  const needle = (query || '').trim().toLowerCase();
  const groups = new Map();
  data.files.forEach((file) => {
    const classes = file.classes || [];
    const path = String(file.path || '').replace(/\\/g, '/');
    if (needle) {
      const haystack = [path, file.package || '', ...classes.map((c) => c.name)]
        .join(' ').toLowerCase();
      if (!haystack.includes(needle)) return;
    }
    const cut = path.lastIndexOf('/');
    const dir = cut > 0 ? path.slice(0, cut) : '（根目录）';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push({ ...file, path });
  });
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

const NON_MODULE_DIRS = new Set(['src', 'com', 'org', 'cn', 'net', 'io', 'java', 'main']);

/** 目录标签：保留模块名 + 末两段包名，避免满屏 controller 分不清来源。 */
function groupLabel(dir) {
  if (dir === '（根目录）') return dir;
  const parts = dir.split('/').filter(Boolean);
  const tail = parts.slice(-2).join('/');
  const head = parts[0] || '';
  if (!head || NON_MODULE_DIRS.has(head.toLowerCase())) return tail;
  return head === tail.split('/')[0] ? tail : `${head} / ${tail}`;
}

function methodItem(m) {
  const facts = [
    m.branches ? `<span class="chip soft">分支 ${m.branches}</span>` : '',
    m.loops ? `<span class="chip soft">循环 ${m.loops}</span>` : '',
    m.catches ? `<span class="chip soft">捕获 ${m.catches}</span>` : '',
  ].join('');
  const calls = (m.calls || []).slice(0, 4).map((x) =>
    `<span class="chip ${x.resolved ? '' : 'warn'}">→ ${esc(x.qualifier ? x.qualifier + '.' : '')}${esc(x.name)}</span>`).join('');
  return `<li><b>${esc(m.name)}</b><code>${esc(m.signature)}</code>
    <span class="muted">第 ${m.line} 行 · ${m.loc} 行</span>${facts}<span class="calls">${calls}</span></li>`;
}

function classBlock(c) {
  const methods = (c.methods || []).map(methodItem).join('');
  return `<details class="cls"><summary><b>${esc(c.name)}</b>
    <span class="badge">${esc(c.layer)}</span><span class="muted">${esc(c.kind)} · 第 ${c.line} 行</span></summary>
    <ul class="methods">${methods || '<li class="muted">无可解析方法</li>'}</ul></details>`;
}

function structureHtml(data, query, expand) {
  const groups = structureGroups(data, query);
  if (!groups.length) {
    return '<p class="muted">没有匹配的文件，换个关键词试试。</p>';
  }
  // 两级分组：模块（顶层目录）→ 包目录 → 文件 → 类
  const modules = new Map();
  groups.forEach(([dir, files]) => {
    const head = dir === '（根目录）' ? dir : dir.split('/')[0];
    const module = NON_MODULE_DIRS.has(head.toLowerCase()) ? '（主工程）' : head;
    if (!modules.has(module)) modules.set(module, []);
    modules.get(module).push([dir, files]);
  });
  const pkgHtml = ([dir, files]) => {
    const classCount = files.reduce((sum, f) => sum + (f.classes || []).length, 0);
    const body = files.map((f) => `<details class="file"><summary><b>${esc(f.path.split('/').pop())}</b>
        <span class="chip soft">${esc(f.category || '源码')}</span>
        <span class="muted">${(f.classes || []).length} 类${f.loc ? ` · ${f.loc} 行` : ''}</span></summary>
        ${(f.classes || []).map(classBlock).join('') || '<p class="muted">没有解析到类</p>'}</details>`).join('');
    return `<details class="pkg" ${expand ? 'open' : ''} title="${esc(dir)}">
      <summary><b>${esc(groupLabel(dir))}</b>
        <span class="muted">${files.length} 个文件 · ${classCount} 个类</span></summary>
      <div class="pkg-body">${body}</div></details>`;
  };
  return [...modules.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([module, pkgs]) => {
      const files = pkgs.reduce((sum, [, list]) => sum + list.length, 0);
      const classes = pkgs.reduce((sum, [, list]) => sum
        + list.reduce((n, f) => n + (f.classes || []).length, 0), 0);
      return `<details class="mod" ${expand ? 'open' : ''}>
        <summary><b>${esc(module)}</b>
          <span class="muted">${pkgs.length} 个包 · ${files} 个文件 · ${classes} 个类</span></summary>
        <div class="mod-body">${pkgs.map(pkgHtml).join('')}</div></details>`;
    }).join('');
}

async function renderStructure() {
  const data = await api(`/api/projects/${state.pid}/structure`);
  const graph = data.graph || {};
  const graphLine = graph.nodes
    ? `属性图：${graph.nodes} 节点 / ${graph.edges} 边` +
      (Object.keys(graph.by_type || {}).length
        ? `（${Object.entries(graph.by_type).map(([k, v]) => `${k.replace('cpg_', '').toUpperCase()} ${v}`).join(' · ')}）`
        : '')
    : '';
  draw(`
    <section class="head"><div><h1>代码结构</h1>
      <p class="muted">源码解析结果：${data.classes_total} 个类、${data.methods_total} 个方法、${data.calls_total} 个调用点。
      按目录分组，点开目录 → 文件 → 类 → 方法逐层钻取。</p>
      ${graphLine ? `<p class="meta"><span>${graphLine}</span></p>` : ''}</div></section>
    <div class="toolbar">
      <input id="struct-q" class="grow" value="${esc(STRUCT.query)}"
        placeholder="按路径、包名或类名过滤，例如 controller、User、OrderService">
      <button class="ghost" id="struct-reset">清空</button>
      <button class="ghost" id="struct-open">展开全部</button>
      <button class="ghost" id="struct-close">折叠全部</button>
      <span class="muted" id="struct-count"></span>
    </div>
    <div class="files" id="struct-files"></div>`);

  const box = document.getElementById('struct-files');
  const counter = document.getElementById('struct-count');
  const paint = () => {
    const groups = structureGroups(data, STRUCT.query);
    const files = groups.reduce((sum, [, list]) => sum + list.length, 0);
    const classes = groups.reduce((sum, [, list]) => sum
      + list.reduce((n, f) => n + (f.classes || []).length, 0), 0);
    counter.textContent = `${groups.length} 个目录 · ${files} 个文件 · ${classes} 个类`;
    box.innerHTML = structureHtml(data, STRUCT.query, Boolean(STRUCT.query.trim()));
  };
  paint();

  const input = document.getElementById('struct-q');
  input.oninput = () => {
    STRUCT.query = input.value;
    paint();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };
  document.getElementById('struct-reset').onclick = () => {
    STRUCT.query = '';
    input.value = '';
    paint();
    input.focus();
  };
  const toggleAll = (open) => box.querySelectorAll('details.mod, details.pkg').forEach((el) => { el.open = open; });
  document.getElementById('struct-open').onclick = () => toggleAll(true);
  document.getElementById('struct-close').onclick = () => toggleAll(false);
}

/* ------------------------------------------------------------------ 视图：功能 */
/**
 * 功能条目：说明里通常已含「入口 Class.method」，重复的证据不再单独占一行，
 * 避免两列网格被第三个单元格挤成锯齿。
 */
function functionItem(c) {
  const summary = c.summary || '';
  const evidence = (c.evidence || '').trim();
  const extra = evidence && !summary.includes(evidence) ? evidence : '';
  return `<li><b>${esc(c.name)}</b><span class="ev">${esc(summary)}</span>` +
    (extra ? `<span class="origin">${esc(extra)}</span>` : '') + '</li>';
}

const FUNCS = { query: '' };

function functionPanel(root, needle) {
  const children = (root.children || []).filter((c) => {
    if (!needle) return true;
    const haystack = [c.name, c.summary || '', c.evidence || ''].join(' ').toLowerCase();
    return haystack.includes(needle);
  });
  if (!children.length) return '';
  return `<details class="panel fn" ${needle ? 'open' : ''}>
    <summary><b>${esc(root.name)}</b><span class="muted">${children.length} 条</span></summary>
    <ul class="tree">${children.map(functionItem).join('')}</ul></details>`;
}

async function renderFunctions() {
  const data = await api(`/api/projects/${state.pid}/functions`);
  draw(`
    <section class="head"><div><h1>功能需求恢复</h1>
      <p class="muted">一级为模块功能，二级为可核对到方法的原子功能；每条都标了实现位置。</p></div>
      <span class="badge ok">${data.leaf_count} 条</span></section>
    <div class="toolbar">
      <input id="fn-q" class="grow" value="${esc(FUNCS.query)}"
        placeholder="按功能名、说明或证据方法过滤，例如 登录、订单、UserController">
      <button class="ghost" id="fn-reset">清空</button>
      <button class="ghost" id="fn-open">展开全部</button>
      <button class="ghost" id="fn-close">折叠全部</button>
      <span class="muted" id="fn-count"></span>
    </div>
    <div id="fn-list"></div>`);

  const box = document.getElementById('fn-list');
  const counter = document.getElementById('fn-count');
  const paint = () => {
    const needle = FUNCS.query.trim().toLowerCase();
    const panels = data.tree.map((root) => functionPanel(root, needle)).filter(Boolean).join('');
    const shown = needle
      ? data.tree.reduce((sum, root) => sum + (root.children || []).filter((c) =>
          [c.name, c.summary || '', c.evidence || ''].join(' ').toLowerCase().includes(needle)).length, 0)
      : data.leaf_count;
    counter.textContent = `${data.tree.length} 个模块 · 显示 ${shown} 条`;
    box.innerHTML = panels || '<p class="muted">没有匹配的功能条目，换个关键词试试。</p>';
  };
  paint();

  const input = document.getElementById('fn-q');
  input.oninput = () => {
    FUNCS.query = input.value;
    paint();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };
  document.getElementById('fn-reset').onclick = () => {
    FUNCS.query = '';
    input.value = '';
    paint();
    input.focus();
  };
  const toggleAll = (open) => box.querySelectorAll('details.fn').forEach((el) => { el.open = open; });
  document.getElementById('fn-open').onclick = () => toggleAll(true);
  document.getElementById('fn-close').onclick = () => toggleAll(false);
}

/* ------------------------------------------------------------------ 视图：架构 */
async function renderArchitecture() {
  const data = await api(`/api/projects/${state.pid}/architecture`);
  const chipList = (list, limit = 8) => {
    const shown = list.slice(0, limit);
    const rest = list.slice(shown.length);
    return shown.map((x) => `<span class="chip">${esc(x)}</span>`).join('') +
      (rest.length ? `<span class="chip more" data-more="${rest.map(esc).join('|')}">+${rest.length}</span>` : '');
  };
  const cols = data.layers.map((layer) => `
    <div class="layer">
      <h4>${esc(layer.name)}</h4>
      ${layer.components.map((c) => `
        <div class="comp">
          <b>${esc(c.name)}</b><small>${c.classes.length} 类</small>
          <p class="classes">${chipList(c.classes)}</p>
          <p class="dep">${c.depends_on.length ? '→ 依赖 ' + c.depends_on.map(esc).join('、') : '→ 最底层，无传出依赖'}</p>
        </div>`).join('')}
    </div>`).join('');

  const entries = (data.entries || []).map((chain, i) => `
    <li><span class="muted">链路 ${i + 1}</span>
      ${chain.map((node) => `<span class="chip">${esc(node.name)}</span>`).join('<span class="arrow">→</span>')}
      <span class="muted">（${chain.length} 跳，${esc(chain[chain.length - 1].layer)}）</span></li>`).join('');

  const matrix = data.matrix || { layers: [], cells: [] };
  const matrixHead = matrix.layers.map((name) => `<th>${esc(name.replace('层', ''))}</th>`).join('');
  const matrixRows = matrix.layers.map((name, i) => `
    <tr><td>${esc(name)}</td>${matrix.cells[i].map(
      (n) => `<td class="num ${n ? '' : 'zero'}">${n || '·'}</td>`).join('')}</tr>`).join('');

  const align = (data.component_functions || []).map((group) => `
    <tr><td>${esc(group.module)}</td><td>${esc(group.layer)}</td>
      <td class="classes">${group.functions.map((f) => `<span class="chip">${esc(f.name)}</span>`).join('')}</td></tr>`).join('');

  draw(`
    <section class="head"><div><h1>系统架构视图</h1>
      <p class="muted">分层组件、层间依赖、入口链路与组件—功能对齐；依赖来自类级调用图。</p></div></section>
    <h2>入口与关键路径</h2>
    <ul class="plain chains">${entries || '<li class="muted">暂无关键路径</li>'}</ul>
    <h2>分层组件</h2>
    <div class="layers">${cols || '<p class="muted">暂无架构视图</p>'}</div>
    <details class="fold">
      <summary>层间依赖矩阵 <span class="muted">${matrix.layers.length} × ${matrix.layers.length}</span></summary>
      <table class="matrix"><thead><tr><th>调用方 ↓ / 被调 ↑</th>${matrixHead}</tr></thead>
        <tbody>${matrixRows || '<tr><td class="muted">暂无数据</td></tr>'}</tbody></table>
      <p class="muted">格子里的数字是跨层的类级调用条数；对角线表示层内调用。</p>
    </details>
    <details class="fold">
      <summary>组件—功能对齐 <span class="muted">${data.component_functions.length} 组</span></summary>
      <table><thead><tr><th>组件</th><th>层</th><th>承载的功能条目</th></tr></thead>
        <tbody>${align || '<tr><td colspan="3" class="muted">暂无功能条目</td></tr>'}</tbody></table>
    </details>`);

  // 组件里的类 chip 也支持 +N 就地展开
  document.querySelectorAll('.layers .chip.more').forEach((el) => {
    el.onclick = () => {
      const names = (el.dataset.more || '').split('|').filter(Boolean);
      el.insertAdjacentHTML('beforebegin', names.map((n) => `<span class="chip">${esc(n)}</span>`).join(''));
      el.remove();
    };
  });
}

/* ------------------------------------------------------------------ 视图：检索 */
async function renderSearch() {
  const { mode } = state.search;
  const [structure, overview] = await Promise.all([
    api(`/api/projects/${state.pid}/structure`),
    api(`/api/projects/${state.pid}/overview`),
  ]);
  const moduleName = new Map((overview.modules || []).map((m) => [m.id, m.name]));
  // 没输入过就按工程规模给一个像样的默认查询：小工程找购物车，大工程找登录
  const fallback = structure.classes_total > 100 ? '登录' : '加入购物车';
  const q = state.search.q || fallback;
  state.search = { q, mode };
  const data = await api(`/api/projects/${state.pid}/search?q=${encodeURIComponent(q)}&mode=${mode}&k=10`);
  const classes = [];
  structure.files.forEach((f) => f.classes.forEach((c) => classes.push({ id: c.id, name: c.name, layer: c.layer })));
  if (!state.graph.cls && classes.length) state.graph.cls = classes[0].id;
  const options = classes.map((c) =>
    `<option value="${c.id}" ${c.id === state.graph.cls ? 'selected' : ''}>${esc(c.name)}（${esc(c.layer)}）</option>`).join('');

  const results = data.results || [];
  const sel = Math.min(state.searchSel || 0, Math.max(results.length - 1, 0));
  state.searchSel = sel;
  const rows = results.map((r, i) => `
    <li class="hit-row ${i === sel ? 'on' : ''}" data-i="${i}">
      <span class="badge">${esc(r.kind)}</span>
      <b>${esc(r.title)}</b>
      <span class="score">${fmt(r.score, 3)}</span>
      <span class="sub">${esc(r.subtitle || '')}</span>
    </li>`).join('');

  const detailHtml = (r) => {
    if (!r) return '<p class="muted">没有命中，换个说法试试。</p>';
    const p = r.payload || {};
    const rowsHtml = [
      p.class_name ? ['类', p.class_name] : null,
      p.signature ? ['签名', p.signature] : null,
      p.layer ? ['分层', p.layer] : null,
      p.module_id ? ['模块', moduleName.get(p.module_id) || `#${p.module_id}`] : null,
    ].filter(Boolean).map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join('');
    const jump = p.class_id
      ? `<button class="ghost" data-callers="${p.class_id}">看调用方</button>
         <button class="ghost" data-callees="${p.class_id}">看被调方</button>` : '';
    return `
      <p class="d-kind"><span class="badge">${esc(r.kind)}</span> <b>${esc(r.title)}</b>
        <span class="score">${fmt(r.score, 3)}</span></p>
      <p class="muted d-sub">${esc(r.subtitle || '')}</p>
      <div class="kv">${rowsHtml}</div>
      <p class="snippet">${esc(r.snippet || '')}</p>
      <div class="d-actions">${jump}</div>`;
  };
  const modeLabel = { fusion: '融合排序', bm25: 'BM25', vector: '向量', keyword: '关键词' }[mode] || mode;
  const quick = ['登录', '订单', '菜单', '令牌', '用户', '租户'];
  const quickChips = quick.map((w) =>
    `<button class="chip quick" type="button" data-q="${esc(w)}">${esc(w)}</button>`).join('');

  let graphBody = '<p class="muted">选一个类查它的调用方/被调方，或填两个类名查调用路径。</p>';
  const g = state.graph;
  if (g.op === 'path' && (g.from || g.to)) {
    if (g.from && g.to) {
      const r = await api(`/api/projects/${state.pid}/graph?op=path&from=${encodeURIComponent(g.from)}&to=${encodeURIComponent(g.to)}`);
      graphBody = r.found
        ? `<ul class="plain chains"><li>${r.path.map((n) => `<span class="chip">${esc(n.name)}</span>`).join('<span class="arrow">→</span>')}</li></ul>`
        : `<p class="muted">${esc(r.message || '两个类之间没有有向调用路径')}</p>`;
    }
  } else if (g.cls) {
    const r = await api(`/api/projects/${state.pid}/graph?op=${g.op}&class=${g.cls}`);
    const label = g.op === 'callers' ? '调用它的类' : '它调用的类';
    graphBody = r.nodes.length
      ? `<p class="muted">${esc(r.origin.name)}：${label} ${r.nodes.length} 个</p>
         <ul class="plain">${r.nodes.map((n) => `<li><span class="chip">${esc(n.name)}</span>
           <span class="muted">${esc(n.layer)}</span></li>`).join('')}</ul>`
      : `<p class="muted">${esc(r.origin.name)} 没有${label}</p>`;
  }

  draw(`
    <section class="head"><div><h1>语义检索</h1>
      <p class="muted">两条访问代码知识库的通道：自然语言检索（BM25 / 向量 / 融合）与图查询（调用链）。</p></div></section>
    <form class="searchbar" id="search-form">
      <input id="q" value="${esc(q)}" placeholder="例如：加入购物车">
      <select id="mode">
        <option value="fusion" ${mode === 'fusion' ? 'selected' : ''}>融合排序</option>
        <option value="bm25" ${mode === 'bm25' ? 'selected' : ''}>BM25 排序</option>
        <option value="vector" ${mode === 'vector' ? 'selected' : ''}>向量检索</option>
        <option value="keyword" ${mode === 'keyword' ? 'selected' : ''}>关键词基线</option>
      </select>
      <button class="primary" type="submit">检索</button>
    </form>
    <div class="hit-meta">
      <span class="muted">命中 <b>${results.length}</b> 条 · 模式 ${esc(modeLabel)}</span>
      <span class="quick">${quickChips}</span>
    </div>
    <div class="search-layout">
      <ul class="hits compact" id="hit-list">${rows || '<li class="muted">没有命中，换个说法试试</li>'}</ul>
      <aside class="hit-detail" id="hit-detail">${detailHtml(results[sel])}</aside>
    </div>

    <h2>调用链查询</h2>
    <div class="form-panel inline">
      <label>操作
        <select id="g-op">
          <option value="callers" ${g.op === 'callers' ? 'selected' : ''}>谁调用了它</option>
          <option value="callees" ${g.op === 'callees' ? 'selected' : ''}>它调用了谁</option>
          <option value="path" ${g.op === 'path' ? 'selected' : ''}>两点之间路径</option>
        </select>
      </label>
      <label>类<select id="g-cls">${options}</select></label>
      <label>从<input id="g-from" value="${esc(g.from)}" placeholder="入口类名" size="12"></label>
      <label>到<input id="g-to" value="${esc(g.to)}" placeholder="目标类名" size="12"></label>
      <button class="primary" id="g-go">查询</button>
    </div>
    ${graphBody}`);

  const form = document.getElementById('search-form');
  form.onsubmit = (e) => {
    e.preventDefault();
    state.search = { q: document.getElementById('q').value.trim() || '加入购物车', mode: document.getElementById('mode').value };
    state.searchSel = 0;
    renderSearch();
  };
  document.querySelectorAll('.hit-meta .chip.quick').forEach((el) => {
    el.onclick = () => {
      state.search = { q: el.dataset.q, mode: state.search.mode };
      state.searchSel = 0;
      renderSearch();
    };
  });

  // 左列表 / 右详情：切换只重绘右侧，不重新请求
  const list = document.getElementById('hit-list');
  const det = document.getElementById('hit-detail');
  const bindDetail = () => {
    det.querySelectorAll('[data-callers],[data-callees]').forEach((btn) => {
      btn.onclick = () => {
        const callers = btn.hasAttribute('data-callers');
        state.graph = {
          op: callers ? 'callers' : 'callees',
          cls: Number(callers ? btn.dataset.callers : btn.dataset.callees) || 0,
          from: '', to: '',
        };
        renderSearch();
      };
    });
  };
  if (list) {
    list.querySelectorAll('.hit-row').forEach((el) => {
      el.onclick = () => {
        const i = Number(el.dataset.i);
        state.searchSel = i;
        list.querySelectorAll('.hit-row').forEach((x) => x.classList.toggle('on', x === el));
        det.innerHTML = detailHtml(results[i]);
        bindDetail();
      };
    });
  }
  bindDetail();
  document.getElementById('g-go').onclick = () => {
    state.graph = {
      op: document.getElementById('g-op').value,
      cls: Number(document.getElementById('g-cls').value) || 0,
      from: document.getElementById('g-from').value.trim(),
      to: document.getElementById('g-to').value.trim(),
    };
    renderSearch();
  };
}

/* 同名功能在不同模块里可能各有一条，按名字去重后再展示 */
function uniqueFunctionChips(functions, limit = 18) {
  const seen = new Map();
  (functions || []).forEach((f) => {
    const name = String(f.name || f).trim();
    if (!seen.has(name)) seen.set(name, []);
    seen.get(name).push(f.module || '');
  });
  const names = [...seen.keys()];
  const chips = names.slice(0, limit).map((name) => {
    const mods = seen.get(name).filter(Boolean);
    const title = mods.length ? `${name} · ${[...new Set(mods)].join(' / ')}` : name;
    return `<span class="chip" title="${esc(title)}">${esc(name)}</span>`;
  }).join('');
  const rest = names.length - Math.min(names.length, limit);
  return chips + (rest > 0 ? `<span class="chip more" title="还有 ${rest} 条">+${rest}</span>` : '');
}

/* ------------------------------------------------------------------ 视图：影响 */
async function renderImpact() {
  const [data, structure] = await Promise.all([
    api(`/api/projects/${state.pid}/overview`),
    api(`/api/projects/${state.pid}/structure`),
  ]);
  const moduleName = new Map((data.modules || []).map((m) => [m.id, m.name]));
  // 起点类下拉要用全量类名：overview 里每个模块只回 12 个类
  const classes = [];
  (structure.files || []).forEach((f) => (f.classes || []).forEach((c) => classes.push({
    id: c.id, name: c.name, layer: c.layer, module: moduleName.get(c.module_id) || '',
  })));
  classes.sort((a, b) => (a.module + a.name).localeCompare(b.module + b.name, 'zh'));
  if (!state.impactClass && classes.length) {
    state.impactClass = data.project.impact_hot || classes[0].id;
  }
  const options = classes.map((c) =>
    `<option value="${c.id}" ${c.id === state.impactClass ? 'selected' : ''}>${esc(c.module)} / ${esc(c.name)}</option>`).join('');
  let result = '<p class="muted">选一个类，看改动会波及哪些模块与功能。</p>';
  if (state.impactClass) {
    const r = await api(`/api/projects/${state.pid}/impact/${state.impactClass}`);
    const hops = r.max_hop || 0;
    const byHop = Array.from({ length: hops + 1 }, () => []);
    (r.classes || []).forEach((c) => byHop[Math.min(c.hop || 0, hops)].push(c));
    const flow = `
      <div class="hop-col origin">
        <p class="hop-head">起点 · 1 个类</p>
        <div class="hop-item"><b>${esc(r.origin.name)}</b>
          <small>${esc(r.origin.layer || '')}</small></div>
      </div>` + (hops === 0
      ? '<div class="hop-col"><p class="hop-head">无调用方</p><div class="hop-item"><small>没有类调用它，改动只影响自身。</small></div></div>'
      : byHop.slice(1).map((list, i) => `
          <div class="hop-col">
            <p class="hop-head">${i + 1} 跳 · ${list.length} 个类</p>
            ${list.map((c) => `<div class="hop-item"><b>${esc(c.name)}</b>
              <small>${esc(c.layer || '')}${c.module ? ' · ' + esc(c.module) : ''}</small></div>`).join('')}
          </div>`).join(''));
    const chains = (r.chains || []).map((chain) => `
      <li class="chain">${chain.map((c, i) => `${i ? '<span class="arrow">←</span>' : ''}
        <span class="chip">${esc(c.name)}</span>`).join('')}</li>`).join('');
    result = `
      <div class="numbers tight">
        <div><b>${r.classes.length}</b><span>受影响类</span></div>
        <div><b>${r.modules.length}</b><span>波及模块</span></div>
        <div><b>${r.functions.length}</b><span>涉及功能</span></div>
        <div><b>${hops}</b><span>最大跳数</span></div>
      </div>
      <h2>影响扩散</h2>
      <div class="impact-flow">${flow}</div>
      ${chains ? `<h2>示例影响链</h2><ul class="plain chains-list">${chains}</ul>` : ''}
      <div class="two">
        <div><h2>涉及的模块</h2>
          <p class="chips">${r.modules.map((m) => `<span class="chip">${esc(m.name || m)}</span>`).join('') || '<span class="muted">无</span>'}</p></div>
        <div><h2>涉及的功能</h2>
          <p class="chips">${uniqueFunctionChips(r.functions)}</p></div>
      </div>`;
  }
  draw(`
    <section class="head"><div><h1>变更影响分析</h1>
      <p class="muted">沿调用图反向查找：改这个类，哪些类、模块与功能要一起验证。</p></div></section>
    <div class="form-panel inline"><label>起点类<select id="impact-select">${options}</select></label></div>
    ${result}`);
  const sel = document.getElementById('impact-select');
  if (sel) sel.onchange = (e) => { state.impactClass = Number(e.target.value); renderImpact(); };
}

/* ------------------------------------------------------------------ 视图：对比 */
async function renderCompare() {
  // 评测要重建检索索引；索引与库里对不上时先提示一句，避免以为数字算错了。
  const status = await api(`/api/projects/${state.pid}/status`);
  if (status.index_stale) toast('检索索引与最新分析结果不一致，正在重建…', 2000);
  const data = await api(`/api/projects/${state.pid}/compare`);
  const rows = data.metrics.map((m) => `
    <tr><td>${esc(m.label)}</td><td class="num">${metricText(m)}</td><td class="muted">${esc(m.note || '')}</td></tr>`).join('');
  const rc = data.retrieval;
  const bar = (v) => `<div class="bar-mini"><i style="width:${Math.min(100, Math.round(v * 100))}%"></i></div>`;
  draw(`
    <section class="head"><div><h1>评测对比</h1>
      <p class="muted">三处算法环节的量化结果，均可在现场复现。</p></div></section>
    <h2>结构指标</h2>
    <table><thead><tr><th>指标</th><th>数值</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>
    <h2>语义检索召回率</h2>
    <table><thead><tr><th>方案</th><th>Recall@5</th><th></th><th>说明</th></tr></thead><tbody>
      <tr><td>融合排序（本项目）</td><td class="num">${pct(rc.fusion)}</td><td>${bar(rc.fusion)}</td><td class="muted">BM25 与向量名次融合，叠加调用图邻居</td></tr>
      <tr><td>BM25</td><td class="num">${pct(rc.bm25)}</td><td>${bar(rc.bm25)}</td><td class="muted">按词频与逆文档频率排序</td></tr>
      <tr><td>向量检索</td><td class="num">${pct(rc.vector)}</td><td>${bar(rc.vector)}</td><td class="muted">词项加权向量的余弦相似度</td></tr>
      <tr><td>关键词基线</td><td class="num">${pct(rc.keyword)}</td><td>${bar(rc.keyword)}</td><td class="muted">子串匹配，作为对照</td></tr>
    </tbody></table>
    <p class="muted">评测用 ${rc.cases} 个由功能条目构造的查询，相关集合是该功能条目指到的那个方法。这类查询的证据串里往往直接含类名，
      关键词通道因此占便宜；融合的目标是「不输给任一单路」，具体谁高取决于工程与查询措辞，数值按工程实测。</p>`);
}

/* ------------------------------------------------------------------ 视图：文档 */
async function renderDocs() {
  const list = await api(`/api/projects/${state.pid}/documents`);
  const docs = list.documents || [];
  const KIND_LABEL = { api: '接口文档', manual: '用户手册', report: '分析报告' };
  // 同类多份（重新生成过）只留最新一份
  const latest = new Map();
  docs.forEach((d) => { if (!latest.has(d.kind)) latest.set(d.kind, d); });
  const kinds = ['api', 'manual', 'report'];
  if (state.docKind && latest.has(state.docKind)) {
    state.docId = latest.get(state.docKind).id;
  } else if (!docs.some((d) => d.id === state.docId)) {
    const first = [...latest.values()][0];
    state.docId = first ? first.id : 0;
    state.docKind = first ? first.kind : '';
  }
  const activeKind = (docs.find((d) => d.id === state.docId) || {}).kind || state.docKind;

  const tabs = kinds.map((k) => {
    const d = latest.get(k);
    return `<button class="tab ${k === activeKind ? 'on' : ''}" data-kind="${k}" ${d ? '' : 'data-empty="1"'}>
      ${KIND_LABEL[k]}<span class="tab-meta">${d ? esc(String(d.created_at).slice(11, 16)) : '未生成'}</span></button>`;
  }).join('');

  let preview = '<p class="muted">选一个标签页生成或查看文档。</p>';
  let toc = '';
  if (state.docId) {
    const doc = await api(`/api/projects/${state.pid}/documents/${state.docId}`);
    // 给 h2 加锚点，生成右侧目录
    const dom = new DOMParser().parseFromString(doc.html, 'text/html');
    const heads = [...dom.querySelectorAll('h2')];
    heads.forEach((h, i) => { h.id = `sec-${i}`; });
    const tocItems = heads.map((h, i) =>
      `<li><a href="#sec-${i}" data-sec="${i}">${esc(h.textContent)}</a></li>`).join('');
    toc = tocItems
      ? `<p class="rail-label">目录</p><ul class="toc">${tocItems}</ul>`
      : '<p class="muted">这份文档没有二级标题</p>';
    preview = `<div class="doc">${dom.body.innerHTML}</div>`;
  }

  draw(`
    <section class="head"><div><h1>文档生成</h1>
      <p class="muted">按代码结构生成接口文档、用户手册与分析报告；每条结论都保留源码位置。</p></div></section>
    <div class="form-panel inline">
      <button class="primary" data-gen="api">生成接口文档</button>
      <button data-gen="manual">生成用户手册</button>
      <button data-gen="report">生成分析报告</button>
    </div>
    <div class="doc-tabs">${tabs}</div>
    ${state.docId ? `<div class="doc-layout">
      <aside class="doc-rail">${toc}
        <p class="rail-label">操作</p>
        <p><a class="btn" href="/api/projects/${state.pid}/documents/${state.docId}/export">导出 Markdown</a></p>
      </aside>
      <div class="doc-wrap">${preview}</div>
    </div>` : '<p class="muted">还没有文档，先点上面的生成按钮。</p>'}`);

  document.querySelectorAll('[data-gen]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api(`/api/projects/${state.pid}/documents/${b.dataset.gen}`, { method: 'POST' });
        state.docId = r.id;
        state.docKind = b.dataset.gen;
        toast('已生成：' + r.title);
        renderDocs();
      } catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('.doc-tabs .tab').forEach((b) => {
    b.onclick = () => {
      const d = latest.get(b.dataset.kind);
      if (!d) { toast('这份文档还没生成，先点上面的生成按钮'); return; }
      state.docKind = b.dataset.kind;
      state.docId = d.id;
      renderDocs();
    };
  });
  // 目录跳转：在预览框内滚动，并高亮当前项
  const tocEl = document.querySelector('.doc-rail .toc');
  const pane = document.querySelector('.doc-wrap .doc');
  if (tocEl && pane) {
    tocEl.querySelectorAll('a').forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        const t = pane.querySelector(`#sec-${a.dataset.sec}`);
        if (t) pane.scrollTo({ top: t.offsetTop - 8, behavior: 'smooth' });
        tocEl.querySelectorAll('a').forEach((x) => x.classList.toggle('on', x === a));
      };
    });
  }
}

/* ------------------------------------------------------------------ 路由 */
const VIEWS = {
  overview: renderOverview,
  structure: renderStructure,
  functions: renderFunctions,
  architecture: renderArchitecture,
  search: renderSearch,
  impact: renderImpact,
  compare: renderCompare,
  docs: renderDocs,
};

const STATUS_LABEL = { analyzed: '已分析', running: '分析中', new: '待分析', pending: '待分析', failed: '失败' };
const VIEW_NUM = {
  overview: '01', structure: '02', functions: '03', architecture: '04',
  search: '05', impact: '06', compare: '07', docs: '08',
};

function draw(body) {
  const name = currentRoute().name in VIEW_LABELS ? currentRoute().name : 'overview';
  const eyebrow = `<p class="eyebrow"><i></i>${VIEW_NUM[name]}<span>${esc(VIEW_LABELS[name])}</span></p>`;
  $app.innerHTML = shell(eyebrow + body);
  bindProjectBar(render);
  const p = state.projects.find((x) => x.id === state.pid);
  const eng = document.getElementById('hud-engine');
  const st = document.getElementById('hud-status');
  const dot = document.querySelector('#hud .dot');
  if (p && eng && st) {
    eng.textContent = `ENGINE · ${p.engine === 'joern' ? 'JOERN 4.0' : 'SELF'}`;
    st.textContent = `SYNC · ${STATUS_LABEL[p.status] || p.status}`;
    if (dot) dot.className = `dot ${p.status === 'analyzed' ? 'ok' : ''}`;
  }
  api(`/api/projects/${state.pid}/status`).then(showProgress).catch(() => {});
}

async function render() {
  if (!state.projects.length) {
    await loadProjects();
  }
  if (!state.projects.length) {
    $app.innerHTML = shell(`
      <h1>还没有工程</h1>
      <p class="muted">先接入一个 Java 目录，或上传 zip。仓库自带示例：demo/samples/minishop。</p>
      <button class="primary" id="first-new">接入工程</button>`);
    document.getElementById('first-new').onclick = () => showNewProjectForm(render);
    return;
  }
  const route = currentRoute();
  const fn = VIEWS[route.name] || renderOverview;
  view(VIEWS[route.name] ? route.name : 'overview');
  $app.innerHTML = '<div class="loading"><span class="spinner"></span>正在加载…</div>';
  try {
    await fn();
  } catch (err) {
    $app.innerHTML = shell(`<h1>出错了</h1><p class="muted">${esc(err.message)}</p>
      <button class="primary" onclick="location.reload()">刷新</button>`);
  }
}

window.addEventListener('hashchange', render);
render();
