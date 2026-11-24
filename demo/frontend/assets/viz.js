/* 图形化视图（原生 SVG/DOM，无第三方库）
 * 四个页面共用一套“画布 + 右侧检查器”的骨架：左图可点击下钻，右栏给证据与跳转。
 * 依赖 app.js 里的全局 state / 工具函数（按需回退）。
 */
'use strict';

(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // birdview 的配色：低饱和、深底上偏亮，右侧检查器用 mint 做强调
  const LAYER_COLOR = {
    '接入层': '#5fa8d3', '业务层': '#7bc9a8', '数据层': '#b79ce6',
    '领域层': '#e0b072', '公共层': '#9aa7a2', '其他': '#8a9a94', '外部依赖': '#e08a6a',
  };
  const color = (layer) => LAYER_COLOR[layer] || '#8a9a94';

  const legend = (layers) => `<div class="map-legend">${layers
    .filter((l) => LAYER_COLOR[l])
    .map((l) => `<span><i style="background:${color(l)}"></i>${esc(l)}</span>`).join('')}</div>`;

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
  // 一次画三层（模块 → 包 → 文件）的嵌套矩形树，面积按「类数/条目数」分配；
  // 点非叶子矩形下钻（面包屑回退），点叶子看检查器。
  function makeTreeMap(rootNode, onPick, opts = {}) {
    const NS = 'http://www.w3.org/2000/svg';
    // 画布按容器实测宽度画，避免 viewBox 缩放把字缩到看不清
    let W = 860;
    let H = 470;
    const box = document.createElement('div');
    box.className = 'tm';
    const crumbs = document.createElement('div');
    crumbs.className = 'crumbs';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'tm-svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    box.appendChild(crumbs);
    box.appendChild(svg);

    let path = [rootNode];
    // 记录每个节点在整棵树里的绝对层级，下钻后配色与字号不跳变
    (function mark(node, level) {
      node._depth = level;
      (node.children || []).forEach((child) => mark(child, level + 1));
    })(rootNode, 0);

    const weight = (node) => ((node.children && node.children.length)
      ? node.children.reduce((sum, child) => sum + weight(child), 0)
      : Math.max(1, node.value || 1));

    const text = (x, y, str, cls) => {
      const el = document.createElementNS(NS, 'text');
      el.setAttribute('x', String(x));
      el.setAttribute('y', String(y));
      el.setAttribute('class', cls);
      el.textContent = str;
      return el;
    };

    const clip = (str, px) => {
      const max = Math.max(2, Math.floor((px - 14) / 6.4));
      const s = String(str || '');
      return s.length > max ? s.slice(0, max - 1) + '…' : s;
    };

    // 二叉切分：按面积把子节点分成两半，沿较长边切开（比例仍按面积）
    function slice(items, x, y, w, h, out) {
      if (!items.length) return;
      if (items.length === 1) {
        out.push({ node: items[0], x, y, w, h });
        return;
      }
      const total = items.reduce((sum, i) => sum + i._area, 0);
      let acc = 0;
      let cut = 1;
      for (let i = 0; i < items.length - 1; i += 1) {
        acc += items[i]._area;
        cut = i + 1;
        if (acc >= total / 2) break;
      }
      const head = items.slice(0, cut);
      const tail = items.slice(cut);
      const ratio = head.reduce((sum, i) => sum + i._area, 0) / total;
      if (w >= h) {
        slice(head, x, y, w * ratio, h, out);
        slice(tail, x + w * ratio, y, w * (1 - ratio), h, out);
      } else {
        slice(head, x, y, w, h * ratio, out);
        slice(tail, x, y + h * ratio, w, h * (1 - ratio), out);
      }
    }

    function drawNode(node, x, y, w, h, depth, parent) {
      if (w < 3 || h < 3) return null;
      const g = document.createElementNS(NS, 'g');
      const hasKids = !!(node.children && node.children.length);
      const level = Math.min(3, node._depth || depth);
      g.setAttribute('class', `tm-rect d${level}${hasKids ? ' has-kids' : ''}`);
      const rectEl = document.createElementNS(NS, 'rect');
      rectEl.setAttribute('x', String(x + 1));
      rectEl.setAttribute('y', String(y + 1));
      rectEl.setAttribute('width', String(Math.max(1, w - 2)));
      rectEl.setAttribute('height', String(Math.max(1, h - 2)));
      rectEl.setAttribute('rx', level <= 1 ? '4' : '2');
      if (node.layer) rectEl.style.setProperty('--tint', color(node.layer));
      g.appendChild(rectEl);

      const tiny = level === 3 && (w < 74 || h < 34);
      const labelRoom = h > 22 && w > 46 && !tiny;
      if (labelRoom) {
        g.appendChild(text(x + 8, y + 16, clip(node.label, w), 'tm-name'));
        if (h > 40 && w > 86 && node.meta) {
          g.appendChild(text(x + 8, y + 30, clip(node.meta, w), 'tm-meta'));
        }
      }

      const innerTop = y + (labelRoom ? 22 : 6);
      const innerH = h - (labelRoom ? 26 : 10);
      if (hasKids && depth < 3 && innerH > 26 && w > 40) {
        const kids = node.children.map((child) => ({ ...child, _area: weight(child) }));
        kids.sort((a, b) => b._area - a._area);
        const boxes = [];
        slice(kids, x + 4, innerTop, w - 8, innerH, boxes);
        boxes.forEach((b) => drawNode(b.node, b.x, b.y, b.w, b.h, depth + 1, g));
      }

      g.addEventListener('click', (event) => {
        event.stopPropagation();
        if (hasKids && depth < 3) {
          path = path.concat(node);
          paint();
        }
        if (onPick) onPick(node);
      });
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${node.label}${node.meta ? ' · ' + node.meta : ''}`;
      g.appendChild(title);
      parent.appendChild(g);
      return g;
    }

    function measure() {
      const width = box.clientWidth;
      if (width && Math.abs(width - W) > 6) {
        W = width;
        H = Math.round(Math.min(560, Math.max(360, width * 0.56)));
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      }
    }

    function paint() {
      measure();
      const cur = path[path.length - 1];
      crumbs.innerHTML = path.map((node, index) =>
        `<button class="crumb" data-i="${index}">${esc(node.label)}</button>`).join('<span>›</span>');
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const kids = (cur.children || []).map((child) => ({ ...child, _area: weight(child) }));
      kids.sort((a, b) => b._area - a._area);
      const boxes = [];
      slice(kids, 0, 0, W, H, boxes);
      boxes.forEach((b) => drawNode(b.node, b.x, b.y, b.w, b.h, 1, svg));
      box.dataset.depth = String(path.length - 1);
    }

    crumbs.addEventListener('click', (event) => {
      const button = event.target.closest('.crumb');
      if (!button) return;
      path = path.slice(0, Number(button.dataset.i) + 1);
      paint();
    });

    paint();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { measure(); paint(); });
    }
    box.renderNode = (node) => { path = [node]; paint(); };
    return box;
  }

  function dominantLayer(files) {
    const counts = new Map();
    files.forEach((f) => (f.classes || []).forEach((c) => {
      if (c.layer) counts.set(c.layer, (counts.get(c.layer) || 0) + 1);
    }));
    let best = '';
    let max = 0;
    counts.forEach((n, layer) => { if (n > max) { max = n; best = layer; } });
    return best;
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
          meta: `${files.length} 个文件 · ${files.reduce((s, f) => s + (f.classes || []).length, 0)} 个类`,
          layer: dominantLayer(files),
          value: files.reduce((s, f) => s + Math.max(1, (f.classes || []).length), 0),
          children: files.map((file) => ({
            label: String(file.path || '').replace(/\\/g, '/').split('/').pop(),
            meta: `${(file.classes || []).length} 类 · ${(file.classes || [])
              .reduce((n, c) => n + (c.methods || []).length, 0)} 方法`,
            value: Math.max(1, (file.classes || []).length),
            layer: (file.classes && file.classes[0] && file.classes[0].layer) || '',
            file,
          })),
        })),
        value: [...packages.values()].reduce((s, files) => s + files.reduce((x, f) => x + Math.max(1, (f.classes || []).length), 0), 0),
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
    inspector.innerHTML = emptyInsp('面积代表类数。点大块下钻到包，点文件块看类、方法、字段与源码位置。');
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
    inspector.innerHTML = emptyInsp('面积代表功能条目数。点模块块看条目，点条目块看证据方法。');
    const wrap = document.createElement('div');
    wrap.className = 'map-shell';
    wrap.appendChild(tree);
    wrap.appendChild(inspector);
    return wrap;
  }

  /* -------------------------------------------------------------- 架构图（SVG） */
  function archGraph(architecture, hooks) {
    // 行=模块、列=分层：同一模块的组件排在一行，依赖关系读起来是「往下走」，不再是一团交叉线
    const BASE_LAYERS = ['接入层', '业务层', '数据层', '领域层', '公共层'];
    const layers = architecture.layers || [];
    const all = layers.flatMap((layer) => layer.components.map((c) => ({ ...c, layer: c.layer || layer.name })));
    const extra = [...new Set(all.map((c) => c.layer).filter((name) => !BASE_LAYERS.includes(name)))];
    const LAYERS = BASE_LAYERS.concat(extra);
    const components = all.filter((c) => LAYERS.includes(c.layer));
    // 组件名形如「通知用户管理·接入」，按前缀归并成模块行
    const baseModule = (c) => String(c.name || c.module || '').split('·')[0];
    const byModule = new Map();
    components.forEach((c) => {
      const mod = baseModule(c);
      if (!byModule.has(mod)) byModule.set(mod, { name: mod, total: 0, cells: new Map() });
      const row = byModule.get(mod);
      row.total += c.classes.length;
      const slot = row.cells.get(c.layer);
      if (slot) slot.push(c); else row.cells.set(c.layer, [c]);
    });
    const rows = [...byModule.values()].sort((a, b) => b.total - a.total);

    const grid = document.createElement('div');
    grid.className = 'arch-matrix';
    grid.style.gridTemplateColumns = `168px repeat(${LAYERS.length}, minmax(0, 1fr))`;
    grid.innerHTML = ['<div class="am-corner">模块 / 分层</div>']
      .concat(LAYERS.map((l) => `<div class="am-head">${esc(l)}</div>`))
      .join('');
    rows.forEach((row, ri) => {
      grid.insertAdjacentHTML('beforeend',
        `<div class="am-mod" data-row="${ri}"><b>${esc(row.name)}</b><small>${row.total} 类</small></div>`);
      LAYERS.forEach((l) => {
        const list = row.cells.get(l) || [];
        if (!list.length) {
          grid.insertAdjacentHTML('beforeend', `<div class="am-cell empty" data-row="${ri}"></div>`);
          return;
        }
        const c = list[0];
        grid.insertAdjacentHTML('beforeend', `
          <div class="am-cell" data-row="${ri}" data-id="${c.id}" style="--tint:${color(l)}">
            <b>${c.classes.length} 类</b>
            <small>${c.depends_on.length ? c.depends_on.length + ' 条依赖' : '无传出依赖'}</small>
            ${list.length > 1 ? `<em>+${list.length - 1} 个组件</em>` : ''}
          </div>`);
      });
    });

    const wrap = document.createElement('div');
    wrap.className = 'map-shell';
    const pane = document.createElement('div');
    pane.className = 'map-pane';
    pane.appendChild(grid);
    pane.insertAdjacentHTML('beforeend', legend(LAYERS));
    wrap.appendChild(pane);

    const inspector = document.createElement('div');
    inspector.className = 'insp';
    inspector.innerHTML = emptyInsp('点格子看组件：包含哪些类、依赖谁、承载哪些功能。左边一行就是一个模块。');

    const mark = (rowIndex) => {
      grid.querySelectorAll('.am-cell, .am-mod').forEach((cell) => {
        cell.classList.toggle('hot', cell.dataset.row === String(rowIndex));
      });
    };
    grid.addEventListener('mouseover', (event) => {
      const cell = event.target.closest('[data-row]');
      if (cell) mark(cell.dataset.row);
    });
    grid.addEventListener('mouseleave', () => mark(-1));

    grid.addEventListener('click', (event) => {
      const cell = event.target.closest('.am-cell[data-id]');
      if (!cell) return;
      const id = Number(cell.dataset.id);
      const component = components.find((c) => c.id === id);
      if (!component) return;
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

    wrap.appendChild(inspector);
    return wrap;
  }

  /* -------------------------------------------------------------- 影响扩散图 */
  function impactGraph(impact, hooks) {
    const seen = new Set([impact.origin.id]);
    const others = (impact.classes || []).filter((c) => (seen.has(c.id) ? false : seen.add(c.id)));
    const nodes = [{ id: impact.origin.id, name: impact.origin.name, hop: 0, layer: impact.origin.layer,
      module: impact.origin.module || '', parent: null }]
      .concat(others.map((c) => ({ ...c, hop: c.hop || 1 })));
    const maxHop = Math.max(1, impact.max_hop || 1);
    const byHop = new Map();
    nodes.forEach((node) => {
      if (!byHop.has(node.hop)) byHop.set(node.hop, []);
      byHop.get(node.hop).push(node);
    });
    byHop.forEach((list) => list.sort((a, b) =>
      (a.module || '').localeCompare(b.module || '') || (a.name || '').localeCompare(b.name || '')));

    const cardW = 168; const cardH = 46; const gapX = 54; const gapY = 14; const padTop = 44; const padBottom = 26;
    const cols = maxHop + 1;
    const width = cols * cardW + (cols - 1) * gapX + 24;
    let rows = 1;
    byHop.forEach((list) => { rows = Math.max(rows, list.length); });
    const height = padTop + rows * (cardH + gapY) + padBottom;
    const pos = {};
    byHop.forEach((list, hop) => {
      const x = 12 + hop * (cardW + gapX);
      list.forEach((node, index) => {
        pos[node.id] = { x, y: padTop + index * (cardH + gapY), w: cardW, h: cardH };
      });
    });

    const parts = [`<svg viewBox="0 0 ${width} ${height}" class="impact-svg" role="img">`];
    // 列标题
    byHop.forEach((list, hop) => {
      const x = 12 + hop * (cardW + gapX);
      parts.push(`<text class="hop-title" x="${x}" y="24">${hop === 0 ? '起点' : hop + ' 跳'} · ${list.length}</text>`);
    });
    // 父 → 子连线
    nodes.forEach((node) => {
      const from = node.parent != null ? pos[node.parent] : null;
      const to = pos[node.id];
      if (!from || !to) return;
      const x1 = from.x + from.w; const y1 = from.y + from.h / 2;
      const x2 = to.x; const y2 = to.y + to.h / 2;
      const mx = (x1 + x2) / 2;
      parts.push(`<path class="edge" d="M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"></path>`);
    });
    // 节点卡片
    nodes.forEach((node) => {
      const p = pos[node.id];
      if (!p) return;
      parts.push(`<g class="inode${node.hop === 0 ? ' origin' : ''}" data-id="${node.id}" tabindex="0">
        <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="5"></rect>
        <circle cx="${p.x + 15}" cy="${p.y + 17}" r="4" style="fill:${color(node.layer)}"></circle>
        <text class="iname" x="${p.x + 27}" y="${p.y + 21}">${esc(node.name)}</text>
        <text class="imeta" x="${p.x + 27}" y="${p.y + 35}">${esc(node.module || node.layer || '')}</text>
      </g>`);
    });
    parts.push('</svg>');
    const canvas = document.createElement('div');
    canvas.className = 'impact-canvas';
    canvas.innerHTML = parts.join('');

    const inspector = document.createElement('div');
    inspector.className = 'insp';
    inspector.innerHTML = emptyInsp('点任意卡片，看它在哪一层、属于哪个模块，以及从起点过来的路径。');
    const onClick = (event) => {
      const group = event.target.closest('.inode');
      if (!group) return;
      const node = nodes.find((n) => n.id === Number(group.dataset.id));
      if (!node) return;
      const trail = [];
      let cursor = node;
      while (cursor && trail.length < 8) { trail.unshift(cursor.name); cursor = nodes.find((n) => n.id === cursor.parent); }
      inspector.innerHTML = `
        <p class="eyebrow"><i></i>NODE · ${node.hop === 0 ? 'ORIGIN' : node.hop + ' HOP'}</p>
        <h4>${esc(node.name)}</h4>
        ${kv([
          ['分层', `<span class="badge">${esc(node.layer || '—')}</span>`],
          ['模块', esc(node.module || '—')],
          ['跳数', String(node.hop)],
          ['路径', `<span class="mono">${esc(trail.join(' ← '))}</span>`],
        ])}
        <div class="insp-actions">
          <button class="ghost" data-act="open">在代码结构里定位</button>
        </div>`;
      inspector.querySelector('[data-act="open"]').onclick = () => hooks.onFocus(node.name);
    };
    const wrap = document.createElement('div');
    wrap.className = 'map-shell';
    const pane = document.createElement('div');
    pane.className = 'map-pane';
    const scroll = document.createElement('div');
    scroll.className = 'impact-canvas';
    scroll.appendChild(canvas.firstChild);
    scroll.addEventListener('click', onClick);
    pane.appendChild(scroll);
    const usedLayers = [...new Set(nodes.map((n) => n.layer).filter(Boolean))];
    pane.insertAdjacentHTML('beforeend', legend(usedLayers.length
      ? usedLayers : ['接入层', '业务层', '数据层', '领域层', '公共层']));
    wrap.appendChild(pane);
    wrap.appendChild(inspector);
    return wrap;
  }
  window.viz = { structureMap, functionMap, archGraph, impactGraph, frame, emptyInsp };
})();
