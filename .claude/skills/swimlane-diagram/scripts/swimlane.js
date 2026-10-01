/* Swimlane renderer (runs in the browser). Swimlane.render(spec) returns an <svg>.

   spec = {
     aria:   one sentence describing the diagram (alt text),
     lanes:  [{ id, name, sub?, tint?: 'grey' | 'blue' }]  top to bottom,
     phases: [{ n: 'heading', c: 'caption', w: relative width, tone?: 'bad' }]  left to right,
     items:  [lane, phase, x (0..1 inside the phase), row, kind, text, id?, startedBy?]
             or { k: 'track' | 'span', lane, p, to?, x0?, x1?, t, tone?: 'bad' | 'end' },
     links:  [{ a: id, b: id, style?: 'solid' | 'trigger' }],
     marks:  [{ on: id, n: number, lvl?: 'hi' | 'lo' }],
     legend: { <kind>: 'label', solid: 'label', trigger: 'label', mark: 'label' } | false,
     timeLabel: text in the top-left corner (default 'TIME →'),
   }
   kinds: chip (event or record), bad (bad outcome), timer (scheduled), void (cancelled, never happens),
          run (process started by an event), runT (process started by a timer), fail (process failed),
          track (status bar), span (dashed range) */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var W = 1280, X0 = 176, X1 = 1268, HEAD = 52, TOP = 12, ROW = 32, CH = 24, BOT = 12;
  var ICON = { timer: 16, void: 16, runT: 16, run: 14, fail: 14 };
  var BOLD = { run: true, runT: true, fail: true };
  var LEGEND = {
    chip: 'event', bad: 'problem', track: 'status', timer: 'scheduled', void: 'cancelled',
    run: 'started by an event', runT: 'started by a timer', fail: 'failed',
    solid: 'fires', trigger: 'starts', mark: 'note'
  };
  var ORDER = ['chip', 'bad', 'track', 'timer', 'void', 'run', 'runT', 'fail'];
  var seq = 0, measure = null;

  function font() { return window.SWIMLANE_FONT || 'system-ui, sans-serif'; }
  function textWidth(text, bold) {
    measure = measure || document.createElement('canvas').getContext('2d');
    measure.font = (bold ? '600' : '400') + ' 11.5px ' + font();
    return measure.measureText(text).width;
  }
  function el(tag, attrs, parent, text) {
    var node = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }
  function normalise(item) {
    if (!Array.isArray(item)) return item;
    return { lane: item[0], p: item[1], x: item[2], r: item[3], k: item[4], t: item[5], id: item[6], by: item[7] };
  }
  function chipWidth(k, text) { return Math.ceil(textWidth(text, BOLD[k])) + 20 + (ICON[k] || 0); }

  function render(spec) {
    var id = 'sw' + (++seq);
    var lanes = spec.lanes;
    var laneAt = {};
    lanes.forEach(function (l, i) { laneAt[l.id] = i; });
    var items = spec.items.map(normalise);
    var words = {};
    Object.keys(LEGEND).forEach(function (k) { words[k] = LEGEND[k]; });
    Object.keys(spec.legend || {}).forEach(function (k) { words[k] = spec.legend[k]; });

    // phases share the drawing width by weight
    var total = 0;
    spec.phases.forEach(function (p) { total += p.w || 1; });
    var phases = [], cursor = X0;
    spec.phases.forEach(function (p) {
      var w = (X1 - X0) * (p.w || 1) / total;
      phases.push({ x: cursor, w: w, spec: p });
      cursor += w;
    });

    // each lane is as tall as its deepest row
    var rows = lanes.map(function () { return 1; });
    items.forEach(function (it) { var li = laneAt[it.lane]; rows[li] = Math.max(rows[li], (it.r || 0) + 1); });
    var bands = [], y = HEAD;
    lanes.forEach(function (l, i) {
      var h = TOP + rows[i] * ROW - (ROW - CH) + BOT;
      bands.push({ y: y, h: h });
      y += h;
    });
    var lanesBottom = y;

    // place every item
    var byId = {};
    items.forEach(function (it, i) {
      var li = laneAt[it.lane], P = phases[it.p];
      var g = { it: it, li: li, r: it.r || 0 };
      g.y = bands[li].y + TOP + g.r * ROW;
      if (it.k === 'track' || it.k === 'span') {
        var Q = phases[it.to !== undefined ? it.to : it.p];
        g.x = P.x + P.w * (it.x0 !== undefined ? it.x0 : 0.03);
        g.w = Q.x + Q.w * (it.x1 !== undefined ? it.x1 : 0.97) - g.x;
      } else {
        g.w = chipWidth(it.k || 'chip', it.t);
        var cx = P.x + P.w * (it.x !== undefined ? it.x : 0.5);
        g.x = cx - g.w / 2;
        if (g.w <= P.w - 8) g.x = Math.max(P.x + 4, Math.min(g.x, P.x + P.w - 4 - g.w));
      }
      g.key = it.id || ('n' + i);
      byId[g.key] = g;
      it._g = g;
    });

    // push apart chips that share a lane row
    var groups = {};
    items.forEach(function (it) {
      if (it.k === 'track' || it.k === 'span') return;
      var key = it._g.li + ':' + it._g.r;
      (groups[key] = groups[key] || []).push(it._g);
    });
    Object.keys(groups).forEach(function (key) {
      var list = groups[key].sort(function (a, b) { return a.x - b.x; });
      for (var i = 1; i < list.length; i++) {
        var prev = list[i - 1];
        if (list[i].x < prev.x + prev.w + 6) list[i].x = prev.x + prev.w + 6;
      }
    });

    var svg = el('svg', { class: 'd sw', viewBox: '0 0 ' + W + ' 200', role: 'img', 'aria-label': spec.aria || '' });
    var defs = el('defs', {}, svg);
    [['a', 'm-ink'], ['c', 'm-acc']].forEach(function (m) {
      var mk = el('marker', { id: id + '-' + m[0], viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
      el('path', { class: m[1], d: 'M0,0 L10,5 L0,10 z' }, mk);
    });
    var clock = el('g', { id: id + '-clk' }, defs);
    el('circle', { r: 5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3 }, clock);
    el('path', { d: 'M0,-3 V0 H2.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round' }, clock);

    // lanes, labels, phases
    var base = el('g', {}, svg);
    lanes.forEach(function (l, i) {
      var b = bands[i];
      if (l.tint) el('rect', { class: 'band ' + l.tint, x: 8, y: b.y, width: W - 16, height: b.h }, base);
      el('line', { class: 'laneline', x1: 8, y1: b.y, x2: W - 8, y2: b.y }, base);
      var cy = b.y + b.h / 2;
      el('text', { class: 't', x: 18, y: l.sub ? cy - 2 : cy + 5 }, base, l.name);
      if (l.sub) el('text', { class: 's', x: 18, y: cy + 14 }, base, l.sub);
    });
    el('line', { class: 'laneline', x1: 8, y1: lanesBottom, x2: W - 8, y2: lanesBottom }, base);
    el('line', { class: 'laneline', x1: X0 - 8, y1: 12, x2: X0 - 8, y2: lanesBottom }, base);
    el('text', { class: 'eb', x: 18, y: 28 }, base, spec.timeLabel === undefined ? 'TIME →' : spec.timeLabel);
    phases.forEach(function (P, i) {
      if (i > 0) el('line', { class: 'phase', x1: P.x, y1: 12, x2: P.x, y2: lanesBottom }, base);
      var tone = P.spec.tone ? ' ' + P.spec.tone : '';
      el('text', { class: 'eb' + tone, x: P.x + P.w / 2, y: 26, 'text-anchor': 'middle' }, base, P.spec.n.toUpperCase());
      if (P.spec.c) el('text', { class: 's', x: P.x + P.w / 2, y: 42, 'text-anchor': 'middle' }, base, P.spec.c);
    });

    // links sit under the items, so a guide passing a chip reads as passing behind it
    var linkLayer = el('g', {}, svg);
    var usedSolid = false, usedTrigger = false;
    function drawLink(a, b, style) {
      var acx = a.x + a.w / 2, bcx = b.x + b.w / 2, d;
      if (a.li === b.li && a.r === b.r) {
        var fwd = b.x > a.x;
        d = 'M' + (fwd ? a.x + a.w : a.x) + ',' + (a.y + CH / 2) + ' H' + (fwd ? b.x - 1 : b.x + b.w + 1);
      } else {
        var down = b.y > a.y;
        var sy = down ? a.y + CH : a.y;
        var ty = down ? b.y - 1 : b.y + CH + 1;
        var straight = null;
        if (bcx >= a.x + 8 && bcx <= a.x + a.w - 8) straight = bcx;
        else if (acx >= b.x + 8 && acx <= b.x + b.w - 8) straight = acx;
        if (straight !== null) {
          d = 'M' + straight + ',' + sy + ' V' + ty;
        } else {
          var ym = down ? b.y - 7 : b.y + CH + 7;
          d = 'M' + acx + ',' + sy + ' V' + ym + ' H' + bcx + ' V' + ty;
        }
      }
      var trig = style === 'trigger';
      if (trig) usedTrigger = true; else usedSolid = true;
      el('path', { class: trig ? 'ln guide' : 'ln', d: d, 'marker-end': 'url(#' + id + (trig ? '-c' : '-a') + ')' }, linkLayer);
    }
    items.forEach(function (it) {
      if (it.by && byId[it.by]) drawLink(byId[it.by], it._g, byId[it.by].it.k === 'timer' ? 'solid' : 'trigger');
    });
    (spec.links || []).forEach(function (l) {
      if (byId[l.a] && byId[l.b]) drawLink(byId[l.a], byId[l.b], l.style || 'solid');
    });

    function drawItem(parent, g, it) {
      var k = it.k || 'chip';
      if (k === 'track' || k === 'span') {
        var tone = it.tone ? ' ' + it.tone : '';
        el('rect', { class: k + tone, x: g.x, y: g.y + 1, width: g.w, height: CH - 2, rx: k === 'track' ? 11 : 3 }, parent);
        el('text', { class: k === 'track' ? 'tt' + tone : 'tx', x: g.x + g.w / 2, y: g.y + 16, 'text-anchor': 'middle' }, parent, it.t);
        return;
      }
      var pill = k === 'run' || k === 'runT' || k === 'fail';
      el('rect', { class: 'it ' + k, x: g.x, y: g.y, width: g.w, height: CH, rx: pill ? 12 : 3 }, parent);
      var tx = g.x + 10 + (ICON[k] || 0);
      if (k === 'timer' || k === 'void' || k === 'runT') {
        el('use', { href: '#' + id + '-clk', x: g.x + (pill ? 16 : 14), y: g.y + 12, class: 'ic ' + k }, parent);
      } else if (k === 'run') {
        el('path', { class: 'ic-start', d: 'M' + (g.x + 11) + ',' + (g.y + 7) + ' l8,5 l-8,5 z' }, parent);
      } else if (k === 'fail') {
        el('path', { class: 'ic-fail', d: 'M' + (g.x + 11) + ',' + (g.y + 8) + ' l8,8 m0,-8 l-8,8' }, parent);
      }
      el('text', { class: 'tx ' + k, x: tx, y: g.y + 16 }, parent, it.t);
      if (k === 'void') el('line', { class: 'strike', x1: tx - 1, y1: g.y + 12.5, x2: g.x + g.w - 9, y2: g.y + 12.5 }, parent);
    }
    var itemLayer = el('g', {}, svg);
    items.forEach(function (it) { drawItem(itemLayer, it._g, it); });

    function drawMark(parent, cx, cy, n, lvl) {
      var mg = el('g', { class: 'mk ' + (lvl || 'hi') }, parent);
      el('circle', { cx: cx, cy: cy, r: 9 }, mg);
      el('text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle' }, mg, String(n));
    }
    (spec.marks || []).forEach(function (m) {
      var g = byId[m.on];
      if (g) drawMark(svg, g.x + g.w - 2, g.y + 1, m.n, m.lvl);
    });

    var height = lanesBottom + 12;
    if (spec.legend !== false) {
      // legend: each sample is drawn as the thing it names, and only kinds the diagram uses
      var present = {};
      items.forEach(function (it) { present[it.k || 'chip'] = true; });
      var lx = X0, ly = lanesBottom + 16;
      var room = function (w) { if (lx + w > X1) { lx = X0; ly += 32; } };
      ORDER.forEach(function (k) {
        if (!present[k] || words[k] === '') return;
        var w = k === 'track' ? Math.ceil(textWidth(words[k], true)) + 30 : chipWidth(k, words[k]);
        room(w);
        drawItem(svg, { x: lx, y: ly, w: w }, { k: k, t: words[k] });
        lx += w + 12;
      });
      var lineSample = function (cls, marker, text) {
        var w = 44 + Math.ceil(textWidth(text)) + 12;
        room(w);
        el('path', { class: cls, d: 'M' + lx + ',' + (ly + 12) + ' H' + (lx + 36), 'marker-end': 'url(#' + id + marker + ')' }, svg);
        el('text', { class: 'lbl', x: lx + 44, y: ly + 16 }, svg, text);
        lx += w + 12;
      };
      if (usedSolid && words.solid !== '') lineSample('ln', '-a', words.solid);
      if (usedTrigger && words.trigger !== '') lineSample('ln guide', '-c', words.trigger);
      if ((spec.marks || []).length && words.mark !== '') {
        var w = 26 + Math.ceil(textWidth(words.mark));
        room(w);
        drawMark(svg, lx + 9, ly + 12, '#', 'hi');
        el('text', { class: 'lbl', x: lx + 24, y: ly + 16 }, svg, words.mark);
        lx += w + 12;
      }
      height = ly + CH + 16;
    }
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + height);
    svg.setAttribute('width', W);
    svg.setAttribute('height', height);
    return svg;
  }

  window.Swimlane = { render: render };
})();
