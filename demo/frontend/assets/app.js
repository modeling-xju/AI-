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
          `<option value="${p.id}" ${p.id === state.pid ? 'selected' : ''}>${esc(p.name)}（${p.status}）</option>`
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
  const metrics = data.metrics.map((m) => `
    <div class="stat"><b>${metricValue(m)}</b>
      <span>${esc(m.label)}</span><em>${esc(m.note || '')}</em></div>`).join('');
  const classChips = (list) => {
    const shown = list.slice(0, 8);
    const rest = list.length - shown.length;
    return shown.map((c) => `<span class="chip">${esc(c.name)}</span>`).join('') +
      (rest > 0 ? `<span class="chip more" data-more="${list.slice(shown.length).map((c) => esc(c.name)).join('|')}">+${rest}</span>` : '');
  };
  const rows = data.modules.map((m) => `
    <tr>
      <td><a href="#/functions">${esc(m.name)}</a></td>
      <td class="nowrap">${m.size} 类 / ${m.method_count} 方法</td>
      <td>${fmt(m.cohesion, 3)}</td>
      <td class="classes">${classChips(m.classes)}</td>
    </tr>`).join('');
  const body = `
    <section class="head">
      <div><h1>${esc(p.name)}</h1><p class="muted">${esc(p.root)}</p>
        ${projectMeta(p)}</div>
      <span class="badge ${p.status === 'analyzed' ? 'ok' : ''}">${esc(p.status)}</span>
    </section>
    <div class="stats">${metrics}</div>
    <h2>模块划分</h2>
    <table class="modules"><thead><tr><th>模块</th><th>规模</th><th>内聚度</th><th>包含的类</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">还没有分析结果</td></tr>'}</tbody></table>
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

  // 类 chip 折叠：点 +N 就地展开，避免 60 多个类把表格行撑高
  document.querySelectorAll('table.modules .chip.more').forEach((el) => {
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

/** 目录标签：保留模块名 + 末两段包名，避免满屏 controller 分不清来源。 */
function groupLabel(dir) {
  if (dir === '（根目录）') return dir;
  const parts = dir.split('/').filter(Boolean);
  const tail = parts.slice(-2).join('/');
  const module = parts[0];
  return module && module !== tail.split('/')[0] ? `${module} / ${tail}` : tail;
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
    const module = dir === '（根目录）' ? dir : dir.split('/')[0];
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
  const cols = data.layers.map((layer) => `
    <div class="layer">
      <h4>${esc(layer.name)}</h4>
      ${layer.components.map((c) => `
        <div class="comp">
          <b>${esc(c.name)}</b><small>${c.classes.length} 类</small>
          <p class="classes">${c.classes.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</p>
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
    <div class="layers">${cols || '<p class="muted">暂无架构视图</p>'}</div>
    <h2>层间依赖矩阵</h2>
    <table class="matrix"><thead><tr><th>调用方 ↓ / 被调 ↑</th>${matrixHead}</tr></thead>
      <tbody>${matrixRows || '<tr><td class="muted">暂无数据</td></tr>'}</tbody></table>
    <p class="muted">格子里的数字是跨层的类级调用条数；对角线表示层内调用。</p>
    <h2>组件—功能对齐</h2>
    <table class="modules"><thead><tr><th>组件</th><th>层</th><th>承载的功能条目</th></tr></thead>
      <tbody>${align || '<tr><td colspan="3" class="muted">暂无功能条目</td></tr>'}</tbody></table>`);
}

/* ------------------------------------------------------------------ 视图：检索 */
async function renderSearch() {
  const { mode } = state.search;
  const [structure] = await Promise.all([
    api(`/api/projects/${state.pid}/structure`),
  ]);
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

  const rows = data.results.map((r) => `
    <li class="hit">
      <div class="hit-head"><span class="badge">${esc(r.kind)}</span>
        <b>${esc(r.title)}</b><span class="muted">${esc(r.subtitle || '')}</span>
        <span class="score">${fmt(r.score, 3)}</span></div>
      <p class="snippet">${esc(r.snippet)}</p>
    </li>`).join('');
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
      <span class="muted">命中 <b>${data.results.length}</b> 条 · 模式 ${esc(modeLabel)}</span>
      <span class="quick">${quickChips}</span>
    </div>
    <ul class="hits">${rows || '<li class="muted">没有命中，换个说法试试</li>'}</ul>

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
    renderSearch();
  };
  document.querySelectorAll('.hit-meta .chip.quick').forEach((el) => {
    el.onclick = () => {
      state.search = { q: el.dataset.q, mode: state.search.mode };
      renderSearch();
    };
  });
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

/* ------------------------------------------------------------------ 视图：影响 */
async function renderImpact() {
  const data = await api(`/api/projects/${state.pid}/overview`);
  const classes = [];
  data.modules.forEach((m) => m.classes.forEach((c) => classes.push({ ...c, module: m.name })));
  if (!state.impactClass && classes.length) state.impactClass = classes[0].id;
  const options = classes.map((c) =>
    `<option value="${c.id}" ${c.id === state.impactClass ? 'selected' : ''}>${esc(c.module)} / ${esc(c.name)}</option>`).join('');
  let result = '<p class="muted">选一个类，看改动会波及哪些模块与功能。</p>';
  if (state.impactClass) {
    const r = await api(`/api/projects/${state.pid}/impact/${state.impactClass}`);
    result = `
      <div class="stats">
        <div class="stat"><b>${r.classes.length}</b><span>受影响类</span></div>
        <div class="stat"><b>${r.modules.length}</b><span>波及模块</span></div>
        <div class="stat"><b>${r.functions.length}</b><span>涉及功能</span></div>
      </div>
      <div class="two">
        <div><h2>受影响的类</h2><ul class="plain">${r.classes.map((x) => `<li>${esc(x.name || x)}${x.module ? ` <span class="muted">· ${esc(x.module)}</span>` : ''}</li>`).join('') || '<li class="muted">无</li>'}</ul></div>
        <div><h2>涉及的功能</h2><ul class="plain">${r.functions.map((x) => `<li>${esc(x.name || x)}</li>`).join('') || '<li class="muted">无</li>'}</ul></div>
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
    <p class="muted">评测用 ${rc.cases} 个由功能条目构造的查询，相关集合是该功能条目指到的那个方法。融合通道会先命中功能条目、再沿证据跳到方法，因此在这类查询上优势最大；换成人写提问，差距会收窄。</p>`);
}

/* ------------------------------------------------------------------ 视图：文档 */
async function renderDocs() {
  const list = await api(`/api/projects/${state.pid}/documents`);
  const items = list.documents.map((d) => `
    <li><a href="#" data-doc="${d.id}">${esc(d.title)}</a>
      <span class="muted">${esc(d.kind)} · ${esc(d.created_at)}</span></li>`).join('');
  let preview = '<p class="muted">生成或打开一份文档，正文会显示在这里。</p>';
  if (state.docId) {
    const doc = await api(`/api/projects/${state.pid}/documents/${state.docId}`);
    preview = `<div class="doc-head">
        <a class="btn" href="/api/projects/${state.pid}/documents/${state.docId}/export">导出 Markdown</a>
        <span class="muted">${esc(doc.title)} · ${esc(doc.created_at)}</span>
      </div><div class="doc">${doc.html}</div>`;
  }
  draw(`
    <section class="head"><div><h1>文档生成</h1>
      <p class="muted">按代码结构生成接口文档、用户手册与分析报告；每条结论都保留源码位置。</p></div></section>
    <div class="form-panel inline">
      <button class="primary" data-gen="api">生成接口文档</button>
      <button data-gen="manual">生成用户手册</button>
      <button data-gen="report">生成分析报告</button>
    </div>
    <div class="docs-wrap">
      <div><h2>已生成</h2><ul class="plain docs">${items || '<li class="muted">还没有文档</li>'}</ul></div>
      <div><h2>预览</h2>${preview}</div>
    </div>`);
  document.querySelectorAll('[data-gen]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api(`/api/projects/${state.pid}/documents/${b.dataset.gen}`, { method: 'POST' });
        state.docId = r.id;
        toast('已生成：' + r.title);
        renderDocs();
      } catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('[data-doc]').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      state.docId = Number(a.dataset.doc);
      renderDocs();
    };
  });
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

function draw(body) {
  $app.innerHTML = shell(body);
  bindProjectBar(render);
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
  $app.innerHTML = '<div class="loading">加载中…</div>';
  try {
    await fn();
  } catch (err) {
    $app.innerHTML = shell(`<h1>出错了</h1><p class="muted">${esc(err.message)}</p>
      <button class="primary" onclick="location.reload()">刷新</button>`);
  }
}

window.addEventListener('hashchange', render);
render();
