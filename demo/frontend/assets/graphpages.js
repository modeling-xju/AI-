/* 四个图谱页的力导向版本：只画「节点 + 带箭头的边」，
   检查器按页给出证据与跳转。数据都来自现有接口，不新增后端。 */
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

  function shell(rail, canvas, inspector) {
    const wrap = document.createElement('div');
    wrap.className = 'map-shell';
    wrap.innerHTML = `<div class="map-rail">${rail}</div>`;
    const pane = document.createElement('div');
    pane.className = 'map-pane';
    pane.appendChild(canvas);
    wrap.appendChild(pane);
    const insp = document.createElement('div');
    insp.className = 'insp';
    insp.innerHTML = inspector || '';
    wrap.appendChild(insp);
    return { wrap, insp };
  }

  function railBlock(title, stats, note) {
    return `<p class="rail-eyebrow"><i></i>${esc(title)}</p>
      <dl class="rail-stats">${stats.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${note ? `<p class="rail-note">${esc(note)}</p>` : ''}`;
  }

  function legendOf(layers) {
    return `<div class="fg-legend">${layers.map((l) => `<span class="lg"><i class="dot" style="--g:${LAYER_COLOR[l] || '#64748b'}"></i>${esc(l)}</span>`).join('')}</div>`;
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
    const dirs = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length);

    const nodes = [{ id: 'root', label: '工程', layer: '其他', anchor: 0.06, meta: `${dirs.length} 个目录 · ${files.length} 个文件` }];
    const edges = [];
    dirs.forEach(([dir, list], i) => {
      const id = `dir:${dir}`;
      nodes.push({
        id, label: dir.split('/').slice(-2).join('/') || dir, layer: '其他',
        color: palette[i % palette.length],
        anchor: 0.5,
        meta: `${list.length} 个文件 · ${list.reduce((n, f) => n + (f.classes || []).length, 0)} 个类`,
        dir, files: list,
      });
      edges.push({ source: 'root', target: id, kind: 'contains' });
    });

    const layers = ['接入层', '业务层', '数据层', '领域层', '公共层'];
    const canvas = forceGraph({
      nodes, edges, width: 1200, height: 700,
      title: '目录 ⇢ 文件 / 类',
      legend: [],
      onPick: (nd) => {
        if (!nd.dir) return `<p class="insp-title">工程</p>${keyvals([['目录', dirs.length], ['文件', files.length]])}<p class="muted small">点外圈目录看它下面的文件与类。</p>`;
        const cls = nd.files.flatMap((f) => (f.classes || []).map((c) => c.name));
        const chipsHtml = nd.files.slice(0, 8).map((f) => `<span class="chip" title="${esc(f.path)}">${esc(f.path.split('/').pop())}</span>`).join('');
        return `<p class="insp-title">${esc(nd.dir || '工程')}</p>
          ${keyvals([['文件', nd.files.length], ['类', cls.length]])}
          <p class="rail-label">文件</p><div class="chips">${chipsHtml}${nd.files.length > 8 ? `<span class="chip soft">+${nd.files.length - 8}</span>` : ''}</div>
          <p class="rail-label">类</p>${chips(cls, 10)}
          <div class="insp-actions">
            <button class="ghost" data-focus="1">在列表里定位</button>
            ${cls.length ? `<button class="ghost" data-impact="${esc(cls[0])}">看变更影响</button>` : ''}
          </div>`;
      },
    });
    const { wrap, insp } = shell(
      railBlock('VIEW', [['目录', dirs.length], ['文件', files.length]], '外圈一个节点 = 一个目录；箭头从工程指向目录。点节点看文件与类。') + legendOf(layers),
      canvas, '<p class="insp-hint">点外圈目录节点，看它下面的文件、类与跳转。</p>',
    );
    insp.addEventListener('click', (event) => {
      const focusBtn = event.target.closest('[data-focus]');
      if (focusBtn && hooks.onFocusFile) {
        const dir = (insp.querySelector('.insp-title') || {}).textContent || '';
        const entry = dirs.find(([d]) => d === dir.trim());
        if (entry && entry[1][0]) hooks.onFocusFile(entry[1][0].path);
      }
      const impactBtn = event.target.closest('[data-impact]');
      if (impactBtn && hooks.onImpact) hooks.onImpact(impactBtn.getAttribute('data-impact'));
    });
    return wrap;
  }

  /* ------------------------------------------------------------ 功能需求 */
  function functionMap(functions, hooks) {
    const tree = functions.tree || [];
    const nodes = [{ id: 'root', label: '功能树', layer: '其他', anchor: 0.05, meta: `${tree.length} 个模块 · ${functions.leaf_count} 条` }];
    const edges = [];
    tree.forEach((mod, mi) => {
      const mid = `mod:${mi}`;
      nodes.push({
        id: mid, label: mod.name, color: palette[mi % palette.length], anchor: 0.34,
        meta: `${(mod.children || []).length} 条功能`, module: mod,
      });
      edges.push({ source: 'root', target: mid, kind: 'contains' });
      (mod.children || []).forEach((leaf, li) => {
        const lid = `${mid}:${li}`;
        nodes.push({
          id: lid, label: leaf.name, color: palette[mi % palette.length], anchor: 0.72,
          meta: leaf.evidence || '', leaf, moduleName: mod.name,
        });
        edges.push({ source: mid, target: lid, kind: 'contains' });
      });
    });

    const canvas = forceGraph({
      nodes, edges, width: 1200, height: 720,
      title: '模块 ⇢ 功能条目',
      onPick: (nd) => {
        if (nd.module) {
          return `<p class="insp-title">${esc(nd.module.name)}</p>${keyvals([['功能条目', (nd.module.children || []).length]])}
            ${chips((nd.module.children || []).map((c) => c.name), 10)}`;
        }
        if (!nd.leaf) return `<p class="insp-title">功能树</p>${keyvals([['模块', tree.length], ['条目', functions.leaf_count]])}`;
        const leaf = nd.leaf;
        return `<p class="insp-title">${esc(leaf.name)}</p>
          ${keyvals([['说明', esc(leaf.summary || '')], ['证据', `<code>${esc(stripPkg(leaf.evidence || ''))}</code>`], ['模块', esc(nd.moduleName || '')]])}
          <div class="insp-actions">
            <button class="ghost" data-act="focus">在代码结构里定位</button>
            <button class="ghost" data-act="search">按证据检索</button>
            <button class="ghost" data-act="impact">看变更影响</button>
          </div>`;
      },
    });
    const { wrap, insp } = shell(
      railBlock('VIEW', [['模块', tree.length], ['条目', functions.leaf_count]], '箭头从模块指向功能条目；点叶子看证据方法与跳转。') + legendOf([...(new Set(tree.map((m) => m.name)))].slice(0, 0)),
      canvas, '<p class="insp-hint">点模块或功能条目，右侧给说明与跳转。</p>',
    );
    insp.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-act]');
      if (!btn) return;
      const title = (insp.querySelector('.insp-title') || {}).textContent || '';
      const leaf = nodes.find((n) => n.leaf && n.leaf.name === title.trim());
      if (!leaf) return;
      if (btn.dataset.act === 'focus' && hooks.onFocus) hooks.onFocus(leaf.leaf.evidence);
      if (btn.dataset.act === 'search' && hooks.onSearch) hooks.onSearch(title.trim());
      if (btn.dataset.act === 'impact' && hooks.onImpact) hooks.onImpact(leaf.leaf.evidence);
    });
    return wrap;
  }

  /* ------------------------------------------------------------ 系统架构 */
  function archGraph(data, hooks) {
    const comps = (data.layers || []).flatMap((l) => l.components || []);
    const byName = new Map(comps.map((c) => [c.name, c]));
    const nodes = comps.map((c) => ({
      id: `c:${c.name}`, label: c.name, layer: c.layer || '其他',
      meta: `${(c.classes || []).length} 类${c.module ? ' · ' + c.module : ''}`, comp: c,
    }));
    const externals = new Map();
    const edges = [];
    comps.forEach((c) => {
      (c.depends_on || []).forEach((dep) => {
        const target = byName.get(dep);
        if (target) {
          edges.push({ source: `c:${c.name}`, target: `c:${target.name}`, kind: 'depends' });
        } else {
          if (!externals.has(dep)) {
            externals.set(dep, { id: `x:${dep}`, label: dep, layer: '外部依赖', meta: '外部依赖' });
            nodes.push(externals.get(dep));
          }
          edges.push({ source: `c:${c.name}`, target: `x:${dep}`, kind: 'depends' });
        }
      });
    });
    // 按分层给水平锚点：接入 → 业务 → 数据 → 领域 → 公共 → 其他（外部依赖放最右）
    const layerOrder = ['接入层', '业务层', '数据层', '领域层', '公共层', '其他', '外部依赖'];
    nodes.forEach((nd) => {
      const i = layerOrder.indexOf(nd.layer);
      nd.anchor = i < 0 ? 0.92 : 0.08 + (i / (layerOrder.length - 1)) * 0.84;
    });
    // 去重（同名依赖可能重复声明）
    const seen = new Set();
    const uniq = edges.filter((e) => {
      const k = `${e.source}->${e.target}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    const layers = [...new Set(nodes.map((n) => n.layer))];
    const canvas = forceGraph({
      nodes, edges: uniq, width: 1040, height: 720,
      title: '组件 ⇢ 依赖',
      legend: [],
      onPick: (nd) => {
        if (!nd.comp) {
          return `<p class="insp-title">${esc(nd.label)}</p>${keyvals([['类型', '外部依赖']])}<p class="muted small">不在本工程的组件里，按包名/类名归类得到。</p>`;
        }
        const c = nd.comp;
        const cls = c.classes || [];
        return `<p class="insp-title">${esc(c.name)}</p>
          ${keyvals([['分层', esc(c.layer || '')], ['模块', esc(c.module || '—')], ['规模', `${cls.length} 类`], ['依赖', esc((c.depends_on || []).join('、') || '无')]])}
          <p class="rail-label">包含的类</p>${chips(cls, 12)}
          <div class="insp-actions">
            <button class="ghost" data-focus="${esc(cls[0] || c.name)}">在代码结构里看这些类</button>
            <button class="ghost" data-impact="${esc(cls[0] || c.name)}">看变更影响</button>
          </div>`;
      },
    });
    const { wrap, insp } = shell(
      railBlock('VIEW', [['组件', comps.length], ['依赖边', uniq.length]], '箭头从调用方指向被依赖的组件；外部依赖单独成点。') + legendOf(layers.filter((l) => l !== '外部依赖')),
      canvas, '<p class="insp-hint">点组件看分层、依赖与包含的类。</p>',
    );
    insp.addEventListener('click', (event) => {
      const f = event.target.closest('[data-focus]');
      if (f && hooks.onFocus) hooks.onFocus(f.getAttribute('data-focus'));
      const im = event.target.closest('[data-impact]');
      if (im && hooks.onImpact) hooks.onImpact(im.getAttribute('data-impact'));
    });
    return wrap;
  }

  /* ------------------------------------------------------------ 变更影响 */
  function impactGraph(impact, hooks) {
    const origin = impact.origin || {};
    const classes = impact.classes || [];
    const nodes = [{
      id: `c:${origin.id}`, label: origin.name, layer: origin.layer || '其他',
      meta: `起点 · ${origin.layer || ''}`, origin: true, anchor: 0.06, colLabel: '起点',
    }];
    const byId = new Map();
    classes.forEach((c) => {
      if (c.id === origin.id || c.name === origin.name) return;
      const id = `c:${c.id}`;
      if (byId.has(id)) return;
      byId.set(id, c);
      nodes.push({
        id, label: c.name, layer: c.layer || '其他',
        meta: `${c.module || ''} · ${c.hop || 1} 跳${c.dynamic ? ' · 动态推断' : ''}`,
        cls: c,
        anchor: 0.2 + (Math.max(1, c.hop || 1) / Math.max(1, impact.max_hop || 1)) * 0.72,
        colLabel: `${c.hop || 1} 跳`,
      });
    });
    const edges = [];
    classes.forEach((c) => {
      if (c.parent == null) {
        edges.push({ source: `c:${origin.id}`, target: `c:${c.id}`, kind: c.dynamic ? 'dynamic' : 'depends' });
      } else {
        edges.push({ source: `c:${c.parent}`, target: `c:${c.id}`, kind: c.dynamic ? 'dynamic' : 'depends' });
      }
    });
    const seen = new Set();
    const uniq = edges.filter((e) => {
      const k = `${e.source}->${e.target}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const layers = [...new Set(nodes.map((n) => n.layer))];

    const canvas = forceGraph({
      nodes, edges: uniq, width: 1040, height: 660,
      title: '起点 ⇢ 受影响类',
      onPick: (nd) => {
        if (nd.origin) {
          return `<p class="insp-title">${esc(nd.label)}</p>${keyvals([['分层', esc(origin.layer || '')], ['跳数', 0]])}
            <p class="muted small">这是起点；箭头指向直接受影响的类。</p>`;
        }
        if (!nd.cls) return '';
        const c = nd.cls;
        return `<p class="insp-title">${esc(c.name)}</p>
          ${keyvals([['分层', esc(c.layer || '')], ['模块', esc(c.module || '—')], ['跳数', c.hop], ['动态', c.dynamic ? '接口/反射推断' : '否']])}
          <div class="insp-actions"><button class="ghost" data-focus="${esc(c.name)}">在代码结构里定位</button></div>`;
      },
    });
    const { wrap, insp } = shell(
      railBlock('VIEW', [['受影响类', classes.length], ['最大跳数', impact.max_hop || 0]], '箭头 = 传播方向；琥珀虚线 = 接口↔实现或反射推断的动态可达。') + legendOf(layers),
      canvas, '<p class="insp-hint">点节点看它属于哪一层、从起点过来几跳。</p>',
    );
    insp.addEventListener('click', (event) => {
      const f = event.target.closest('[data-focus]');
      if (f && hooks.onFocus) hooks.onFocus(f.getAttribute('data-focus'));
    });
    return wrap;
  }

  window.vizPages = { structureMap, functionMap, archGraph, impactGraph };
})();
