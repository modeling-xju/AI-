/* 力导向关系图：节点 + 带箭头的边，供四个图谱页共用。
   只画关系，不承载面积/层级语义；点击节点由页面决定右侧检查器写什么。 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  const LAYER_COLOR = {
    接入层: '#0891b2', 业务层: '#7c3aed', 数据层: '#14b8a6', 领域层: '#e8a33d',
    公共层: '#10b981', 外部依赖: '#d4a017', 其他: '#64748b',
  };
  const EDGE_COLOR = { contains: '#b6c3d1', depends: '#7c8ea3', dynamic: '#d4a017', call: '#9aa8bb' };

  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function textW(text) {
    let w = 0;
    for (const ch of String(text || '')) w += /[\u3400-\u9fff\uff00-\uffef]/.test(ch) ? 12 : 6.7;
    return w;
  }
  function clip(text, maxW) {
    const s = String(text == null ? '' : text);
    if (textW(s) <= maxW) return s;
    let out = '';
    for (const ch of s) {
      if (textW(out + ch) > maxW - 10) break;
      out += ch;
    }
    return out + '…';
  }

  function colorOf(node) {
    return node.color || LAYER_COLOR[node.layer] || LAYER_COLOR['其他'];
  }

  function layout(nodes, edges, W, H, iters) {
    const anchors = nodes.map((nd) => (typeof nd.anchor === 'number' ? nd.anchor : null));
    const n = nodes.length;
    if (!n) return;
    const idx = new Map();
    nodes.forEach((nd, i) => { idx.set(nd.id, i); });
    const cx = W / 2;
    const cy = H / 2;
    const r0 = Math.min(W, H) * 0.33;
    nodes.forEach((nd, i) => {
      const a = (i / n) * Math.PI * 2;
      nd.x = cx + Math.cos(a) * r0;
      nd.y = cy + Math.sin(a) * r0;
      nd.w = Math.max(58, Math.min(196, textW(nd.label) + 26));
      nd.h = 30;
    });
    const links = edges.map((e) => ({ s: idx.get(e.source), t: idx.get(e.target) }))
      .filter((l) => l.s != null && l.t != null);
    const k = Math.sqrt((W * H) / Math.max(1, n)) * 0.95;
    const disp = nodes.map(() => ({ x: 0, y: 0 }));
    for (let it = 0; it < iters; it += 1) {
      for (let i = 0; i < n; i += 1) { disp[i].x = 0; disp[i].y = 0; }
      for (let i = 0; i < n; i += 1) {
        for (let j = i + 1; j < n; j += 1) {
          let dx = nodes[i].x - nodes[j].x;
          let dy = nodes[i].y - nodes[j].y;
          if (!dx && !dy) { dx = (i - j) * 0.31; dy = 0.17; }
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const f = (k * k) / d;
          disp[i].x += (dx / d) * f; disp[i].y += (dy / d) * f;
          disp[j].x -= (dx / d) * f; disp[j].y -= (dy / d) * f;
        }
      }
      links.forEach((l) => {
        const a = nodes[l.s];
        const b = nodes[l.t];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d * d) / k;
        disp[l.s].x += (dx / d) * f * 0.55;
        disp[l.s].y += (dy / d) * f * 0.55;
        disp[l.t].x -= (dx / d) * f * 0.55;
        disp[l.t].y -= (dy / d) * f * 0.55;
      });
      const t = Math.max(1.2, (Math.min(W, H) / 10) * (1 - it / iters));
      nodes.forEach((nd, i) => {
        const ax = anchors[i];
        if (ax === null) {
          disp[i].x += (cx - nd.x) * 0.06;
        } else {
          disp[i].x += (W * ax - nd.x) * 0.10;
          disp[i].y += (cy - nd.y) * 0.04;
        }
        disp[i].y += (cy - nd.y) * 0.0;
        const d = Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y) || 1;
        nd.x += (disp[i].x / d) * Math.min(d, t);
        nd.y += (disp[i].y / d) * Math.min(d, t);
        nd.x = Math.max(nd.w / 2 + 8, Math.min(W - nd.w / 2 - 8, nd.x));
        nd.y = Math.max(nd.h / 2 + 8, Math.min(H - nd.h / 2 - 8, nd.y));
      });
    }
    if (nodes.some((nd) => typeof nd.anchor === 'number')) snapColumns(nodes, W, H);
    else separate(nodes, W, H);
  }

  // 分层锚点：同层节点落在同一列，列内按 y 排序纵向排布，避免卡片互相遮挡
  function snapColumns(nodes, W, H) {
    const groups = new Map();
    nodes.forEach((nd) => {
      const key = typeof nd.anchor === 'number' ? nd.anchor : 0.94;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(nd);
    });
    [...groups.keys()].sort((a, b) => a - b).forEach((key) => {
      const list = groups.get(key).sort((a, b) => a.y - b.y || String(a.label).localeCompare(String(b.label)));
      const colX = Math.max(80, Math.min(W - 80, W * key));
      const rowH = Math.max(30, Math.min(52, (H - 70) / Math.max(1, list.length)));
      const perCol = Math.max(1, Math.floor((H - 46) / rowH));
      const subs = Math.ceil(list.length / perCol);
      list.forEach((nd, i) => {
        const sub = Math.floor(i / perCol);
        const row = i % perCol;
        const offset = (sub - (subs - 1) / 2) * 150;
        nd.x = Math.max(nd.w / 2 + 8, Math.min(W - nd.w / 2 - 8, colX + offset));
        const count = Math.min(perCol, list.length - sub * perCol);
        const startY = (H - (count - 1) * rowH) / 2;
        nd.y = Math.max(nd.h / 2 + 10, Math.min(H - nd.h / 2 - 10, startY + row * rowH));
      });
    });
  }

  function separate(nodes, W, H) {
    for (let round = 0; round < 60; round += 1) {
      let moved = false;
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const ox = (a.w + b.w) / 2 + 10 - Math.abs(dx);
          const oy = (a.h + b.h) / 2 + 8 - Math.abs(dy);
          if (ox <= 0 || oy <= 0) continue;
          moved = true;
          if (ox / (a.w + b.w) < oy / (a.h + b.h)) {
            const sh = (dx >= 0 ? 1 : -1) * ox * 0.5;
            a.x -= sh; b.x += sh;
          } else {
            const sh = (dy >= 0 ? 1 : -1) * oy * 0.5;
            a.y -= sh; b.y += sh;
          }
        }
      }
      nodes.forEach((nd) => {
        nd.x = Math.max(nd.w / 2 + 8, Math.min(W - nd.w / 2 - 8, nd.x));
        nd.y = Math.max(nd.h / 2 + 8, Math.min(H - nd.h / 2 - 8, nd.y));
      });
      if (!moved) break;
    }
  }

  // 自上而下分层：level = 行，行内按顺序水平铺开，行标题写在左侧
  function layoutTree(nodes, W, H) {
    const rows = new Map();
    nodes.forEach((nd) => {
      const lv = nd.level || 0;
      if (!rows.has(lv)) rows.set(lv, []);
      rows.get(lv).push(nd);
    });
    const keys = [...rows.keys()].sort((a, b) => a - b);
    const top = 42;
    const bottom = 22;
    const rowGap = keys.length > 1 ? Math.min(220, (H - top - bottom) / (keys.length - 1)) : 0;
    const MIN_W = 64;
    const MIN_GAP = 10;
    const perRow = Math.max(1, Math.floor((W - 40) / 132));
    const subGap = 38;

    keys.forEach((lv, ri) => {
      const list = rows.get(lv).sort((a, b) => (a.order || 0) - (b.order || 0));
      // 一行放不下就折成若干子行，避免节点被画到画布外
      const chunks = [];
      for (let i = 0; i < list.length; i += perRow) chunks.push(list.slice(i, i + perRow));
      chunks.forEach((chunk, ci) => {
        chunk.forEach((nd) => {
          nd.w = Math.max(MIN_W, Math.min(196, textW(nd.label) + 24));
          nd.h = 30;
        });
        let total = chunk.reduce((n, nd) => n + nd.w, 0);
        // 一行总宽超过画布时等比收窄，避免节点被裁到画布外
        if (total + MIN_GAP * (chunk.length - 1) > W - 60) {
          const fit = Math.max(56, Math.floor((W - 60 - MIN_GAP * (chunk.length - 1)) / chunk.length));
          chunk.forEach((nd) => { nd.w = Math.min(nd.w, fit); });
          total = chunk.reduce((n, nd) => n + nd.w, 0);
        }
        const gap = chunk.length > 1
          ? Math.max(MIN_GAP, Math.min(26, (W - 60 - total) / (chunk.length - 1)))
          : 0;
        const span = total + gap * Math.max(0, chunk.length - 1);
        let x = Math.max(30, (W - span) / 2);
        const y = top + rowGap * ri + ci * subGap;
        chunk.forEach((nd) => {
          nd.x = x + nd.w / 2;
          nd.y = y;
          x += nd.w + gap;
        });
      });
    });
  }

  function forceGraph(opts) {
    const {
      nodes = [], edges = [], width = 900, height = 560, title = '',
      onPick = null, onDblClick = null, inspector = null, legend = [], emptyNote = '',
      vertical = false,
    } = opts || {};
    const box = document.createElement('div');
    box.className = 'fg';
    box.innerHTML = `<div class="fg-head"><span class="fg-title">${esc(title)}</span><span class="fg-count">${nodes.length} 节点 · ${edges.length} 关系</span></div>`;
    const view = document.createElement('div');
    view.className = 'fg-view';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'fg-svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    // 行标题：按 level 取第一行的 levelLabel
    const rowLabels = new Map();
    nodes.forEach((nd) => {
      const lv = nd.level || 0;
      if (!rowLabels.has(lv) && (nd.levelLabel || nd.layer)) rowLabels.set(lv, nd.levelLabel || nd.layer);
    });
    const top = 46;
    const bottom = 26;
    const levels = [...new Set(nodes.map((nd) => nd.level || 0))].sort((a, b) => a - b);
    const rowGap = vertical && levels.length > 1 ? (height - top - bottom) / (levels.length - 1) : 0;
    const colText = vertical
      ? levels.map((lv, i) => `<text class="fg-col" x="14" y="${top + rowGap * i + 4}">${esc(rowLabels.get(lv) || '')}</text>`).join('')
      : '';
    svg.innerHTML = `
      <defs>
        <marker id="fg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="#7c8ea3"></path>
        </marker>
        <marker id="fg-arrow-dyn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill="#d4a017"></path>
        </marker>
      </defs>
      <g class="fg-cols">${colText}</g>
      <g class="fg-cam"><g class="fg-edges"></g><g class="fg-nodes"></g></g>`;
    view.appendChild(svg);
    box.appendChild(view);
    if (legend.length) {
      const lg = document.createElement('div');
      lg.className = 'fg-legend';
      lg.innerHTML = legend.map((l) => `<span class="lg"><i class="dot" style="--g:${LAYER_COLOR[l] || '#64748b'}"></i>${esc(l)}</span>`).join('');
      box.appendChild(lg);
    }
    if (emptyNote) box.insertAdjacentHTML('beforeend', `<p class="muted small fg-note">${esc(emptyNote)}</p>`);

    if (!nodes.length) return box;
    if (vertical) layoutTree(nodes, width, height);
    else layout(nodes, edges, width, height, nodes.length > 90 ? 120 : 200);

    const cam = svg.querySelector('.fg-cam');
    const gEdges = svg.querySelector('.fg-edges');
    const gNodes = svg.querySelector('.fg-nodes');
    const byId = new Map(nodes.map((nd) => [nd.id, nd]));

    function edgePath(a, b) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / d;
      const uy = dy / d;
      const pad = 4;
      const startX = a.x + ux * (a.w / 2 + pad);
      const startY = a.y + uy * (a.h / 2 + pad);
      const endX = b.x - ux * (b.w / 2 + pad + 3);
      const endY = b.y - uy * (b.h / 2 + pad + 3);
      const mx = (startX + endX) / 2 - uy * 12;
      const my = (startY + endY) / 2 + ux * 12;
      return `M${startX},${startY} Q${mx},${my} ${endX},${endY}`;
    }

    function drawEdges() {
      gEdges.innerHTML = edges.map((e) => {
        const a = byId.get(e.source);
        const b = byId.get(e.target);
        if (!a || !b) return '';
        const kind = e.kind || 'contains';
        const color = EDGE_COLOR[kind] || EDGE_COLOR.contains;
        const marker = kind === 'dynamic' ? 'fg-arrow-dyn' : 'fg-arrow';
        const dash = kind === 'dynamic' ? ' stroke-dasharray="5 3"' : '';
        const op = kind === 'contains' ? '0.9' : '0.75';
        return `<path class="fg-edge ${kind}" d="${edgePath(a, b)}" fill="none" stroke="${color}" stroke-width="${kind === 'dynamic' ? 1.4 : 1.2}" opacity="${op}"${dash} marker-end="url(#${marker})"><title>${esc(a.label)} → ${esc(b.label)}${e.label ? '：' + esc(e.label) : ''}</title></path>`;
      }).join('');
    }

    function drawNodes() {
      gNodes.innerHTML = nodes.map((nd) => {
        const color = colorOf(nd);
        const x = nd.x - nd.w / 2;
        const y = nd.y - nd.h / 2;
        const label = clip(nd.label, nd.w - 16);
        return `<g class="fg-node" data-id="${esc(nd.id)}" transform="translate(${x},${y})">
          <rect width="${nd.w}" height="${nd.h}" rx="7" fill="#ffffff" stroke="${color}" stroke-width="1.6"></rect>
          <rect width="3" height="${nd.h}" rx="1.5" fill="${color}"></rect>
          <text x="10" y="${nd.h / 2 + 4}" font-size="11.5" fill="#172033">${esc(label)}</text>
          <title>${esc(nd.label)}${nd.meta ? '\n' + esc(nd.meta) : ''}</title>
        </g>`;
      }).join('');
    }

    drawEdges();
    drawNodes();

    // 点击节点 → 右侧检查器；双击 → 展开/折叠子层
    let picked = null;
    function select(node) {
      picked = node;
      gNodes.querySelectorAll('.fg-node rect:first-child').forEach((r) => r.setAttribute('stroke-width', '1.6'));
      const g = gNodes.querySelector(`.fg-node[data-id="${CSS.escape(node.id)}"]`);
      const rect = g && g.querySelector('rect');
      if (rect) rect.setAttribute('stroke-width', '2.6');
      if (inspector && onPick) inspector.innerHTML = onPick(node) || '';
    }

    // 拖拽节点：位移超过 4px 才算拖动，否则按点击处理
    let drag = null;
    gNodes.addEventListener('pointerdown', (event) => {
      const g = event.target.closest('.fg-node');
      if (!g) return;
      drag = {
        node: byId.get(g.getAttribute('data-id')),
        sx: event.clientX, sy: event.clientY, moved: false,
      };
    });
    svg.addEventListener('pointermove', (event) => {
      if (!drag) return;
      if (!drag.moved && Math.abs(event.clientX - drag.sx) + Math.abs(event.clientY - drag.sy) < 4) return;
      drag.moved = true;
      const pt = svgPoint(svg, event);
      drag.node.x = pt.x;
      drag.node.y = pt.y;
      const g = gNodes.querySelector(`.fg-node[data-id="${CSS.escape(drag.node.id)}"]`);
      if (g) g.setAttribute('transform', `translate(${drag.node.x - drag.node.w / 2},${drag.node.y - drag.node.h / 2})`);
      drawEdges();
    });
    svg.addEventListener('pointerup', () => {
      if (drag && !drag.moved) select(drag.node);
      drag = null;
    });
    gNodes.addEventListener('dblclick', (event) => {
      const g = event.target.closest('.fg-node');
      if (!g || !onDblClick) return;
      const node = byId.get(g.getAttribute('data-id'));
      if (node) onDblClick(node);
    });

    // 滚轮缩放 + 空白拖拽平移
    let scale = 1;
    let pan = { x: 0, y: 0 };
    view.addEventListener('wheel', (event) => {
      event.preventDefault();
      scale = Math.max(0.5, Math.min(2.4, scale * (event.deltaY < 0 ? 1.12 : 0.89)));
      cam.setAttribute('transform', `translate(${pan.x},${pan.y}) scale(${scale})`);
    }, { passive: false });
    let panStart = null;
    svg.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.fg-node')) return;
      panStart = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
    });
    window.addEventListener('pointermove', (event) => {
      if (!panStart) return;
      pan = { x: panStart.px + (event.clientX - panStart.x), y: panStart.py + (event.clientY - panStart.y) };
      cam.setAttribute('transform', `translate(${pan.x},${pan.y}) scale(${scale})`);
    });
    window.addEventListener('pointerup', () => { panStart = null; });

    return box;
  }

  function svgPoint(svg, event) {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return {
      x: ((event.clientX - rect.left) / rect.width) * vb.width,
      y: ((event.clientY - rect.top) / rect.height) * vb.height,
    };
  }

  window.graphlib = { forceGraph, LAYER_COLOR, esc, textW, clip };
})();
