/* 四个图谱页：自上而下的关系图。
   - 默认只画第一层，子层折叠；
   - 双击节点展开/收起下一层，单击节点在右侧检查器给出细节；
   - 数据全部来自现有接口，不新增后端。 */
(function () {
  const G = window.graphlib;
  const { forceGraph, LAYER_COLOR } = G;

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const stripPkg = (text) => String(text == null ? '' : text)
    .replace(/(?:\b[a-z_$][\w$]*\.)+([A-Za-z_$][\w$]*)/g, '$1');
  const keyvals = (rows) => `<dl class="kv">${rows.filter((r) => r && r[1] != null && r[1] !== '')
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
  const chips = (list, limit) => {
    const items = (list || []).slice(0, limit || 12);
    const rest = (list || []).length - items.length;
    return `<div class="chips">${items.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}${rest > 0 ? `<span class="chip soft">+${rest}</span>` : ''}</div>`;
  };
  const palette = ['#0891b2', '#7c3aed', '#14b8a6', '#e8a33d', '#10b981', '#d946ef', '#0f766e', '#a855f7', '#e05c6e', '#64748b'];

  // 折叠状态：按页面记住（切页/重绘都不丢）
  const EXPANDED = {};

  function shell(rail, inspector) {
    const wrap = document.createElement('div');
    wrap.className = 'map-shell';
    wrap.innerHTML = `<div class="map-rail">${rail}</div>`;
    const pane = document.createElement('div');
    pane.className = 'map-pane';
    wrap.appendChild(pane);
    const insp = document.createElement('div');
    insp.className = 'insp';
    insp.innerHTML = inspector || '';
    wrap.appendChild(insp);
    return { wrap, pane, insp };
  }

  function railBlock(title, stats, note) {
    return `<p class="rail-eyebrow"><i></i>${esc(title)}</p>
      <dl class="rail-stats">${stats.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${note ? `<p class="rail-note">${esc(note)}</p>` : ''}`;
  }

  function legendOf(layers) {
    return `<div class="fg-legend">${layers.map((l) => `<span class="lg"><i class="dot" style="--g:${LAYER_COLOR[l] || '#64748b'}"></i>${esc(l)}</span>`).join('')}</div>`;
  }

  /* 通用：自上而下、可折叠的树，nodes 需带 parent / order / levelLabel */
  function treePanel(opts) {
    const {
      key, nodes, edges, title, rail, inspector, onPick, hooks, height,
      width = 1120, defaultExpanded = [], onAction,
    } = opts;
    if (!EXPANDED[key]) EXPANDED[key] = new Set(defaultExpanded);
    const expanded = EXPANDED[key];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const children = new Map();
    nodes.forEach((n) => {
      if (n.parent == null) return;
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n);
    });
    const { wrap, pane, insp } = shell('', inspector);
    function setInsp(html) {
      insp.innerHTML = html || '';
      insp.classList.toggle('has', Boolean((html || '').trim()));
    }
    setInsp(inspector || '');
    const railEl = wrap.querySelector('.map-rail');
    let canvas = null;

    function treeRows(list, depth) {
      return list.map((n) => {
        const kids = children.get(n.id) || [];
        const open = expanded.has(n.id);
        return `<div class="mt-node">
          <button class="mt-row" data-node="${esc(n.id)}" style="--d:${depth}">
            <span class="mt-caret">${kids.length ? (open ? '−' : '+') : ''}</span>
            <span class="mt-name">${esc(n.label)}</span>
            ${kids.length ? `<span class="mt-count">${kids.length}</span>` : ''}
          </button>
          ${kids.length && open ? `<div class="mt-kids">${treeRows(kids, depth + 1)}</div>` : ''}
        </div>`;
      }).join('');
    }

    function paintRail() {
      const roots = nodes.filter((n) => n.parent == null);
      railEl.innerHTML = `<p class="rail-eyebrow"><i></i>结构</p>
        <div class="mtree">${treeRows(roots, 0)}</div>
        <div class="mt-extra">${rail}</div>`;
    }

    function visible() {
      const out = [];
      const walk = (n, level) => {
        out.push({ ...n, level, levelLabel: level === 0 ? (n.levelLabel || '') : '' });
        if (!expanded.has(n.id)) return;
        (children.get(n.id) || []).forEach((c) => walk(c, level + 1));
      };
      nodes.filter((n) => n.parent == null).forEach((n) => walk(n, 0));
      return out;
    }

    function paint(preferredW) {
      const vis = visible();
      const W = Math.max(420, preferredW || pane.clientWidth || width);
      const ids = new Set(vis.map((n) => n.id));
      const visEdges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
      if (canvas) canvas.remove();
      canvas = forceGraph({
        nodes: vis, edges: visEdges, width: W, height, vertical: true,
        title: `${title} · ${vis.length} 节点`,
        legend: [],
        inspector: insp,
        onPick: (nd) => {
          const has = children.has(nd.id);
          const base = onPick(byId.get(nd.id) || nd) || '';
          return base + (has
            ? `<p class="muted small">${expanded.has(nd.id) ? '双击收起下一层' : `双击展开 ${children.get(nd.id).length} 个子项`}</p>`
            : '');
        },
        onDblClick: (nd) => {
          if (!children.has(nd.id)) return;
          if (expanded.has(nd.id)) expanded.delete(nd.id);
          else expanded.add(nd.id);
          paint();
        },
      });
      pane.appendChild(canvas);
      if (!preferredW) {
        // 首次绘制时 pane 可能还不在文档里，量不到宽度 → 下一帧按真实宽度重画一次
        requestAnimationFrame(() => {
          const real = pane.clientWidth;
          if (real && Math.abs(real - W) > 8) paint(real);
        });
      }
      paintRail();
      setInsp('');
    }

    railEl.addEventListener('click', (event) => {
      const row = event.target.closest('.mt-row');
      if (!row) return;
      const id = row.dataset.node;
      if (canvas && canvas.select) canvas.select(id);
      if (onPick) setInsp(onPick(byId.get(id)) || '');
    });
    railEl.addEventListener('dblclick', (event) => {
      const row = event.target.closest('.mt-row');
      if (!row) return;
      const id = row.dataset.node;
      if (!children.has(id)) return;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      paint();
    });
    insp.addEventListener('click', (event) => {
      if (!onAction) return;
      const btn = event.target.closest('[data-act]');
      if (btn) onAction(btn.getAttribute('data-act'), btn.getAttribute('data-value') || '');
    });
    paint();
    return wrap;
  }

  /* ------------------------------------------------------------ 代码结构 */
  function structureMap(data, hooks) {
    const files = data.files || [];
    const byDir = new Map();
    files.forEach((f) => {
      const path = String(f.path || '').replace(/\\/g, '/');
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '（根目录）';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push({ ...f, dir, path });
    });
    const dirs = [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const groups = new Map();
    dirs.forEach(([dir, list]) => {
      const g = dir.split('/')[0] || '（根目录）';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push([dir, list]);
    });

    const nodes = [{ id: 'root', label: '工程', layer: '其他', levelLabel: '工程', meta: `${dirs.length} 个目录 · ${files.length} 个文件` }];
    const edges = [];
    let order = 0;
    [...groups.entries()].forEach(([g, list], gi) => {
      const gid = `g:${g}`;
      const fileCount = list.reduce((n, [, fs]) => n + fs.length, 0);
      nodes.push({
        id: gid, parent: 'root', order: gi, color: palette[gi % palette.length],
        label: g, layer: '模块', levelLabel: '模块', meta: `${list.length} 个目录 · ${fileCount} 个文件`, group: g,
      });
      edges.push({ source: 'root', target: gid, kind: 'contains' });
      list.forEach(([dir, fs2], di) => {
        const did = `d:${dir}`;
        nodes.push({
          id: did, parent: gid, order: di, color: palette[gi % palette.length],
          label: dir.split('/').slice(-2).join('/') || dir, layer: '目录', levelLabel: '目录',
          meta: `${fs2.length} 个文件`, dir, files: fs2,
        });
        edges.push({ source: gid, target: did, kind: 'contains' });
        fs2.forEach((f, fi) => {
          const fid = `f:${f.path}`;
          nodes.push({
            id: fid, parent: did, order: fi, color: palette[gi % palette.length],
            label: String(f.path).replace(/\\/g, '/').split('/').pop(), layer: '文件', levelLabel: '文件',
            meta: `${(f.classes || []).length} 个类`, file: f, dir,
          });
          edges.push({ source: did, target: fid, kind: 'contains' });
        });
      });
      order += 1;
    });

    return treePanel({
      key: 'structure', nodes, edges, width: 1120, height: 560,
      title: '工程 ⇢ 模块 ⇢ 目录 ⇢ 文件',
      defaultExpanded: ['root'],
      rail: railBlock('VIEW', [['模块', groups.size], ['目录', dirs.length], ['文件', files.length]],
        '自上而下：工程 → 模块 → 目录 → 文件。双击节点展开下一层，单击看细节。') + legendOf(['接入层', '业务层', '数据层', '领域层', '公共层']),
      inspector: '<p class="insp-hint">单击节点看它下面的文件、类；双击展开或收起。</p>',
      onPick: (nd) => {
        if (nd.id === 'root') {
          return `<p class="insp-title">工程</p>${keyvals([['模块', groups.size], ['目录', dirs.length], ['文件', files.length]])}<p class="muted small">双击展开模块。</p>`;
        }
        if (nd.group) {
          return `<p class="insp-title">${esc(nd.group)}</p>${keyvals([['目录', nd.meta]])}<p class="muted small">双击展开目录。</p>`;
        }
        if (nd.files) {
          const cls = nd.files.flatMap((f) => (f.classes || []).map((c) => c.name));
          return `<p class="insp-title">${esc(nd.dir || '')}</p>
            ${keyvals([['文件', nd.files.length], ['类', cls.length]])}
            <p class="rail-label">文件</p>${chips(nd.files.map((f) => f.path.split('/').pop()), 10)}
            <p class="rail-label">类</p>${chips(cls, 10)}
            <div class="insp-actions">
              <button class="ghost" data-act="focus-file" data-value="${esc((nd.files[0] || {}).path || '')}">在列表里定位</button>
              ${cls.length ? `<button class="ghost" data-act="impact" data-value="${esc(cls[0])}">看变更影响</button>` : ''}
            </div>`;
        }
        const f = nd.file || {};
        return `<p class="insp-title">${esc(nd.label)}</p>
          ${keyvals([['路径', `<code>${esc(f.path || '')}</code>`], ['类', (f.classes || []).length], ['行数', f.loc || 0]])}
          <p class="rail-label">类</p>${chips((f.classes || []).map((c) => c.name), 12)}
          <div class="insp-actions">
            <button class="ghost" data-act="focus-file" data-value="${esc(f.path || '')}">在列表里定位</button>
          </div>`;
      },
      onAction: (act, value) => {
        if (act === 'focus-file' && hooks.onFocusFile) hooks.onFocusFile(value);
        if (act === 'impact' && hooks.onImpact) hooks.onImpact(value);
      },
      hooks,
    });
  }

  /* ------------------------------------------------------------ 功能需求 */
  function functionMap(functions, hooks) {
    const tree = functions.tree || [];
    const nodes = [{ id: 'root', label: '功能树', layer: '其他', levelLabel: '功能树', meta: `${tree.length} 个模块 · ${functions.leaf_count} 条` }];
    const edges = [];
    tree.forEach((mod, mi) => {
      const mid = `m:${mi}`;
      nodes.push({
        id: mid, parent: 'root', order: mi, color: palette[mi % palette.length],
        label: mod.name, layer: '模块', levelLabel: '模块', meta: `${(mod.children || []).length} 条功能`, module: mod,
      });
      edges.push({ source: 'root', target: mid, kind: 'contains' });
      (mod.children || []).forEach((leaf, li) => {
        const lid = `${mid}:${li}`;
        nodes.push({
          id: lid, parent: mid, order: li, color: palette[mi % palette.length],
          label: leaf.name, layer: '条目', levelLabel: '条目', meta: leaf.evidence || '', leaf, moduleName: mod.name,
        });
        edges.push({ source: mid, target: lid, kind: 'contains' });
      });
    });

    return treePanel({
      key: 'functions', nodes, edges, width: 1120, height: 520,
      title: '功能树 ⇢ 模块 ⇢ 功能条目',
      defaultExpanded: ['root'],
      rail: railBlock('VIEW', [['模块', tree.length], ['条目', functions.leaf_count]],
        '自上而下：功能树 → 模块 → 条目。双击模块展开条目，单击看证据方法。'),
      inspector: '<p class="insp-hint">单击模块或条目；双击模块展开条目。</p>',
      onPick: (nd) => {
        if (nd.id === 'root') {
          return `<p class="insp-title">功能树</p>${keyvals([['模块', tree.length], ['条目', functions.leaf_count]])}<p class="muted small">双击展开模块。</p>`;
        }
        if (nd.module) {
          return `<p class="insp-title">${esc(nd.module.name)}</p>${keyvals([['功能条目', (nd.module.children || []).length]])}
            ${chips((nd.module.children || []).map((c) => c.name), 10)}<p class="muted small">双击展开条目。</p>`;
        }
        const leaf = nd.leaf || {};
        return `<p class="insp-title">${esc(leaf.name)}</p>
          ${keyvals([['说明', esc(leaf.summary || '')], ['证据', `<code>${esc(stripPkg(leaf.evidence || ''))}</code>`], ['模块', esc(nd.moduleName || '')]])}
          <div class="insp-actions">
            <button class="ghost" data-act="focus" data-value="${esc(leaf.evidence || '')}">在代码结构里定位</button>
            <button class="ghost" data-act="search" data-value="${esc(leaf.name || '')}">按证据检索</button>
            <button class="ghost" data-act="impact" data-value="${esc(leaf.evidence || '')}">看变更影响</button>
          </div>`;
      },
      onAction: (act, value) => {
        if (act === 'focus' && hooks.onFocus) hooks.onFocus(value);
        if (act === 'search' && hooks.onSearch) hooks.onSearch(value);
        if (act === 'impact' && hooks.onImpact) hooks.onImpact(value);
      },
      hooks,
    });
  }

  /* ------------------------------------------------------------ 系统架构 */
  function archGraph(data, hooks) {
    const comps = (data.layers || []).flatMap((l) => l.components || []);
    const byName = new Map(comps.map((c) => [c.name, c]));
    const layerOrder = ['接入层', '业务层', '数据层', '领域层', '公共层', '其他'];
    const layerOf = new Map();
    (data.layers || []).forEach((l) => (l.components || []).forEach((c) => layerOf.set(c.name, l.name || c.layer || '其他')));

    const nodes = [];
    const edges = [];
    const groups = layerOrder.filter((l) => comps.some((c) => (layerOf.get(c.name) || c.layer) === l));
    groups.forEach((layer, li) => {
      const gid = `L:${layer}`;
      const members = comps.filter((c) => (layerOf.get(c.name) || c.layer) === layer);
      nodes.push({
        id: gid, label: layer, layer, levelLabel: li === 0 ? '分层' : '',
        color: LAYER_COLOR[layer] || '#64748b', meta: `${members.length} 个组件`, layerNode: layer,
      });
      members.forEach((c, ci) => {
        edges.push({ source: gid, target: `c:${c.name}`, kind: 'contains' });
        nodes.push({
          id: `c:${c.name}`, parent: gid, order: ci,
          label: c.name, layer, levelLabel: '组件', color: LAYER_COLOR[layer] || '#64748b',
          meta: `${(c.classes || []).length} 类 · 依赖 ${(c.depends_on || []).length}`, comp: c,
        });
      });
    });
    comps.forEach((c) => {
      (c.depends_on || []).forEach((dep) => {
        if (byName.has(dep)) edges.push({ source: `c:${c.name}`, target: `c:${dep}`, kind: 'depends' });
      });
    });

    return treePanel({
      key: 'arch', nodes, edges, width: 1120, height: 520,
      title: '分层 ⇢ 组件 ⇢ 依赖',
      defaultExpanded: [],
      rail: railBlock('VIEW', [['分层', groups.length], ['组件', comps.length], ['依赖边', edges.length]],
        '自上而下按分层；双击一层展开组件，箭头从调用方指向被依赖的组件。'),
      inspector: '<p class="insp-hint">双击分层展开组件；单击组件看依赖与包含的类。</p>',
      onPick: (nd) => {
        if (nd.layerNode) {
          const members = comps.filter((c) => (layerOf.get(c.name) || c.layer) === nd.layerNode);
          return `<p class="insp-title">${esc(nd.layerNode)}</p>${keyvals([['组件', members.length]])}
            ${chips(members.map((c) => c.name), 12)}<p class="muted small">双击展开该层组件。</p>`;
        }
        const c = nd.comp || {};
        const cls = c.classes || [];
        return `<p class="insp-title">${esc(c.name)}</p>
          ${keyvals([['分层', esc(c.layer || '')], ['模块', esc(c.module || '—')], ['规模', `${cls.length} 类`], ['依赖', esc((c.depends_on || []).join('、') || '无')]])}
          <p class="rail-label">包含的类</p>${chips(cls, 12)}
          <div class="insp-actions">
            <button class="ghost" data-act="focus" data-value="${esc(cls[0] || c.name)}">在代码结构里看这些类</button>
            <button class="ghost" data-act="impact" data-value="${esc(cls[0] || c.name)}">看变更影响</button>
          </div>`;
      },
      onAction: (act, value) => {
        if (act === 'focus' && hooks.onFocus) hooks.onFocus(value);
        if (act === 'impact' && hooks.onImpact) hooks.onImpact(value);
      },
      hooks,
    });
  }

  /* ------------------------------------------------------------ 变更影响 */
  function impactGraph(impact, hooks) {
    const origin = impact.origin || {};
    const classes = (impact.classes || []).filter((c) => c.id !== origin.id && c.name !== origin.name);
    const maxHop = Math.max(1, impact.max_hop || 1);
    const nodes = [{
      id: 'origin', label: origin.name, layer: origin.layer || '其他', levelLabel: '起点',
      meta: `起点 · ${origin.layer || ''}`, origin: true,
    }];
    const edges = [];
    for (let hop = 1; hop <= maxHop; hop += 1) {
      const list = classes.filter((c) => (c.hop || 1) === hop);
      if (!list.length) continue;
      const gid = `H:${hop}`;
      nodes.push({
        id: gid, parent: 'origin', order: hop, color: palette[(hop + 2) % palette.length],
        label: `${hop} 跳 · ${list.length} 个类`, layer: '跳数', levelLabel: `${hop} 跳`, meta: `${list.length} 个受影响类`, hopGroup: hop,
      });
      edges.push({ source: 'origin', target: gid, kind: 'depends' });
      list.forEach((c, ci) => {
        const cid = `c:${c.id}`;
        edges.push({ source: gid, target: cid, kind: 'contains' });
        nodes.push({
          id: cid, parent: gid, order: ci, label: c.name, layer: c.layer || '其他', levelLabel: '类',
          color: LAYER_COLOR[c.layer] || '#64748b',
          meta: `${c.module || ''} · ${hop} 跳${c.dynamic ? ' · 动态推断' : ''}`, cls: c,
        });
      });
    }
    return treePanel({
      key: 'impact', nodes, edges, width: 1120, height: 520,
      title: '起点 ⇢ 跳数 ⇢ 受影响类',
      defaultExpanded: ['origin'],
      rail: railBlock('VIEW', [['受影响类', classes.length], ['最大跳数', maxHop]],
        '自上而下按跳数分组；双击「N 跳」展开该类，单击看分层与动态推断。'),
      inspector: '<p class="insp-hint">双击「N 跳」展开；单击节点看分层、模块与跳数。</p>',
      onPick: (nd) => {
        if (nd.id === 'origin') {
          return `<p class="insp-title">${esc(nd.label)}</p>${keyvals([['分层', esc(origin.layer || '')], ['跳数', 0]])}
            <p class="muted small">这是起点；双击看各跳的分组。</p>`;
        }
        if (nd.hopGroup) {
          const list = classes.filter((c) => (c.hop || 1) === nd.hopGroup);
          return `<p class="insp-title">${nd.hopGroup} 跳</p>${keyvals([['受影响类', list.length]])}${chips(list.map((c) => c.name), 12)}
            <p class="muted small">双击展开这些类。</p>`;
        }
        const c = nd.cls || {};
        return `<p class="insp-title">${esc(c.name)}</p>
          ${keyvals([['分层', esc(c.layer || '')], ['模块', esc(c.module || '—')], ['跳数', c.hop], ['动态', c.dynamic ? '接口/反射推断' : '否']])}
          <div class="insp-actions"><button class="ghost" data-act="focus" data-value="${esc(c.name)}">在代码结构里定位</button></div>`;
      },
      onAction: (act, value) => {
        if (act === 'focus' && hooks.onFocus) hooks.onFocus(value);
      },
      hooks,
    });
  }

  window.vizPages = { structureMap, functionMap, archGraph, impactGraph };
})();
