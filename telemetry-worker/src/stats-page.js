// The stats page (served by stats.js behind the password). No libraries, no external requests:
// the CSP only allows this origin. PAGE_JS is a raw string, so the browser code in it must not
// use backticks or dollar-brace (it would end or interpolate this template).
// Colors: the dataviz reference palette; the six stall-cause slots were run through the palette
// validator for both surfaces (light needs relief -> legend + table view, which the page has).

export const PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Watch2Gether stats</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --ring: rgba(11,11,11,0.10); --wash: rgba(11,11,11,0.04);
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100; --s5: #e87ba4; --s6: #008300;
  --on-s4: #0b0b0b;
}
@media (prefers-color-scheme: dark) {
  :root:where(:not([data-theme="light"])) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10); --wash: rgba(255,255,255,0.05);
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300;
    --on-s4: #ffffff;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --ring: rgba(255,255,255,0.10); --wash: rgba(255,255,255,0.05);
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500; --s5: #d55181; --s6: #008300;
  --on-s4: #ffffff;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 28px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px; margin-bottom: 20px; }
h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
.sub { margin: 4px 0 0; color: var(--ink-2); }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.controls { display: flex; align-items: center; gap: 12px; }
.seg { display: inline-flex; padding: 3px; border-radius: 10px; background: var(--wash); box-shadow: inset 0 0 0 1px var(--ring); }
.seg button { font: inherit; font-size: 13px; color: var(--ink-2); background: none; border: 0; padding: 5px 12px; border-radius: 7px; cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: 0 0 0 1px var(--ring); }
.seg button:focus-visible, [tabindex]:focus-visible, summary:focus-visible { outline: 2px solid var(--s1); outline-offset: 2px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 12px; }
.tile, .card { background: var(--surface); border-radius: 14px; box-shadow: 0 0 0 1px var(--ring); }
.tile { padding: 14px 16px; }
.tile .label { color: var(--ink-2); font-size: 13px; }
.tile .value { font-size: 28px; font-weight: 600; margin-top: 2px; }
.tile .note { color: var(--muted); font-size: 12px; margin-top: 2px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
@media (max-width: 820px) { .grid2 { grid-template-columns: 1fr; } }
.card { padding: 16px 18px 14px; margin-bottom: 12px; min-width: 0; }
.grid2 .card { margin-bottom: 0; }
.card h2 { margin: 0; font-size: 15px; font-weight: 600; }
.card .desc { margin: 2px 0 14px; color: var(--ink-2); font-size: 13px; }
.empty { padding: 18px 0 8px; color: var(--ink-2); }

/* horizontal bars */
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 12px; color: var(--ink-2); font-size: 12px; }
.key { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.hbars { display: grid; grid-template-columns: minmax(110px, max-content) 1fr; gap: 8px 12px; align-items: center; }
.hbars .name { font-size: 13px; white-space: nowrap; }
.hbars .name .muted { font-size: 12px; }
.track { position: relative; height: 24px; display: flex; align-items: center; border-left: 1px solid var(--axis); }
.bar { height: 16px; border-radius: 0 4px 4px 0; min-width: 2px; }
.tip-label { margin-left: 8px; font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.hit { cursor: default; border-radius: 4px; }
.hit:hover { background: var(--wash); }

/* tall segmented bar */
.segbar { display: flex; gap: 2px; height: 28px; margin: 6px 0 12px; }
.segbar .part { border-radius: 4px; display: flex; align-items: center; padding-left: 8px; color: #fff; font-size: 12px; font-weight: 600; min-width: 0; overflow: visible; white-space: nowrap; }
.segbar .part.dark-ink { color: var(--on-s4); }

/* columns */
.cols { position: relative; height: 160px; margin: 8px 0 0 36px; border-bottom: 1px solid var(--axis); }
.cols .gridline { position: absolute; left: 0; right: 0; border-top: 1px solid var(--grid); }
.cols .ytick { position: absolute; left: -36px; width: 30px; text-align: right; font-size: 11px; color: var(--muted); transform: translateY(-50%); font-variant-numeric: tabular-nums; }
.cols .slot { position: absolute; bottom: 0; top: 0; display: flex; align-items: flex-end; justify-content: center; }
.cols .col { width: 100%; max-width: 24px; background: var(--s1); border-radius: 4px 4px 0 0; }
.cols .slot:hover { background: var(--wash); }
.xaxis { position: relative; height: 18px; margin-left: 36px; font-size: 11px; color: var(--muted); }
.xaxis span { position: absolute; top: 4px; transform: translateX(-50%); white-space: nowrap; }
.xaxis span.first { transform: none; }
.xaxis span.last { transform: translateX(-100%); }

details.table-view { margin-top: 10px; }
details.table-view summary { cursor: pointer; color: var(--ink-2); font-size: 12px; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 600; color: var(--ink-2); font-size: 12px; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
td { padding: 6px 10px 6px 0; border-bottom: 1px solid var(--grid); white-space: nowrap; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr:last-child td { border-bottom: 0; }

#tooltip { position: fixed; z-index: 10; pointer-events: none; background: var(--surface); color: var(--ink); border-radius: 10px; padding: 8px 10px; font-size: 12px; line-height: 1.5; box-shadow: 0 0 0 1px var(--ring), 0 8px 24px rgba(0,0,0,0.18); max-width: 280px; display: none; }
#tooltip b { font-weight: 600; }
#error { display: none; padding: 12px 14px; border-radius: 10px; margin-bottom: 12px; background: var(--surface); box-shadow: 0 0 0 1px var(--ring); }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>Watch2Gether stats</h1>
      <p class="sub">Anonymous playback reports from people who said yes. One report per video watched for 30 s or more.</p>
    </div>
    <div class="controls">
      <span id="updated" class="muted small"></span>
      <div class="seg" role="group" aria-label="Time range">
        <button data-days="7">7 days</button><button data-days="30">30 days</button><button data-days="90">90 days</button><button data-days="365">1 year</button>
      </div>
    </div>
  </header>
  <div id="error" role="alert"></div>
  <section class="tiles" id="tiles"></section>
  <div class="grid2">
    <section class="card">
      <h2>Stalling by format</h2>
      <p class="desc">Seconds stalled per minute watched. "CPU" means the graphics card didn't decode the video.</p>
      <div id="formats"></div>
    </section>
    <section class="card">
      <h2>Why playback stalled</h2>
      <p class="desc">Every stall, by its cause. "PC too slow" is a decoder that couldn't keep up, not the network.</p>
      <div id="causes"></div>
    </section>
  </div>
  <section class="card">
    <h2>Reports per day</h2>
    <p class="desc">Videos reported each day (UTC).</p>
    <div id="perday"></div>
  </section>
  <section class="card">
    <h2>GPUs that fell back to CPU decoding</h2>
    <p class="desc">The video played without the graphics card. Usually an older GPU with no decoder for that format (AV1 needs RTX 30, RX 6000, Intel 11th gen or newer).</p>
    <div id="cpugpus"></div>
  </section>
  <section class="card">
    <h2>Latest reports</h2>
    <p class="desc">The 50 newest in this range.</p>
    <div id="latest"></div>
  </section>
</main>
<div id="tooltip" role="tooltip"></div>
<script src="/stats/app.js" defer></script>
</body>
</html>`;

export const PAGE_JS = String.raw`'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat();
  var compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  var CAUSES = [
    ['network', 'Network', 's1', false],
    ['decode', 'PC too slow', 's2', false],
    ['seek', 'Seeking', 's3', false],
    ['load', 'Loading', 's4', true],
    ['align', 'Lining up', 's5', false],
    ['other', 'Other', 's6', false]
  ];
  var days = 30;
  try { var saved = Number(localStorage.getItem('w2g-stats-days')); if ([7, 30, 90, 365].indexOf(saved) >= 0) days = saved; } catch (e) { /* storage blocked */ }

  function el(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k === 'style') e.style.cssText = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    for (var i = 2; i < arguments.length; i++) if (arguments[i] != null) e.append(arguments[i]);
    return e;
  }
  function perMin(stall, watch) { return watch > 0 ? stall * 60 / watch : 0; }
  function fmt1(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function codecName(c) { return c === 'unknown' ? 'Unknown' : String(c).toUpperCase(); }
  function res(h) { return h ? h + 'p' : ''; }

  // ---- tooltip (hover and keyboard focus) ----
  var tip = $('tooltip');
  function showTip(target, x, y) {
    var lines = (target.getAttribute('data-tip') || '').split('\n');
    tip.replaceChildren();
    lines.forEach(function (l, i) {
      if (i) tip.append(el('br'));
      tip.append(i === 0 ? el('b', { text: l }) : document.createTextNode(l));
    });
    tip.style.display = 'block';
    var r = tip.getBoundingClientRect();
    var left = Math.min(window.innerWidth - r.width - 8, x + 14);
    var top = y + 14 + r.height > window.innerHeight ? y - r.height - 10 : y + 14;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }
  document.addEventListener('mousemove', function (e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (t) showTip(t, e.clientX, e.clientY); else tip.style.display = 'none';
  });
  document.addEventListener('focusin', function (e) {
    var t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) return;
    var r = t.getBoundingClientRect();
    showTip(t, r.left + r.width / 2, r.bottom);
  });
  document.addEventListener('focusout', function () { tip.style.display = 'none'; });

  function table(head, rows, numericCols) {
    var thead = el('tr');
    head.forEach(function (h, i) { thead.append(el('th', { text: h, class: numericCols.indexOf(i) >= 0 ? 'num' : '' })); });
    var tbody = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      r.forEach(function (c, i) { tr.append(el('td', { text: c == null ? '' : String(c), class: numericCols.indexOf(i) >= 0 ? 'num' : '' })); });
      tbody.append(tr);
    });
    return el('div', { class: 'scroll' }, el('table', null, el('thead', null, thead), tbody));
  }
  function tableView(t) { return el('details', { class: 'table-view' }, el('summary', { text: 'Show as table' }), t); }
  function empty(msg) { return el('div', { class: 'empty', text: msg }); }

  // ---- tiles ----
  function tiles(t) {
    var stallPct = t.watch_sec > 0 ? t.stall_sec * 100 / t.watch_sec : 0;
    var items = [
      ['Videos reported', compact.format(t.videos), ''],
      ['PCs', compact.format(t.installs), 'that sent at least one report'],
      ['Hours watched', compact.format(Math.round(t.watch_sec / 3600)), ''],
      ['Time stalled', (t.watch_sec > 0 ? fmt1(stallPct) : '0') + '%', 'of watch time']
    ];
    $('tiles').replaceChildren.apply($('tiles'), items.map(function (it) {
      return el('div', { class: 'tile' }, el('div', { class: 'label', text: it[0] }), el('div', { class: 'value', text: it[1] }), it[2] ? el('div', { class: 'note', text: it[2] }) : null);
    }));
  }

  // ---- stalling by format: one bar per codec x decoding, colored by decoding (2 series) ----
  function formats(rows) {
    var box = $('formats');
    if (!rows.length) return box.replaceChildren(empty('No reports in this range yet.'));
    var data = rows.map(function (r) { return { r: r, v: perMin(r.stall_sec, r.watch_sec) }; });
    data.sort(function (a, b) { return b.v - a.v; });
    var max = Math.max.apply(null, data.map(function (d) { return d.v; })) || 1;
    var legend = el('div', { class: 'legend' },
      el('span', { class: 'key' }, el('span', { class: 'sw', style: 'background:var(--s1)' }), 'Graphics card decoding'),
      el('span', { class: 'key' }, el('span', { class: 'sw', style: 'background:var(--s2)' }), 'CPU decoding'));
    var grid = el('div', { class: 'hbars' });
    data.forEach(function (d) {
      var r = d.r;
      var how = r.cpu ? 'CPU' : 'GPU';
      grid.append(el('div', { class: 'name' }, codecName(r.codec) + ' · ' + how + ' ', el('span', { class: 'muted', text: nf.format(r.videos) + (r.videos === 1 ? ' video' : ' videos') })));
      var pct = Math.max(0.5, d.v * 100 / max);
      grid.append(el('div', {
        class: 'track hit', tabindex: '0',
        'aria-label': codecName(r.codec) + ' ' + how + ': ' + fmt1(d.v) + ' seconds stalled per minute',
        'data-tip': codecName(r.codec) + ', ' + (r.cpu ? 'CPU decoding' : 'graphics card decoding') + '\n' + fmt1(d.v) + ' s stalled per minute watched\n' + nf.format(r.videos) + ' videos, ' + nf.format(Math.round(r.watch_sec / 60)) + ' min watched\n' + nf.format(r.decode_stalls) + ' stalls from a slow PC, ' + nf.format(r.network_stalls) + ' from the network'
      }, el('div', { class: 'bar', style: 'width:calc(' + pct + '% - 70px);background:var(' + (r.cpu ? '--s2' : '--s1') + ')' }), el('span', { class: 'tip-label', text: fmt1(d.v) + ' s/min' })));
    });
    var t = table(['Format', 'Decoding', 'Videos', 'Minutes watched', 'Stalled s/min', 'Slow-PC stalls', 'Network stalls'],
      data.map(function (d) { var r = d.r; return [codecName(r.codec), r.cpu ? 'CPU' : 'GPU', nf.format(r.videos), nf.format(Math.round(r.watch_sec / 60)), fmt1(d.v), nf.format(r.decode_stalls), nf.format(r.network_stalls)]; }), [2, 3, 4, 5, 6]);
    box.replaceChildren(legend, grid, tableView(t));
  }

  // ---- why stalls happened: one whole split into parts (tall segmented bar) ----
  function causes(c) {
    var box = $('causes');
    var total = CAUSES.reduce(function (s, k) { return s + (c[k[0]] || 0); }, 0);
    if (!total) return box.replaceChildren(empty('No stalls in this range.'));
    var bar = el('div', { class: 'segbar', role: 'img', 'aria-label': 'Stalls by cause: ' + CAUSES.map(function (k) { return k[1] + ' ' + nf.format(c[k[0]] || 0); }).join(', ') });
    CAUSES.forEach(function (k) {
      var n = c[k[0]] || 0;
      if (!n) return;
      var share = n * 100 / total;
      var part = el('div', {
        class: 'part' + (k[3] ? ' dark-ink' : ''), tabindex: '0',
        style: 'flex:' + n + ' 1 0;background:var(--' + k[2] + ')',
        'data-tip': k[1] + '\n' + nf.format(n) + ' stalls (' + Math.round(share) + '%)'
      });
      bar.append(part);
      // a share label only where it fits; otherwise the tooltip and table carry it
      requestAnimationFrame(function () {
        var label = Math.round(share) + '%';
        if (part.getBoundingClientRect().width >= label.length * 7 + 16) part.textContent = label;
      });
    });
    var legend = el('div', { class: 'legend' });
    CAUSES.forEach(function (k) { if (c[k[0]]) legend.append(el('span', { class: 'key' }, el('span', { class: 'sw', style: 'background:var(--' + k[2] + ')' }), k[1])); });
    var t = table(['Cause', 'Stalls', 'Share'], CAUSES.map(function (k) { var n = c[k[0]] || 0; return [k[1], nf.format(n), Math.round(n * 100 / total) + '%']; }), [1, 2]);
    box.replaceChildren(bar, legend, tableView(t));
  }

  // ---- reports per day: columns, every day of the range (zeros included) ----
  function niceMax(v) {
    if (v <= 4) return 4;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v) return steps[i] * p;
    return 10 * p;
  }
  function perDay(rows, generatedAt) {
    var box = $('perday');
    var byDay = {};
    rows.forEach(function (r) { byDay[r.day] = r.videos; });
    var list = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(generatedAt - i * 86400000).toISOString().slice(0, 10);
      list.push({ day: d, n: byDay[d] || 0 });
    }
    var total = list.reduce(function (s, x) { return s + x.n; }, 0);
    if (!total) return box.replaceChildren(empty('No reports in this range yet.'));
    var top = niceMax(Math.max.apply(null, list.map(function (x) { return x.n; })));
    var cols = el('div', { class: 'cols', role: 'img', 'aria-label': 'Reports per day, ' + nf.format(total) + ' in total' });
    [0, 0.5, 1].forEach(function (f) {
      var y = (1 - f) * 100;
      if (f > 0) cols.append(el('div', { class: 'gridline', style: 'top:' + y + '%' }));
      cols.append(el('div', { class: 'ytick', style: 'top:' + y + '%', text: compact.format(top * f) }));
    });
    var w = 100 / list.length;
    list.forEach(function (x, i) {
      var slot = el('div', { class: 'slot', tabindex: x.n ? '0' : '-1', style: 'left:' + (i * w) + '%;width:' + w + '%;padding:0 ' + (list.length > 120 ? 0 : 1) + 'px', 'data-tip': x.day + '\n' + nf.format(x.n) + (x.n === 1 ? ' report' : ' reports') });
      if (x.n) slot.append(el('div', { class: 'col', style: 'height:' + (x.n * 100 / top) + '%' }));
      cols.append(slot);
    });
    var axis = el('div', { class: 'xaxis' },
      el('span', { class: 'first', style: 'left:0', text: list[0].day }),
      el('span', { style: 'left:50%', text: list[Math.floor(list.length / 2)].day }),
      el('span', { class: 'last', style: 'left:100%', text: list[list.length - 1].day }));
    var t = table(['Day (UTC)', 'Reports'], list.filter(function (x) { return x.n; }).reverse().map(function (x) { return [x.day, nf.format(x.n)]; }), [1]);
    box.replaceChildren(cols, axis, tableView(t));
  }

  function cpuGpus(rows) {
    if (!rows.length) return $('cpugpus').replaceChildren(empty('None in this range.'));
    $('cpugpus').replaceChildren(table(['GPU', 'Format', 'Resolution', 'Videos', 'Stalled s/min'],
      rows.map(function (r) { return [r.gpu, codecName(r.codec), res(r.height), nf.format(r.videos), fmt1(perMin(r.stall_sec, r.watch_sec))]; }), [3, 4]));
  }

  function latest(rows) {
    if (!rows.length) return $('latest').replaceChildren(empty('No reports in this range yet.'));
    $('latest').replaceChildren(table(['Received', 'App', 'Role', 'Source', 'Format', 'HDR', 'Decoding', 'GPU', 'Watched', 'Stalled', 'Slow-PC stalls', 'Network stalls', 'Catch-up jumps'],
      rows.map(function (r) {
        return [new Date(r.received_at).toLocaleString(), r.app_version, r.role, r.source,
          [codecName(r.codec || 'unknown'), res(r.height)].filter(Boolean).join(' '), r.hdr, r.hwdec === 'no' ? 'CPU' : (r.hwdec || ''), r.gpu,
          Math.round((r.watch_sec || 0) / 60) + ' min', (r.stall_sec || 0) + ' s', r.stalls_decode, r.stalls_network, r.drift_seeks];
      }), [8, 9, 10, 11, 12]));
  }

  // ---- load ----
  var seq = 0;
  function load() {
    var mine = ++seq;
    document.querySelectorAll('.seg button').forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.getAttribute('data-days')) === days)); });
    fetch('/stats/api?days=' + days, { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('The server answered ' + r.status + '.'); return r.json(); })
      .then(function (d) {
        if (mine !== seq) return;
        $('error').style.display = 'none';
        tiles(d.totals);
        formats(d.byFormat);
        causes(d.causes);
        perDay(d.perDay, d.generatedAt);
        cpuGpus(d.cpuGpus);
        latest(d.latest);
        $('updated').textContent = 'Updated ' + new Date(d.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      })
      .catch(function (e) {
        $('error').textContent = "Couldn't load the numbers: " + e.message + ' Reload the page to try again.';
        $('error').style.display = 'block';
      });
  }
  document.querySelectorAll('.seg button').forEach(function (b) {
    b.addEventListener('click', function () {
      days = Number(b.getAttribute('data-days'));
      try { localStorage.setItem('w2g-stats-days', String(days)); } catch (e) { /* storage blocked */ }
      load();
    });
  });
  load();
})();
`;
