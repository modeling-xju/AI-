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
  nlGraph: localStorage.getItem('nlGraph') === '1',
  askQ: '',
  ask: null,
  impactClass: 0,
  impactMethod: "",
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
  const [path, search = ''] = raw.split('?');
  const [name, ...rest] = path.split('/');
  return { name: name || 'overview', rest, query: new URLSearchParams(search) };
}

/* ------------------------------------------------------------------ 项目选择 */
async function loadProjects() {
  const data = await api('/api/projects');
  state.projects = data.projects || [];
  // 分享链接里可以带 pid：`/?pid=3#/overview` 或 `#/overview?pid=3` 都认
  const hashQuery = location.hash.includes('?') ? location.hash.split('?')[1] : '';
  const wanted = Number(new URLSearchParams(location.search).get('pid')
    || new URLSearchParams(hashQuery).get('pid') || 0);
  if (wanted && state.projects.some((p) => p.id === wanted)) {
    state.pid = wanted;
  }
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
          `<option value="${p.id}" ${Number(p.id) === Number(state.pid) ? 'selected' : ''}>${esc(p.name)}（${STATUS_LABEL[p.status] || p.status}）</option>`
        ).join('')}</select>
      </label>
      <button class="ghost" id="btn-new">接入新工程</button>
      <button class="ghost" id="btn-manage">工程管理</button>
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
  if (nw) nw.onclick = () => openImport(rerender);
  const mg = document.getElementById('btn-manage');
  if (mg) mg.onclick = () => openManage(rerender);
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
/* ------------------------------------------------------------------ 弹窗：接入 / 管理 */
const $modal = document.getElementById('modal');

function openModal(html) {
  $modal.innerHTML = `<div class="modal-card">${html}</div>`;
  $modal.hidden = false;
  document.body.classList.add('modal-open');
  $modal.querySelectorAll('[data-close]').forEach((el) => { el.onclick = closeModal; });
  return $modal.querySelector('.modal-card');
}

function closeModal() {
  $modal.hidden = true;
  $modal.innerHTML = '';
  document.body.classList.remove('modal-open');
}

$modal.addEventListener('click', (event) => { if (event.target === $modal) closeModal(); });
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$modal.hidden) closeModal();
});

const ENGINE_OPTIONS = `
  <option value="self">自研解析器（零依赖，秒级）</option>
  <option value="joern">Joern CPG（真 CPG，首次解析较慢）</option>`;

function openImport(rerender) {
  const card = openModal(`
    <div class="modal-head"><h3>接入新工程</h3>
      <button class="modal-close" data-close aria-label="关闭">×</button></div>
    <p class="muted small">三种方式都留在当前页：克隆仓库、选服务器目录或上传本地文件夹、丢一个 zip。</p>
    <div class="tabs" data-tabs>
      <button data-tab="git" class="on">Git 仓库</button>
      <button data-tab="local">本地目录</button>
      <button data-tab="zip">压缩包</button>
    </div>
    <div class="form-panel">
      <div data-pane="git">
        <label>仓库地址<input id="f-git" placeholder="https://gitee.com/owner/repo.git"></label>
        <label>工程名称（留空取仓库名）<input id="f-git-name" placeholder="SpringBlade"></label>
      </div>
      <div data-pane="local" hidden>
        <label>服务器上的目录<input id="f-root" placeholder="D:\\work\\java-project"></label>
        <div class="row">
          <button class="ghost" id="f-browse">浏览目录</button>
          <button class="ghost" id="f-folder">上传本地文件夹</button>
          <span class="muted small" id="f-fs-path"></span>
        </div>
        <div class="fs-list" id="f-fs" hidden></div>
        <input type="file" id="f-files" webkitdirectory directory multiple hidden>
      </div>
      <div data-pane="zip" hidden>
        <div class="drop" id="f-drop">把 zip 拖到这里，或点击选择文件</div>
        <p class="muted small" id="f-zip-name">支持 .zip，解压后自动筛出 Java 源码。</p>
        <input type="file" id="f-zip" accept=".zip" hidden>
      </div>
      <label>解析引擎<select id="f-engine">${ENGINE_OPTIONS}</select></label>
      <div class="row" style="justify-content:flex-end; margin-top:6px">
        <button class="ghost" data-close>取消</button>
        <button class="primary" id="f-submit">开始分析</button>
      </div>
    </div>`);

  let tab = 'git';
  let zipFile = null;
  const panes = card.querySelectorAll('[data-pane]');
  card.querySelectorAll('[data-tab]').forEach((button) => {
    button.onclick = () => {
      tab = button.dataset.tab;
      card.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === button));
      panes.forEach((pane) => { pane.hidden = pane.dataset.pane !== tab; });
    };
  });

  // 服务器目录浏览
  const fsBox = card.querySelector('#f-fs');
  const fsPath = card.querySelector('#f-fs-path');
  async function browse(path, selectable) {
    try {
      const data = await api(`/api/fs/list?path=${encodeURIComponent(path || '')}`);
      fsBox.hidden = false;
      fsPath.textContent = data.path;
      const rows = [];
      if (data.parent) rows.push(`<div class="fs-row" data-path="${esc(data.parent)}"><span>..</span><span class="muted">上级</span></div>`);
      data.entries.filter((e) => e.is_dir).slice(0, 80).forEach((entry) => {
        rows.push(`<div class="fs-row" data-path="${esc(entry.path)}"><span>${esc(entry.name)}/</span>
          <span class="muted">进入</span></div>`);
      });
      if (selectable) {
        rows.unshift(`<div class="fs-row" data-pick="${esc(data.path)}"><b>用这个目录</b>
          <span class="muted">${esc(data.path)}</span></div>`);
      }
      fsBox.innerHTML = rows.join('') || '<div class="fs-row"><span class="muted">没有子目录</span></div>';
      fsBox.querySelectorAll('[data-path]').forEach((row) => {
        row.onclick = () => browse(row.dataset.path, true);
      });
      fsBox.querySelectorAll('[data-pick]').forEach((row) => {
        row.onclick = () => {
          card.querySelector('#f-root').value = row.dataset.pick;
          fsPath.textContent = row.dataset.pick;
          fsBox.hidden = true;
        };
      });
    } catch (err) { toast(err.message); }
  }
  card.querySelector('#f-browse').onclick = () => {
    browse(card.querySelector('#f-root').value.trim(), true);
  };

  // 本地文件夹上传（浏览器选目录，按相对路径传到服务器）
  const filesInput = card.querySelector('#f-files');
  card.querySelector('#f-folder').onclick = () => filesInput.click();
  filesInput.onchange = async () => {
    const files = [...filesInput.files];
    if (!files.length) return;
    const rootName = (files[0].webkitRelativePath || files[0].name).split('/')[0] || 'upload';
    const form = new FormData();
    const paths = [];
    files.forEach((file) => {
      const rel = (file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name;
      paths.push(rel);
      form.append('files', file);
    });
    form.append('paths', JSON.stringify(paths));
    form.append('name', rootName);
    form.append('engine', card.querySelector('#f-engine').value);
    toast(`上传 ${files.length} 个文件…`);
    try {
      const data = await api('/api/projects/upload-files', { method: 'POST', body: form });
      await finishCreate(data.id, rerender);
    } catch (err) { toast(err.message); }
  };

  // zip 拖放
  const drop = card.querySelector('#f-drop');
  const zipInput = card.querySelector('#f-zip');
  drop.onclick = () => zipInput.click();
  zipInput.onchange = () => {
    zipFile = zipInput.files[0] || null;
    card.querySelector('#f-zip-name').textContent = zipFile ? zipFile.name : '未选择';
  };
  ['dragover', 'dragenter'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault(); drop.classList.add('hot');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, () => drop.classList.remove('hot')));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    zipFile = file;
    card.querySelector('#f-zip-name').textContent = file.name;
  });

  card.querySelector('#f-submit').onclick = async () => {
    const engine = card.querySelector('#f-engine').value;
    try {
      if (tab === 'git') {
        const url = card.querySelector('#f-git').value.trim();
        if (!url) { toast('先填仓库地址'); return; }
        const data = await api('/api/projects', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: card.querySelector('#f-git-name').value.trim(),
            git_url: url, engine }),
        });
        await finishCreate(data.id, rerender);
        return;
      }
      if (tab === 'local') {
        const root = card.querySelector('#f-root').value.trim();
        if (!root) { toast('填目录，或点「浏览目录」'); return; }
        const data = await api('/api/projects', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: root.split(/[\\/]/).filter(Boolean).pop() || 'project',
            root, engine }),
        });
        await finishCreate(data.id, rerender);
        return;
      }
      if (!zipFile) { toast('先选一个 zip'); return; }
      const form = new FormData();
      form.append('file', zipFile);
      form.append('name', zipFile.name.replace(/\.zip$/i, ''));
      form.append('engine', engine);
      toast('上传中…');
      const data = await api('/api/projects/upload', { method: 'POST', body: form });
      await finishCreate(data.id, rerender);
    } catch (err) { toast(err.message); }
  };
}

async function finishCreate(pid, rerender) {
  closeModal();
  state.pid = pid;
  localStorage.setItem('pid', pid);
  await loadProjects();
  startAnalyze(pid, rerender);
  rerender();
}

function openManage(rerender) {
  const card = openModal(`
    <div class="modal-head"><h3>工程管理</h3>
      <button class="modal-close" data-close aria-label="关闭">×</button></div>
    <p class="muted small">切换、重新分析、把源码打包下载；文件级下载在「代码结构」里逐个给。</p>
    <div id="manage-body"><p class="muted small">加载中…</p></div>`);
  const body = card.querySelector('#manage-body');

  async function paint() {
    const [data, files] = await Promise.all([
      api('/api/projects'),
      state.pid ? api(`/api/projects/${state.pid}/files`).catch(() => ({ files: [] })) : { files: [] },
    ]);
    state.projects = data.projects || [];
    const rows = state.projects.map((p) => `
      <tr>
        <td><b>${esc(p.name)}</b><br><span class="mono small">${esc(p.engine === 'joern' ? 'Joern CPG' : '自研解析器')}</span></td>
        <td>${STATUS_LABEL[p.status] || esc(p.status)}</td>
        <td class="mono">${p.class_count || 0} 类 / ${p.method_count || 0} 方法</td>
        <td class="acts">
          <button class="ghost" data-switch="${p.id}" ${p.id === state.pid ? 'disabled' : ''}>切换</button>
          <a class="btn ghost" href="/api/projects/${p.id}/export.zip" download>下载 zip</a>
          <button class="ghost" data-delete="${p.id}">删除</button>
        </td>
      </tr>`).join('');
    body.innerHTML = `
      <table class="project-list"><thead><tr><th>工程</th><th>状态</th><th>规模</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">还没有工程</td></tr>'}</tbody></table>
      <p class="rail-label">当前工程的源码（${(files.files || []).length} 个文件）</p>
      ${state.pid ? `<p><a class="btn" href="/api/projects/${state.pid}/export.zip" download>下载整个工程 zip</a></p>` : ''}
      <div class="fs-list" style="max-height:240px">
        ${(files.files || []).map((file) => `<div class="fs-row">
          <span class="mono small">${esc(file.path)}</span>
          <a class="link" href="/api/projects/${state.pid}/files/${file.id}/download" download>下载</a>
        </div>`).join('') || '<div class="fs-row"><span class="muted">分析完成后这里会列出源码文件</span></div>'}
      </div>`;
    body.querySelectorAll('[data-switch]').forEach((button) => {
      button.onclick = () => {
        state.pid = Number(button.dataset.switch);
        localStorage.setItem('pid', state.pid);
        closeModal(); rerender();
      };
    });
    body.querySelectorAll('[data-delete]').forEach((button) => {
      button.onclick = async () => {
        const pid = Number(button.dataset.delete);
        if (!window.confirm('删除这个工程及其分析结果？')) return;
        await api(`/api/projects/${pid}`, { method: 'DELETE' });
        await loadProjects();
        if (state.pid === pid) state.pid = state.projects[0] ? state.projects[0].id : 0;
        await paint(); rerender();
      };
    });
  }
  paint().catch((err) => { body.innerHTML = `<p class="muted">${esc(err.message)}</p>`; });
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
  // 允许按 Class.method 过滤（从功能页跳过来时就是这种串）
  const terms = needle ? [needle, needle.split('.')[0]] : [];
  const groups = new Map();
  data.files.forEach((file) => {
    const classes = file.classes || [];
    const path = String(file.path || '').replace(/\\/g, '/');
    if (needle) {
      const haystack = [path, file.package || '',
        ...classes.map((c) => c.name),
        ...classes.flatMap((c) => (c.methods || []).map((m) => m.name)),
      ].join(' ').toLowerCase();
      if (!terms.some((t) => haystack.includes(t))) return;
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

// 方法签名里的类型带全限定名，列表里太长，统一剥掉包前缀
const stripPkg = (text) => String(text == null ? '' : text)
  .replace(/(?:\b[a-z_$][\w$]*\.)+([A-Za-z_$][\w$]*)/g, '$1');

function methodItem(m) {
  // Joern 会把构造方法与编译器生成的方法一并报出来，展示时换成可读的名字
  const display = /^<(init|clinit)>$/.test(m.name || '')
    ? (m.name === '<init>' ? '构造方法' : '静态初始化') : (m.name || '');
  const facts = [
    m.branches ? `<span class="chip soft">分支 ${m.branches}</span>` : '',
    m.loops ? `<span class="chip soft">循环 ${m.loops}</span>` : '',
    m.catches ? `<span class="chip soft">捕获 ${m.catches}</span>` : '',
  ].join('');
  const calls = (m.calls || []).slice(0, 4).map((x) =>
    `<span class="chip ${x.resolved ? '' : 'warn'}">→ ${esc(x.qualifier ? x.qualifier + '.' : '')}${esc(x.name)}</span>`).join('');
  return `<li class="method"><b>${esc(display)}</b><code>${esc(stripPkg(m.signature))}</code>
    <span class="muted">第 ${m.line} 行 · ${m.loc} 行</span>${facts}<span class="calls">${calls}</span></li>`;
}

const ACCESSOR_RE = /^(get|set|is)[A-Z0-9_]/;

function accessorLine(list) {
  if (!list.length) return '';
  const names = list.slice(0, 8).map((m) => esc(m.name)).join(' / ');
  const more = list.length > 8 ? ' …' : '';
  return `<li class="accessors"><span class="muted">访问器 ${list.length} 个 · ${names}${more}</span></li>`;
}

function classBlock(c) {
  // lambda 是编译器生成的，展示时略过；getter/setter 收成一行，别把业务方法冲散
  const all = (c.methods || []).filter((m) => !/^<lambda/.test(m.name || ''));
  const accessors = all.filter((m) => ACCESSOR_RE.test(m.name || ''));
  const methods = all.filter((m) => !ACCESSOR_RE.test(m.name || '')).map(methodItem).join('');
  const fields = (c.fields || []).map((f) => `<span class="chip field"><b>${esc(f.name)}</b>${
    f.type_name ? `: ${esc(f.type_name)}` : ''}</span>`).join('');
  return `<details class="cls"><summary><b>${esc(c.name)}</b>
    <span class="badge">${esc(c.layer)}</span><span class="muted">${esc(c.kind)} · 第 ${c.line} 行</span>
    ${c.fields && c.fields.length ? `<span class="muted">· ${c.fields.length} 字段</span>` : ''}</summary>
    ${fields ? `<p class="fields">${fields}</p>` : ''}
    <ul class="methods">${methods}${accessorLine(accessors)}${methods || accessors.length ? '' : '<li class="muted">无可解析方法</li>'}</ul></details>`;
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
  // 别的页面点「Class.method」跳过来时带 focus 参数，直接填进过滤框并定位
  const focus = (currentRoute().query.get('focus') || '').trim();
  if (focus) { STRUCT.query = focus; VIEW.structure = 'list'; }
  const data = await api(`/api/projects/${state.pid}/structure`);
  const graph = data.graph || {};
  const graphLine = graph.nodes
    ? `属性图：${graph.nodes} 节点 / ${graph.edges} 边` +
      (Object.keys(graph.by_type || {}).length
        ? `（${Object.entries(graph.by_type).map(([k, v]) => `${k.replace('cpg_', '').toUpperCase()} ${v}`).join(' · ')}）`
        : '')
    : '';
  draw(`
    ${chainStrip('structure')}
    <section class="head"><div><h1>代码结构</h1>
      <p class="muted">源码解析结果：${data.classes_total} 个类、${data.methods_total} 个方法、${data.calls_total} 个调用点。
      按目录分组，点开目录 → 文件 → 类 → 方法逐层钻取。</p>
      ${graphLine ? `<p class="meta"><span>${graphLine}</span></p>` : ''}</div>
      ${viewToggle('structure')}</section>
    <div class="toolbar" id="struct-toolbar" ${VIEW.structure === 'map' ? 'hidden' : ''}>
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
  bindViewToggle('structure', () => renderStructure());

  if (VIEW.structure === 'map') {
    box.appendChild(window.viz.structureMap(data, {
      onFocusFile: (path) => {
        VIEW.structure = 'list';
        STRUCT.query = path;
        renderStructure();
      },
      // 链路的下一站：这个文件里的类会波及谁
      onImpact: (cls) => { location.hash = `#/impact?pid=${state.pid}&cls=${encodeURIComponent(cls)}`; },
    }));
    return;
  }

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

  if (focus) {
    // focus 形如 Class 或 Class.method：先定位类，再把对应方法行也高亮
    const clsName = focus.split('.')[0];
    const methodName = focus.split('.').slice(-1)[0];
    const target = Array.from(box.querySelectorAll('details.cls'))
      .find((el) => (el.querySelector('summary b') || {}).textContent === clsName);
    if (target) {
      for (let el = target.parentElement; el && el !== box; el = el.parentElement) {
        if (el.tagName === 'DETAILS') el.open = true;
      }
      target.open = true;
      target.classList.add('hl');
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => target.classList.remove('hl'), 2200);
      const row = Array.from(target.querySelectorAll('li.method'))
        .find((el) => ((el.querySelector('b') || {}).textContent || '') === methodName);
      if (row) {
        row.classList.add('hl');
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }
}

/* ------------------------------------------------------------------ 视图切换 */
const VIEW = { structure: 'map', functions: 'map', architecture: 'map', impact: 'map' };

function viewToggle(key) {
  return `<div class="seg" data-toggle="${key}">
    <button data-mode="map" class="${VIEW[key] === 'map' ? 'on' : ''}">图谱</button>
    <button data-mode="list" class="${VIEW[key] === 'list' ? 'on' : ''}">列表</button>
  </div>`;
}

function bindViewToggle(key, rerender) {
  const box = document.querySelector(`[data-toggle="${key}"]`);
  if (!box) return;
  box.querySelectorAll('[data-mode]').forEach((button) => {
    button.onclick = () => {
      VIEW[key] = button.dataset.mode;
      rerender();
    };
  });
}

/**
 * 结构 → 功能 → 架构 → 影响 是一条链路：同一条路径上前后可来回跳，
 * 跳的时候把 pid 带上，工程不丢。
 */
const CHAIN = [
  ['structure', '结构'],
  ['functions', '功能'],
  ['architecture', '架构'],
  ['impact', '影响'],
];

function chainStrip(active, extra = '') {
  const pid = state.pid ? `pid=${state.pid}` : '';
  const steps = CHAIN.map(([key, label], i) => {
    const on = key === active ? ' on' : '';
    const href = `#/${key}${pid ? `?${pid}` : ''}${key === active ? extra : ''}`;
    return `<a class="step${on}" href="${href}"><span class="mono">0${i + 1}</span>${label}</a>`;
  }).join('<i>→</i>');
  return `<nav class="chain" aria-label="分析链路">${steps}</nav>`;
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
  // 证据形如 Class.method：把功能名做成链接，点了跳到结构页并定位到那个类
  const target = evidence.split(/[（(]/)[0].trim();
  const jump = /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(target);
  const name = jump
    ? `<a class="jump" href="#/structure?focus=${encodeURIComponent(target)}"
         title="在代码结构中定位 ${esc(target)}"><b>${esc(c.name)}</b></a>`
    : `<b>${esc(c.name)}</b>`;
  return `<li>${name}<span class="ev">${esc(summary)}</span>` +
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
  // 折叠态也给一行预览：只看「模块 7 条」看不出这个模块到底在做什么
  const preview = [...new Set(children.map((c) => c.name))].slice(0, 3).join('、')
    + (children.length > 3 ? ' 等' : '');
  return `<details class="panel fn" ${needle ? 'open' : ''}>
    <summary><b>${esc(root.name)}</b><span class="muted">${children.length} 条</span>
      <span class="fn-preview">${esc(preview)}</span></summary>
    <ul class="tree">${children.map(functionItem).join('')}</ul></details>`;
}

async function renderFunctions() {
  const data = await api(`/api/projects/${state.pid}/functions`);
  draw(`
    ${chainStrip('functions')}
    <section class="head"><div><h1>功能需求恢复</h1>
      <p class="muted">一级为模块功能，二级为可核对到方法的原子功能；每条都标了实现位置。</p></div>
      <div class="row">${viewToggle('functions')}<span class="badge ok">${data.leaf_count} 条</span></div></section>
    <div class="toolbar" ${VIEW.functions === 'map' ? 'hidden' : ''}>
      <input id="fn-q" class="grow" value="${esc(FUNCS.query)}"
        placeholder="按功能名、说明或证据方法过滤，例如 登录、订单、UserController">
      <button class="ghost" id="fn-reset">清空</button>
      <button class="ghost" id="fn-open">展开全部</button>
      <button class="ghost" id="fn-close">折叠全部</button>
      <span class="muted" id="fn-count"></span>
    </div>
    <div id="fn-list"></div>`);

  const box = document.getElementById('fn-list');
  bindViewToggle('functions', () => renderFunctions());
  if (VIEW.functions === 'map') {
    box.appendChild(window.viz.functionMap(data, {
      onFocus: (evidence) => {
        const target = String(evidence || '').split(/[（(]/)[0].trim();
        location.hash = `#/structure?focus=${encodeURIComponent(target)}`;
      },
      onSearch: (text) => {
        state.search = { q: text, mode: 'fusion' };
        location.hash = '#/search';
      },
      // 链路的下一站：这条功能由哪个类实现，改它会影响什么
      onImpact: (evidence) => {
        const entry = String(evidence || '').split(/[（(\s]/)[0].trim();
        const [cls, method] = entry.split('.');
        if (!cls) return;
        location.hash = `#/impact?pid=${state.pid}&cls=${encodeURIComponent(cls)}`
          + (method ? `&m=${encodeURIComponent(method)}` : '');
      },
    }));
    return;
  }

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
  const viewpointHtml = (vp) => {
    if (!vp) return '';
    const chips = (list) => (list || []).map((x) => `<span class="chip">${esc(x)}</span>`).join('');
    const items = (list) => `<ul class="plain tight">${(list || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
    return `
    <details class="fold viewpoint">
      <summary>架构描述视角 <span class="muted">${esc(vp.standard)}</span></summary>
      <div class="vp-grid">
        <div><h4>视点</h4><p>${esc(vp.name)}</p></div>
        <div><h4>干系人</h4><p class="chips">${chips(vp.stakeholders)}</p></div>
        <div><h4>关注点</h4>${items(vp.concerns)}</div>
        <div><h4>模型种类</h4>${items(vp.model_kinds)}</div>
        <div><h4>对应关系</h4>${items(vp.correspondences)}</div>
        <div><h4>依据</h4><p class="mono">${esc((vp.references || []).join(' '))}</p>
          <p class="muted">视点、关注点、模型种类与对应关系按 42010 组织；标准本身不规定算法，算法选择见「评测对比」。</p></div>
      </div>
    </details>`;
  };
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

  const chainChip = (node) => {
    if (node.synthetic) {
      return `<span class="chip ext" title="${esc(node.kind || '外部依赖')}">⇢ ${esc(node.name)}</span>`;
    }
    const exts = (node.externals || []).map((x) =>
      `<em title="${esc(x.kind)}">⇢ ${esc(x.name)}</em>`).join('');
    return `<span class="chip">${esc(node.name)}${exts}</span>`;
  };
  const entries = (data.entries || []).map((chain, i) => {
    const hops = chain.filter((n) => !n.synthetic).length - 1;
    const tail = chain[chain.length - 1];
    return `
    <li><span class="muted">链路 ${i + 1}</span>
      ${chain.map(chainChip).join('<span class="arrow">→</span>')}
      <span class="muted">（${hops} 跳，${esc(tail.layer)}）</span></li>`;
  }).join('');

  const externals = data.externals || [];
  const externalHtml = externals.length
    ? `<p class="chips externals">${externals.map((x) =>
        `<span class="chip"><b>${esc(x.name)}</b><em>${esc(x.kind)} · ${x.count}</em></span>`).join('')}</p>`
    : `<p class="muted">没有识别到跨边界的外部依赖调用。</p>`;

  const matrix = data.matrix || { layers: [], cells: [] };
  const matrixHead = matrix.layers.map((name) => `<th>${esc(name.replace('层', ''))}</th>`).join('');
  const matrixRows = matrix.layers.map((name, i) => `
    <tr><td>${esc(name)}</td>${matrix.cells[i].map(
      (n) => `<td class="num ${n ? '' : 'zero'}">${n || '·'}</td>`).join('')}</tr>`).join('');

  const align = (data.component_functions || []).map((group) => `
    <tr><td>${esc(group.module)}</td><td>${esc(group.layer)}</td>
      <td class="classes">${group.functions.map((f) => `<span class="chip">${esc(f.name)}</span>`).join('')}</td></tr>`).join('');

  draw(`
    ${chainStrip('architecture')}
    <section class="head"><div><h1>系统架构视图</h1>
      <p class="muted">分层组件、层间依赖、入口链路与组件—功能对齐；依赖来自类级调用图。</p></div>
      ${viewToggle('architecture')}</section>
    ${viewpointHtml(data.viewpoint)}
    <div id="arch-map"></div>
    <div id="arch-list" ${VIEW.architecture === 'map' ? 'hidden' : ''}>
    <h2>入口与关键路径</h2>
    <ul class="plain chains">${entries || '<li class="muted">暂无关键路径</li>'}</ul>
    <h2>外部依赖</h2>
    ${externalHtml}
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
    </details>
    </div>`);

  bindViewToggle('architecture', () => renderArchitecture());
  if (VIEW.architecture === 'map') {
    document.getElementById('arch-map').appendChild(window.viz.archGraph(data, {
      onFocus: (name) => { location.hash = `#/structure?focus=${encodeURIComponent(String(name).split('(')[0].trim())}`; },
      onImpact: (name) => { location.hash = `#/impact?pid=${state.pid}&cls=${encodeURIComponent(String(name).split('(')[0].trim())}`; },
    }));
  }

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
      p.class_name ? ['类', `<a class="jump" href="#/structure?focus=${encodeURIComponent(p.class_name)}"
        title="在代码结构中定位">${esc(p.class_name)}</a>`] : null,
      p.signature ? ['签名', esc(p.signature)] : null,
      p.layer ? ['分层', esc(p.layer)] : null,
      p.module_id ? ['模块', esc(moduleName.get(p.module_id) || `#${p.module_id}`)] : null,
    ].filter(Boolean).map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
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
    <div class="nl-bar">
      <label class="switch"><input type="checkbox" id="nl-toggle" ${state.nlGraph ? 'checked' : ''}>
        <span>自然语言 → 图查询</span></label>
      <span class="muted small">${state.nlGraph
        ? '用一句话描述要查什么，模型只负责出查询计划，执行仍走本地图算法；解析失败自动退回规则。'
        : '关闭时走模板查询（操作 + 类下拉），演示可随时关掉。'}</span>
    </div>
    ${state.nlGraph ? `
      <div class="form-panel inline">
        <label class="grow">问题<input id="ask-q" value="${esc(state.askQ)}"
          placeholder="例如：谁调用了 User / OrderController 到 OrderDao 的路径 / 改 User 会影响哪些类"></label>
        <button class="primary" id="ask-go">解析并查询</button>
        <button class="ghost" id="ask-clear">清空</button>
      </div>
      ${state.ask ? askPanelHtml(state.ask) : ''}
    ` : `
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
    `}
    ${state.nlGraph ? '' : graphBody}`);

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
  document.getElementById('nl-toggle').onchange = (e) => {
    state.nlGraph = e.target.checked;
    localStorage.setItem('nlGraph', state.nlGraph ? '1' : '0');
    renderSearch();
  };
  const askGo = document.getElementById('ask-go');
  if (askGo) {
    askGo.onclick = async () => {
      const q = document.getElementById('ask-q').value.trim();
      if (!q) { toast('先写一句要查什么'); return; }
      state.askQ = q;
      askGo.disabled = true;
      askGo.textContent = '解析中…';
      try {
        const res = await fetch(`/api/projects/${state.pid}/graph/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, use_llm: true }),
        }).then((r) => r.json());
        state.ask = res;
      } catch (error) {
        toast('查询失败：' + error.message);
      }
      renderSearch();
    };
    document.getElementById('ask-clear').onclick = () => {
      state.askQ = ''; state.ask = null; renderSearch();
    };
  }
  const gGo = document.getElementById('g-go');
  if (gGo) gGo.onclick = () => {
    state.graph = {
      op: document.getElementById('g-op').value,
      cls: Number(document.getElementById('g-cls').value) || 0,
      from: document.getElementById('g-from').value.trim(),
      to: document.getElementById('g-to').value.trim(),
    };
    renderSearch();
  };
}

function askPanelHtml(res) {
  const badge = res.source === 'llm' ? '<span class="badge ok">模型规划</span>'
    : res.source === 'llm-fallback' ? '<span class="badge warn">模型失败 · 规则兜底</span>'
      : '<span class="badge">规则解析</span>';
  const plan = res.plan || {};
  const planText = Object.entries(plan).map(([k, v]) => `${k}=${v}`).join('  ·  ');
  const evidence = (res.evidence || []).map((x) => `<span class="chip soft">${esc(x)}</span>`).join('');
  const result = res.result || {};
  const items = (result.items || [])
    .filter((item) => !String(item.name || "").startsWith("<"))
    .slice(0, 20).map((item) => {
    const meta = [item.layer, item.module, item.hop !== undefined ? `${item.hop} 跳` : '',
      item.dynamic ? '动态推断' : ''].filter(Boolean).join(' · ');
    return `<li><a class="jump" href="#/structure?pid=${state.pid}&focus=${encodeURIComponent(item.name)}">
      <b>${esc(item.name)}</b></a> <span class="muted small">${esc(meta)}</span></li>`;
  }).join('');
  const steps = (result.steps || []).map((s) => `<span class="chip">${esc(s.name)}</span>`).join(' → ');
  let body = '';
  if (result.error) body = `<p class="muted">${esc(result.error)}</p>`;
  else if (result.op === 'path') {
    body = result.found
      ? `<p class="muted small">${result.direction === 'reverse' ? '反向路径（问题问反了）' : '调用路径'}，
           ${result.hops} 跳：</p><p>${steps}</p>`
      : `<p class="muted">没找到路径：${esc(result.message || '两个类之间没有调用关系')}</p>`;
  } else if (items) {
    body = `<p class="muted small">命中 ${result.count} 条${result.dynamic_count ? `（含 ${result.dynamic_count} 条动态推断）` : ''}</p>
      <ul class="plain tight">${items}</ul>`;
  } else if (result.note) {
    body = `<p class="muted small">${esc(result.note)}</p>`;
  }
  return `
    <div class="ask-panel">
      <div class="ask-head">${badge}
        <span class="mono small">${esc(planText || '—')}</span>
        <span class="muted small">${res.llm_configured ? '模型可用' : '未配置模型，本次为规则解析'}</span>
      </div>
      ${evidence ? `<p class="chips">${evidence}</p>` : ''}
      ${body}
      <p class="muted small">这条查询由 <span class="mono">/graph/ask</span> 解析，执行仍走本地图算法；可关掉顶上的开关回到模板查询。</p>
    </div>`;
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
  let impactData = null;
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
  // 类 → 方法名，供「方法级影响」下拉用；构造方法与编译器生成的方法不列
  const methodsOf = new Map();
  (structure.files || []).forEach((f) => (f.classes || []).forEach((c) => {
    methodsOf.set(c.id, (c.methods || []).map((m) => m.name || '')
      .filter((n) => n && !n.startsWith('<')).sort((a, b) => a.localeCompare(b)));
  }));
  // 链路带过来的上下文：#/impact?pid=3&cls=Order&m=setStatus
  const { query } = currentRoute();
  const wantCls = query.get('cls');
  if (wantCls) {
    const hit = classes.find((c) => c.name === wantCls)
      || classes.find((c) => `${c.module}/${c.name}` === wantCls)
      || classes.find((c) => c.name.toLowerCase() === wantCls.toLowerCase());
    if (hit) {
      state.impactClass = hit.id;
      state.impactMethod = query.get('m') || '';
    }
  }
  if (!state.impactClass && classes.length) {
    state.impactClass = data.project.impact_hot || classes[0].id;
  }
  const options = classes.map((c) =>
    `<option value="${c.id}" ${c.id === state.impactClass ? 'selected' : ''}>${esc(c.module)} / ${esc(c.name)}</option>`).join('');
  let result = `<p class="muted">选一个类或方法，看改动会波及哪些模块与功能。</p>`;
  const methodNames = methodsOf.get(state.impactClass) || [];
  if (state.impactMethod && !methodNames.includes(state.impactMethod)) state.impactMethod = "";
  const methodOptions = ["", ...methodNames].map((name) =>
    `<option value="${esc(name)}" ${name === state.impactMethod ? "selected" : ""}>${name ? esc(name) : "全部方法（类级影响）"}</option>`).join("");
  if (state.impactClass) {
    const query = state.impactMethod ? `?method=${encodeURIComponent(state.impactMethod)}` : "";
    const r = await api(`/api/projects/${state.pid}/impact/${state.impactClass}${query}`);
    const hops = r.max_hop || 0;
    const byHop = Array.from({ length: hops + 1 }, () => []);
    (r.classes || []).forEach((c) => byHop[Math.min(c.hop || 0, hops)].push(c));
    const flow = `
      <div class="hop-col origin">
        <p class="hop-head">起点 · 1 个类</p>
        <div class="hop-item"><b><a class="jump" href="#/structure?focus=${encodeURIComponent(r.origin.name)}"
          title="在代码结构中定位">${esc(r.origin.name)}${r.origin.method ? '.' + esc(r.origin.method) : ''}</a></b>
          <small>${esc(r.origin.layer || '')}${r.origin.method ? ' · 方法级' : ''}</small></div>
      </div>` + (hops === 0
      ? '<div class="hop-col"><p class="hop-head">无调用方</p><div class="hop-item"><small>没有类调用它，改动只影响自身。</small></div></div>'
      : byHop.slice(1).map((list, i) => `
          <div class="hop-col">
            <p class="hop-head">${i + 1} 跳 · ${list.length} 个类</p>
            ${list.map((c) => `<div class="hop-item"><b><a class="jump" href="#/structure?focus=${encodeURIComponent(c.name)}"
              title="${c.dynamic ? '动态推断可达（接口/实现或反射），不是静态调用' : '在代码结构中定位'}">${esc(c.name)}</a></b>
              <small>${esc(c.layer || '')}${c.module ? ' · ' + esc(c.module) : ''}${c.dynamic ? ' · 动态推断' : ''}</small></div>`).join('')}
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
      ${r.dynamic_count ? `<p class="muted small-note">其中 ${r.dynamic_count} 个类是通过「接口 ↔ 实现」或反射字面量推断出来的动态可达，静态调用图里看不到。</p>` : ''}
      <div id="impact-map"></div>
      <div id="impact-list" ${VIEW.impact === 'map' ? 'hidden' : ''}>
      <h2>影响扩散</h2>
      <div class="impact-flow">${flow}</div>
      ${chains ? `<h2>示例影响链</h2><ul class="plain chains-list">${chains}</ul>` : ''}
      <div class="two">
        <div><h2>涉及的模块</h2>
          <p class="chips">${r.modules.map((m) => `<span class="chip">${esc(m.name || m)}</span>`).join('') || '<span class="muted">无</span>'}</p></div>
        <div><h2>涉及的功能</h2>
          <p class="chips">${uniqueFunctionChips(r.functions)}</p></div>
      </div>
      </div>`;
    impactData = r;
  }
  draw(`
    ${chainStrip('impact')}
    <section class="head"><div><h1>变更影响分析</h1>
      <p class="muted">沿调用图反向查找：改这个类，哪些类、模块与功能要一起验证。</p></div>
      ${viewToggle('impact')}</section>
    <div class="form-panel inline">
      <label>起点类<select id="impact-select">${options}</select></label>
      <label>方法<select id="impact-method">${methodOptions}</select></label>
    </div>
    ${result}`);
  bindViewToggle('impact', () => renderImpact());
  if (VIEW.impact === 'map' && impactData && window.viz) {
    document.getElementById('impact-map').appendChild(window.viz.impactGraph(impactData, {
      onFocus: (name) => { location.hash = `#/structure?focus=${encodeURIComponent(name)}`; },
    }));
  }
  const sel = document.getElementById('impact-select');
  if (sel) sel.onchange = (e) => {
    state.impactClass = Number(e.target.value);
    state.impactMethod = "";
    renderImpact();
  };
  const methodSel = document.getElementById('impact-method');
  if (methodSel) methodSel.onchange = (e) => { state.impactMethod = e.target.value; renderImpact(); };
}

/* ------------------------------------------------------------------ 视图：对比 */
async function renderCompare() {
  // 评测要重建检索索引；索引与库里对不上时先提示一句，避免以为数字算错了。
  const status = await api(`/api/projects/${state.pid}/status`);
  if (status.index_stale) toast('检索索引与最新分析结果不一致，正在重建…', 2000);
  const data = await api(`/api/projects/${state.pid}/compare`);
  const delta = (data.history && data.history.delta) || {};
  const fmtDelta = (key) => {
    const d = delta[key];
    if (!d) return '';
    // 召回类按百分点显示，其余按原值
    const isRecall = key.startsWith('recall');
    const text = isRecall ? `${(Math.abs(d.delta) * 100).toFixed(1)}pt`
      : Math.abs(d.delta).toFixed(3);
    const up = d.delta > 0 ? 'up' : 'down';
    return ` <span class="delta ${up}" title="上次 ${isRecall ? (d.previous * 100).toFixed(1) + '%' : d.previous}">${d.delta > 0 ? '▲' : '▼'} ${text}</span>`;
  };
  const rows = data.metrics.map((m) => `
    <tr><td>${esc(m.label)}</td><td class="num">${metricText(m)}${fmtDelta(m.key)}</td><td class="muted">${esc(m.note || '')}</td></tr>`).join('');
  const rc = data.retrieval;
  const hist = data.history || {};
  const histLine = hist.run_at && hist.previous_run_at
    ? `<p class="muted small">与上次分析对比：${esc(hist.previous_run_at)} → ${esc(hist.run_at)}（指标后为变化量）</p>`
    : (hist.run_at ? '<p class="muted small">这是该工程的第一次分析，暂无可对比的历史。</p>' : '');
  const bar = (v) => `<div class="bar-mini"><i style="width:${Math.min(100, Math.round(v * 100))}%"></i></div>`;
  draw(`
    <section class="head"><div><h1>评测对比</h1>
      <p class="muted">三处算法环节的量化结果，均可在现场复现。</p>${histLine}</div>
      <button class="ghost" id="copy-md">复制为 Markdown</button></section>
    <h2>结构指标</h2>
    <table><thead><tr><th>指标</th><th>数值</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>
    <h2>方法对照</h2>
    <table class="method-compare"><thead><tr><th>维度</th><th>自研解析器（本项目）</th><th>Joern CPG</th><th>CodeQL</th></tr></thead><tbody>
      <tr><td>输入要求</td><td>Java 源码，无需构建</td><td>源码或构建产物，可免构建</td><td>需先建可编译数据库</td></tr>
      <tr><td>输出粒度</td><td>类 / 方法 / 调用点 / 字段</td><td>全量 CPG（AST·CFG·CDG·DDG·REF）</td><td>语义数据库，查询自行编写</td></tr>
      <tr><td>控制流 / 数据流</td><td>方法内近似</td><td>原生给出</td><td>原生给出</td></tr>
      <tr><td>动态分派</td><td>静态调用 + 接口↔实现、反射字面量推断</td><td>静态调用图</td><td>编译期解析，反射需建模</td></tr>
      <tr><td>部署成本</td><td>纯 Python，秒级</td><td>JVM + 1.7 GB，分钟级</td><td>构建 + 许可</td></tr>
      <tr><td>本课题用途</td><td>小工程与兜底路径</td><td>大工程主路径（抽取结构事实）</td><td>未接入，作为能力边界说明</td></tr>
    </tbody></table>
    <p class="muted small">对照维度取自架构恢复方法的三级映射研究[6]与静态分析工具横向对比[7]；CPG 的建模方式见[9]，
      图结构 + 大模型检索的路线见[3]。表里只写实测到的能力，不写未验证的结论。</p>
    <h2>语义检索召回率</h2>
    <table><thead><tr><th>方案</th><th>Recall@5</th><th></th><th>说明</th></tr></thead><tbody>
      <tr><td>融合排序（本项目）</td><td class="num">${pct(rc.fusion)}</td><td>${bar(rc.fusion)}</td><td class="muted">BM25 与向量名次融合，叠加调用图邻居</td></tr>
      <tr><td>BM25</td><td class="num">${pct(rc.bm25)}</td><td>${bar(rc.bm25)}</td><td class="muted">按词频与逆文档频率排序</td></tr>
      <tr><td>向量检索</td><td class="num">${pct(rc.vector)}</td><td>${bar(rc.vector)}</td><td class="muted">词项加权向量的余弦相似度</td></tr>
      <tr><td>关键词基线</td><td class="num">${pct(rc.keyword)}</td><td>${bar(rc.keyword)}</td><td class="muted">子串匹配，作为对照</td></tr>
    </tbody></table>
    <p class="muted">评测用 ${rc.cases} 个由功能条目构造的查询，相关集合是该功能条目指到的那个方法。这类查询的证据串里往往直接含类名，
      关键词通道因此占便宜；融合的目标是「不输给任一单路」，具体谁高取决于工程与查询措辞，数值按工程实测。</p>`);

  // 写论文时直接粘进表格，省得手抄
  document.getElementById('copy-md').onclick = async () => {
    const md = [
      '| 指标 | 数值 | 说明 |', '| --- | --- | --- |',
      ...data.metrics.map((m) => `| ${m.label} | ${metricText(m)} | ${(m.note || '').replace(/\|/g, '\\|')} |`),
      '', `| 方案 | Recall@5 | 说明 |`, '| --- | --- | --- |',
      `| 融合排序 | ${pct(rc.fusion)} | BM25 与向量名次融合，叠加调用图邻居 |`,
      `| BM25 | ${pct(rc.bm25)} | 按词频与逆文档频率排序 |`,
      `| 向量检索 | ${pct(rc.vector)} | 词项加权向量的余弦相似度 |`,
      `| 关键词基线 | ${pct(rc.keyword)} | 子串匹配，作为对照 |`,
      '', `> 评测用 ${rc.cases} 个由功能条目构造的查询。`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(md);
      toast('已复制 Markdown 表格');
    } catch (_) {
      toast('浏览器不允许写剪贴板，请手动选中表格复制');
    }
  };
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
      `<li class="toc-row"><input type="checkbox" class="sec-pick" data-sec="${i}" checked
        aria-label="导出时包含本节"><a href="#sec-${i}" data-sec="${i}">${esc(h.textContent)}</a></li>`).join('');
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
        <p class="rail-label">导出</p>
        <p class="rail-actions">
          <a class="btn" href="/api/projects/${state.pid}/documents/${state.docId}/export">整篇 Markdown</a>
          <button class="ghost" id="export-sel" type="button">导出所选章节</button>
        </p>
      </aside>
      <div class="doc-wrap">${preview}</div>
    </div>` : '<p class="muted">还没有文档，先点上面的生成按钮。</p>'}`);

  document.querySelectorAll('[data-gen]').forEach((b) => {
    b.onclick = async () => {
      // 生成要一两秒（大工程更久），先把按钮锁住，别让人以为没点上
      const label = b.textContent;
      document.querySelectorAll('[data-gen]').forEach((x) => { x.disabled = true; });
      b.textContent = '生成中…';
      try {
        const r = await api(`/api/projects/${state.pid}/documents/${b.dataset.gen}`, { method: 'POST' });
        state.docId = r.id;
        state.docKind = b.dataset.gen;
        toast('已生成：' + r.title);
        renderDocs();
      } catch (err) {
        toast(err.message);
        b.disabled = false;
        b.textContent = label;
      }
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

  // 按勾选的章节导出：拿服务端的整篇 Markdown，按「## 」切开再拼回
  const exportSel = document.getElementById('export-sel');
  if (exportSel) {
    exportSel.onclick = async () => {
      const picked = new Set(Array.from(document.querySelectorAll('.sec-pick'))
        .filter((cb) => cb.checked).map((cb) => Number(cb.dataset.sec)));
      if (!picked.size) { toast('至少勾选一节'); return; }
      try {
        const res = await fetch(`/api/projects/${state.pid}/documents/${state.docId}/export`);
        if (!res.ok) throw new Error('导出失败：' + res.status);
        const text = await res.text();
        const parts = text.split(/\n(?=## )/);
        const head = parts[0].startsWith('## ') ? '' : parts[0];
        const sections = parts.filter((p) => p.startsWith('## '));
        const body = sections.filter((_, i) => picked.has(i)).join('\n');
        const blob = new Blob([`${head}${body}`], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `doc-${state.docKind || 'doc'}-${picked.size}节.md`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast(`已导出 ${picked.size} 节`);
      } catch (err) {
        toast(err.message);
      }
    };
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
  const foot = document.getElementById('foot-left');
  if (foot) {
    foot.textContent = p
      ? `PROJECT ${p.id} · ${String(p.name).toUpperCase()} · ENGINE ${p.engine === 'joern' ? 'JOERN 4.0' : 'SELF'} · ${STATUS_LABEL[p.status] || p.status}`
      : 'PROJECT —';
  }
  api(`/api/projects/${state.pid}/status`).then(showProgress).catch(() => {});
}

async function render() {
  if (!state.projects.length) {
    await loadProjects();
  }
  if (!state.projects.length) {
    $app.innerHTML = shell(`
      <section class="empty">
        <p class="eyebrow"><i></i>00<span>开始</span></p>
        <h1>还没有工程</h1>
        <p class="muted">选一种接入方式，分析完成后会依次恢复模块、功能、架构与文档。</p>
        <div class="empty-cards">
          <button class="card" id="e-local">
            <b>接入本地目录</b><small>服务器上已有的 Java 工程，填绝对路径</small></button>
          <button class="card" id="e-zip">
            <b>上传 zip</b><small>把工程打包上传，后端自动解压</small></button>
          <button class="card" id="e-git">
            <b>从 Git 克隆</b><small>公开仓库地址，克隆后按选定的引擎分析</small></button>
        </div>
        <p class="muted small">仓库自带两个示例：demo/samples/minishop（20 个类）与 demo/samples/springblade（253 个类）。</p>
      </section>`);
    document.getElementById('e-local').onclick = () => showNewProjectForm(render);
    document.getElementById('e-zip').onclick = () => pickZip(render);
    document.getElementById('e-git').onclick = () => {
      showNewProjectForm(render);
      const git = document.getElementById('f-git');
      if (git) { git.focus(); git.scrollIntoView({ block: 'center' }); }
    };
    return;
  }
  const route = currentRoute();
  const fn = VIEWS[route.name] || renderOverview;
  view(VIEWS[route.name] ? route.name : 'overview');
  $app.innerHTML = '<div class="loading"><span class="spinner"></span>正在加载…</div>';
  try {
    await fn();
  } catch (err) {
    // 网络抖一下不该只能整页刷新：给一个只重跑当前视图的「重试」
    $app.innerHTML = shell(`<h1>出错了</h1><p class="muted">${esc(err.message)}</p>
      <div class="toolbar"><button class="primary" id="retry-view">重试</button>
        <button class="ghost" onclick="location.reload()">刷新页面</button></div>`);
    document.getElementById('retry-view').onclick = () => render();
  }
}

window.addEventListener('hashchange', render);

// 打印前把所有折叠块展开，打印完还原，避免导出的 PDF 只有标题
let printOpen = null;
window.addEventListener('beforeprint', () => {
  printOpen = Array.from(document.querySelectorAll('details')).map((d) => d.open);
  document.querySelectorAll('details').forEach((d) => { d.open = true; });
});
window.addEventListener('afterprint', () => {
  if (!printOpen) return;
  document.querySelectorAll('details').forEach((d, i) => { d.open = Boolean(printOpen[i]); });
  printOpen = null;
});
const printBtn = document.getElementById('print-btn');
if (printBtn) printBtn.onclick = () => window.print();

/* 明暗主题：index.html 的行内脚本已按 localStorage / 系统偏好定过一次 */
const themeBtn = document.getElementById('theme-btn');
const themeIcon = document.getElementById('theme-icon');
function paintThemeIcon() {
  if (themeIcon) themeIcon.textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '☾';
}
if (themeBtn) {
  paintThemeIcon();
  themeBtn.onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
    paintThemeIcon();
  };
}

/* 键盘：/ 聚焦当前页的过滤框或搜索框，Esc 清空 */
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (document.activeElement || {}).tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (e.key === '/' && !typing) {
    const box = document.getElementById('struct-q') || document.getElementById('fn-q')
      || document.getElementById('q');
    if (box) { e.preventDefault(); box.focus(); box.select(); }
    return;
  }
  if (e.key === 'Escape' && typing) {
    const el = document.activeElement;
    if (el.id === 'struct-q') { STRUCT.query = ''; el.value = ''; el.dispatchEvent(new Event('input')); }
    if (el.id === 'fn-q') { FUNCS.query = ''; el.value = ''; el.dispatchEvent(new Event('input')); }
    el.blur();
  }
});

render();
