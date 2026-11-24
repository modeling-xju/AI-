/* 图形化视图（原生 SVG/DOM，无第三方库）
 * 四个页面共用一套“画布 + 右侧检查器”的骨架：左图可点击下钻，右栏给证据与跳转。
 * 依赖 app.js 里的全局 state / 工具函数（按需回退）。
 */
'use strict';

(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const LAYER_COLOR = {
    '接入层': '#0074c9', '业务层': '#2f8f6b', '数据层': '#8a5cd6',
    '领域层': '#c07a1e', '公共层': '#6b7887', '其他': '#9aa7b2', '外部依赖': '#e0562f',
  };
  const color = (layer) => LAYER_COLOR[layer] || '#6b7887';

  const frame = (canvas, inspector, hint) => `
    <div class="map">
      <div class="map-canvas">
        <p class="map-hint">${hint}</p>
        ${canvas}
      </div>
      <aside class="insp">${inspector}</aside>
    </div>`;

  const emptyInsp = (text) => `
    <p class="eyebrow"><i></i>INSPECTOR</p>
    <h4>还没有选中</h4>
    <p class="muted small">${text}</p>`;

  const kv = (rows) => `<dl class="kv">${rows.filter(Boolean)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

  const chip = (text, extra = '') => `<span class="chip ${extra}">${esc(text)}</span>`;

  /* -------------------------------------------------------------- 通用目录树图 */
  function makeTreeMap(rootNode, onPick, opts = {}) {
    const box = document.createElement('div');
    box.className = 'tm';
    const crumbs = document.createElement('div');
    crumbs.className = 'crumbs';
    const canvas = document.createElement('div');
    canvas.className = 'tm-body';
    box.appendChild(crumbs);
    box.appendChild(canvas);

    let path = [rootNode];

    function totals(node) {
      if (node.children && node.children.length) {
        return node.children.reduce((sum, child) => sum + totals(child), 0);
      }
      return Math.max(1, node.value || 1);
    }

    function paint() {
      crumbs.innerHTML = path.map((node, index) =>
        `<button class="crumb" data-i="${index}">${esc(node.label)}</button>`).join('<span>›</span>');
      canvas.innerHTML = '';
      canvas.appendChild(renderLevel(path[path.length - 1], 0));
      box.dataset.depth = String(path.length - 1);
    }

    function renderLevel(node, depth) {
      const wrap = document.createElement('div');
      wrap.className = 'tm-level lv' + (depth % 2);
      const total = totals(node);
      const kids = (node.children && node.children.length) ? node.children : [node];
      kids.forEach((child) => {
        const cell = document.createElement('div');
        cell.className = 'tm-cell';
        cell.style.flexGrow = String(Math.max(1, totals(child) / Math.max(1, total) * 100));
        const tint = child.layer ? color(child.layer) : (opts.tint || '#0074c9');
        cell.style.setProperty('--tint', tint);
        const hasKids = child.children && child.children.length;
        // 一次只画一层，点色块下钻；嵌套画三层会把标签挤成竖排
        if (hasKids) cell.classList.add('has-kids');
        cell.innerHTML = `
          <div class="tm-label"><b>${esc(child.label)}</b>
            <small>${esc(child.meta || '')}</small></div>
          ${hasKids ? '<span class="tm-more">下钻 ›</span>' : ''}`;
        cell.addEventListener('click', (event) => {
          event.stopPropagation();
          if (hasKids) {
            path = path.concat(child);
            paint();
          }
          if (onPick) onPick(child);
        });
        wrap.appendChild(cell);
      });
      return wrap;
    }

    crumbs.addEventListener('click', (event) => {
      const button = event.target.closest('.crumb');
      if (!button) return;
      path = path.slice(0, Number(button.dataset.i) + 1);
      paint();
    });

    paint();
    box.renderNode = (node) => { path = [node]; paint(); };
    return box;
  }

  function packageTree(structure) {
    const modules = new Map();
    (structure.files || []).forEach((file) => {
      const path = String(file.path || '').replace(/\\/g, '/');
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '（根目录）';
      const module = dir.split('/').slice(0, 2).join('/') || dir;
      if (!modules.has(module)) modules.set(module, new Map());
      const packages = modules.get(module);
      if (!packages.has(dir)) packages.set(dir, []);
      packages.get(dir).push(file);
    });
    return {
      label: '工程', meta: `${(structure.files || []).length} 个文件`,
      children: [...modules.entries()].map(([module, packages]) => ({
        label: module, meta: `${packages.size} 个包`,
        children: [...packages.entries()].map(([dir, files]) => ({
          label: dir.split('/').slice(-2).join('/') || dir,
          meta: `${files.length} 个文件 · ${files.reduce((s, f) => s + (f.loc || 0), 0)} 行`,
          value: files.reduce((s, f) => s + (f.loc || 1), 0),
          children: files.map((file) => ({
            label: String(file.path || '').replace(/\\/g, '/').split('/').pop(),
            meta: `${(file.classes || []).length} 类 · ${(file.classes || [])
              .reduce((n, c) => n + (c.methods || []).length, 0)} 方法`,
            value: (file.classes || []).reduce((n, c) => n + (c.methods || []).length, 0) || 1,
            layer: (file.classes && file.classes[0] && file.classes[0].layer) || '',
            file,
          })),
        })),
        value: [...packages.values()].reduce((s, files) => s + files.reduce((x, f) => x + (f.loc || 1), 0), 0),
      })),
    };
  }

  function structureMap(structure, hooks) {
    const inspector = document.createElement('div');
    inspector.className = 'insp';
    const node = packageTree(structure);
    const tree = makeTreeMap(node, (picked) => {
      if (!picked.file) {
        inspector.innerHTML = emptyInsp('点最内层的文件，看类、方法与源码位置。');
        return;
      }
      const file = picked.file;
      const base = String(file.path || '').replace(/\\/g, '/').split('/').pop();
      inspector.innerHTML = `
        <p class="eyebrow"><i></i>FILE</p>
        <h4>${esc(base)}</h4>
        ${kv([
          ['路径', `<code>${esc(file.path)}</code>`],
          ['包', `<code>${esc(file.package || (file.classes && file.classes[0] && file.classes[0].package) || '—')}</code>`],
          ['规模', `${(file.classes || []).length} 类 · ${(file.classes || [])
            .reduce((n, c) => n + (c.methods || []).length, 0)} 方法`],
        ])}
        ${(file.classes || []).map((cls) => `
          <div class="insp-block">
            <p><b>${esc(cls.name)}</b> <span class="badge">${esc(cls.layer || '')}</span></p>
            ${(cls.methods || []).slice(0, 8).map((m) => `<p class="small mono">${esc(m.signature || m.name)}</p>`).join('')}
          </div>`).join('')}
        <div class="insp-actions">
          <button class="ghost" data-act="focus" data-path="${esc(file.path)}">在列表里定位</button>
          <a class="btn ghost" href="/api/projects/${state.pid}/files/${file.id}/download"
             download>下载该文件</a>
        </div>`;
      const button = inspector.querySelector('[data-act="focus"]');
      if (button) button.onclick = () => hooks.onFocusFile(file.path);
    });
    inspector.innerHTML = emptyInsp('左边按目录分组，点文件名展开类与方法；点击色块可以逐层下钻。');
    const wrap = document.createElement('div');
    wrap.className = 'map-shell';
    wrap.appendChild(tree);
    wrap.appendChild(inspector);
    return wrap;
  }

  /* -------------------------------------------------------------- 功能树图 */
  function functionMap(functions, hooks) {
    const inspector = document.createElement('div');
    inspector.className = 'insp';
    const root = {
      label: '功能树', meta: `${functions.tree.length} 个模块 · ${functions.leaf_count} 条`,
      children: functions.tree.map((mod) => ({
        label: mod.name,
        meta: `${mod.children.length} 条`,
        value: mod.children.length,
        children: mod.children.map((leaf) => ({
          label: leaf.name,
          meta: (leaf.evidence || '').slice(0, 40),
          value: 1,
          leaf,
        })),
      })),
    };
    const tree = makeTreeMap(root, (picked) => {
      if (!picked.leaf) { inspector.innerHTML = emptyInsp('点具体功能条目，看它落在哪个方法上。'); return; }
      const leaf = picked.leaf;
      inspector.innerHTML = `
        <p class="eyebrow"><i></i>FUNCTION</p>
        <h4>${esc(leaf.name)}</h4>
        ${kv([
          ['说明', esc(leaf.summary || '—')],
          ['证据', `<code>${esc(leaf.evidence || '—')}</code>`],
          ['模块', esc(String(picked.label))],
        ])}
        <div class="insp-actions">
          <button class="ghost" data-act="open">在代码结构里定位</button>
          <button class="ghost" data-act="search">按证据检索</button>
        </div>`;
      inspector.querySelector('[data-act="open"]').onclick = () => hooks.onFocus(leaf.evidence);
      inspector.querySelector('[data-act="search"]').onclick = () => hooks.onSearch(leaf.evidence || leaf.name);
    });
    inspector.innerHTML = emptyInsp('色块按模块分组，越宽代表条目越多。');
    const wrap = document.createElement('div');
    wrap.className = 'map-shell';
    wrap.appendChild(tree);
    wrap.appendChild(inspector);
    return wrap;
  }

  /* -------------------------------------------------------------- 架构图（SVG） */
  function archGraph(architecture, hooks) {
    const layers = architecture.layers || [];
    const width = 1180;
    const colW = 210;
    const gap = 22;
    const positions = {};
    let maxRows = 0;
    layers.forEach((layer) => { maxRows = Math.max(maxRows, layer.components.length); });
    const height = Math.max(420, maxRows * 74 + 60);
    const parts = [];
    parts.push(`<svg viewBox="0 0 ${width} ${height}" class="arch-svg" role="img">`);
    parts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>`);
    layers.forEach((layer, index) => {
      const x = 16 + index * (colW + gap);
      parts.push(`<text x="${x}" y="24" class="layer-label">${esc(layer.name)}</text>`);
      layer.components.forEach((component, row) => {
        const y = 40 + row * 74;
        const id = 'c-' + component.id;
        positions[component.id] = { x, y, w: colW, h: 58, name: component.name, layer: layer.name };
        parts.push(`<g class="node" data-id="${component.id}" tabindex="0">
          <rect x="${x}" y="${y}" width="${colW}" height="58" rx="6" style="stroke:${color(layer.name)}"></rect>
          <text x="${x + 10}" y="${y + 22}" class="node-title">${esc(component.name)}</text>
          <text x="${x + 10}" y="${y + 40}" class="node-meta">${component.classes.length} 类 · ${esc(layer.name)}</text>
          <circle cx="${x + colW - 14}" cy="${y + 14}" r="3" style="fill:${color(layer.name)}"></circle>
        </g>`);
      });
    });
    // 依赖边
    layers.forEach((layer) => layer.components.forEach((component) => {
      const from = positions[component.id];
      (component.depends_on || []).forEach((name) => {
        const target = Object.values(positions).find((p) => p.name === name);
        if (!from || !target) return;
        const x1 = from.x + from.w; const y1 = from.y + from.h / 2;
        const x2 = target.x; const y2 = target.y + target.h / 2;
        const mid = (x1 + x2) / 2;
        parts.push(`<path class="edge" d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 6},${y2}"
          marker-end="url(#arrow)" style="color:${color(from.layer || '')}"></path>`);
      });
    }));
    // 外部依赖
    const externals = architecture.externals || [];
    if (externals.length) {
      const y = height - 34;
      parts.push(`<text x="16" y="${y - 8}" class="layer-label">外部依赖</text>`);
      parts.push(`<text x="16" y="${y + 12}" class="node-meta">${externals.slice(0, 6)
        .map((e) => `${esc(e.name)} ×${e.count}`).join('   ·   ')}</text>`);
    }
    parts.push('</svg>');
    const canvas = document.createElement('div');
    canvas.className = 'arch-canvas';
    canvas.innerHTML = parts.join('');

    const inspector = document.createElement('div');
    inspector.className = 'insp';
    inspector.innerHTML = emptyInsp('点左侧的组件，看它包含哪些类、承载哪些功能。');
    canvas.addEventListener('click', (event) => {
      const group = event.target.closest('.node');
      if (!group) return;
      const id = Number(group.dataset.id);
      const component = layers.flatMap((l) => l.components).find((c) => c.id === id);
      if (!component) return;
      canvas.querySelectorAll('.node rect').forEach((r) => r.classList.remove('on'));
      group.querySelector('rect').classList.add('on');
      const functions = (architecture.component_functions || [])
        .filter((row) => row.component === component.name || row.component_id === component.id)
        .flatMap((row) => row.functions || []);
      inspector.innerHTML = `
        <p class="eyebrow"><i></i>COMPONENT</p>
        <h4>${esc(component.name)}</h4>
        ${kv([
          ['分层', `<span class="badge">${esc(component.layer)}</span>`],
          ['模块', esc(component.module || '—')],
          ['规模', `${component.classes.length} 类`],
          ['依赖', component.depends_on.length ? component.depends_on.map(esc).join('、') : '无传出依赖'],
        ])}
        <p class="rail-label">包含的类</p>
        <p class="chips">${component.classes.slice(0, 12).map((name) => chip(name)).join('')}</p>
        ${functions.length ? `<p class="rail-label">承载的功能</p>
          <p class="chips">${[...new Set(functions)].slice(0, 12).map((name) => chip(name, 'soft')).join('')}</p>` : ''}
        <div class="insp-actions">
          <button class="ghost" data-act="open">在代码结构里看这些类</button>
        </div>`;
      const button = inspector.querySelector('[data-act="open"]');
      if (button) button.onclick = () => hooks.onFocus(component.classes[0] || component.name);
    });
    const wrap = document.createElement('div');
    wrap.className = 'map-shell';
    wrap.appendChild(canvas);
    wrap.appendChild(inspector);
    return wrap;
  }

  /* -------------------------------------------------------------- 影响扩散图 */
  function impactGraph(impact, hooks) {
    // 起点只画一次：impact.classes 里可能也带它自己
    const seen = new Set([impact.origin.id]);
    const others = (impact.classes || []).filter((c) => (seen.has(c.id) ? false : seen.add(c.id)));
    const nodes = [{ id: impact.origin.id, name: impact.origin.name, hop: 0, layer: impact.origin.layer }]
      .concat(others.map((c) => ({ ...c, hop: c.hop || 1 })));
    const maxHop = Math.max(1, impact.max_hop || 1);
    const width = 880; const height = 560;
    const cx = width / 2; const cy = height / 2;
    const ringGap = Math.min(120, (Math.min(width, height) / 2 - 52) / maxHop);
    const byHop = new Map();
    nodes.forEach((node) => {
      if (!byHop.has(node.hop)) byHop.set(node.hop, []);
      byHop.get(node.hop).push(node);
    });
    const pos = {};
    byHop.forEach((list, hop) => {
      list.forEach((node, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(1, list.length) - Math.PI / 2;
        const radius = hop === 0 ? 0 : ringGap * hop;
        pos[node.id] = { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
      });
    });
    const parts = [`<svg viewBox="0 0 ${width} ${height}" class="impact-svg" role="img">`];
    for (let hop = 1; hop <= maxHop; hop += 1) {
      parts.push(`<circle class="ring" cx="${cx}" cy="${cy}" r="${ringGap * hop}"></circle>`);
      const angle = -Math.PI / 4;
      parts.push(`<text class="ring-label" x="${cx + Math.cos(angle) * ringGap * hop + 4}"
        y="${cy + Math.sin(angle) * ringGap * hop - 4}">${hop} 跳</text>`);
    }
    (impact.chains || []).forEach((chain) => {
      for (let i = 1; i < chain.length; i += 1) {
        const a = chain[i - 1]; const b = chain[i];
        const pa = pos[a.id]; const pb = pos[b.id];
        if (!pa || !pb) continue;
        parts.push(`<line class="edge" x1="${pa.x}" y1="${pa.y}" x2="${pb.x}" y2="${pb.y}"></line>`);
      }
    });
    nodes.forEach((node) => {
      const point = pos[node.id];
      if (!point) return;
      const r = node.hop === 0 ? 9 : 6;
      parts.push(`<g class="inode" data-id="${node.id}" tabindex="0">
        <circle cx="${point.x}" cy="${point.y}" r="${r}" style="fill:${color(node.layer)}"></circle>
        <text x="${point.x + 10}" y="${point.y + 4}">${esc(node.name)}</text>
      </g>`);
    });
    parts.push('</svg>');
    const canvas = document.createElement('div');
    canvas.className = 'impact-canvas';
    canvas.innerHTML = parts.join('');

    const inspector = document.createElement('div');
    inspector.className = 'insp';
    inspector.innerHTML = emptyInsp('点任意节点，看它属于哪个模块、涉及哪些功能。');
    canvas.addEventListener('click', (event) => {
      const group = event.target.closest('.inode');
      if (!group) return;
      const node = nodes.find((n) => n.id === Number(group.dataset.id));
      if (!node) return;
      inspector.innerHTML = `
        <p class="eyebrow"><i></i>NODE · ${node.hop === 0 ? 'ORIGIN' : node.hop + ' HOP'}</p>
        <h4>${esc(node.name)}</h4>
        ${kv([
          ['分层', `<span class="badge">${esc(node.layer || '—')}</span>`],
          ['模块', esc(node.module || '—')],
          ['跳数', String(node.hop)],
        ])}
        <div class="insp-actions">
          <button class="ghost" data-act="open">在代码结构里定位</button>
        </div>`;
      inspector.querySelector('[data-act="open"]').onclick = () => hooks.onFocus(node.name);
    });
    const wrap = document.createElement('div');
    wrap.className = 'map-shell';
    wrap.appendChild(canvas);
    wrap.appendChild(inspector);
    return wrap;
  }

  window.viz = { structureMap, functionMap, archGraph, impactGraph, frame, emptyInsp };
})();
