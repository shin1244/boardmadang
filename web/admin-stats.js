// 운영자 화면 위쪽의 통계: GET /api/admin/stats?days=N 의 숫자, 그래프, 많이 둔 게임, 표.
// 날짜는 한국 날짜이고 마지막 날이 오늘입니다 (서버 internal/admin/stats.go). 그래프는 라이브러리 없이 SVG로 그립니다.
// 그래프 위에 마우스를 올리거나, 그래프에 초점을 두고 ←/→를 누르면 그날의 수가 보입니다. 같은 수는 "표로 보기"에도 있습니다.

import { lang, t } from './i18n.js';

const SVG = 'http://www.w3.org/2000/svg';
export const RANGES = [7, 30, 90];

/** 그래프의 계열 색 (admin.css의 --chart-1, --chart-2). 계열은 늘 이 순서로 씁니다 */
const COLORS = ['var(--chart-1)', 'var(--chart-2)'];

let stats = null; // GET /api/admin/stats의 응답
let days = 30;
let loading = false;
let failed = '';
let rerender = () => {};
let charts = []; // 지금 그린 그래프. 폭이 바뀌면 다시 그립니다 ({ plot, draw })

// ---- 불러오기 ----

/** 고른 기간의 통계를 불러옵니다. 실패하면 이유를 남기고 화면은 앞의 것을 그대로 둡니다 */
export async function loadStats() {
  loading = true;
  try {
    const res = await fetch(`/api/admin/stats?days=${days}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    stats = await res.json();
    failed = '';
  } catch (e) {
    failed = t('stats.failed', { msg: e.message });
  }
  loading = false;
}

/** 기간 버튼과 폭 바뀜을 겁니다. onRender는 다시 그릴 때 부릅니다 (admin.js의 render) */
export function setupStats(onRender) {
  rerender = onRender;
  for (const b of document.querySelectorAll('#stat-range button')) {
    b.addEventListener('click', async () => {
      const n = Number(b.dataset.days);
      if (loading || n === days) return;
      days = n;
      loading = true;
      rerender();
      await loadStats();
      rerender();
    });
  }
  let frame = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => charts.forEach((c) => c.draw()));
  }).observe(document.querySelector('#stat-charts'));
}

// ---- 도움 ----

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const num = (n) => n.toLocaleString(lang);
const sum = (key) => stats.days.reduce((s, d) => s + d[key], 0);

/** "2026-11-04" → "11. 4." 처럼 짧은 날짜 */
function shortDay(day) {
  return new Date(`${day}T12:00:00+09:00`).toLocaleDateString(lang, { month: 'numeric', day: 'numeric', timeZone: 'Asia/Seoul' });
}

function longDay(day) {
  return new Date(`${day}T12:00:00+09:00`).toLocaleDateString(lang, { dateStyle: 'medium', timeZone: 'Asia/Seoul' });
}

/** 0부터 max를 덮는 깔끔한 눈금 (1, 2, 5 × 10^k 간격, 4칸 안팎) */
function ticks(max) {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw));
  const out = [];
  for (let v = 0; v <= max + step - 1e-9 && out.length < 8; v += step) out.push(v);
  if (out.at(-1) < max) out.push(out.at(-1) + step);
  return out;
}

/** 축 글자: 1만부터는 줄여 씁니다 */
const tickText = (v) => (v >= 10000 ? new Intl.NumberFormat(lang, { notation: 'compact' }).format(v) : num(v));

// ---- 숫자 칸 ----

function tile(label, value, sub) {
  const box = el('div', 'stat-tile');
  box.append(el('span', 'stat-label', label), el('b', 'stat-value', num(value)), el('span', 'stat-sub', sub));
  return box;
}

function renderTiles() {
  const today = stats.days.at(-1);
  return [
    tile(t('stats.dau'), today.visitors, t('stats.dau.sub', { m: num(today.members), g: num(today.visitors - today.members) })),
    tile(t('stats.mau'), today.mau, t('stats.mau.sub', { m: num(today.mauMembers) })),
    tile(t('stats.plays'), today.plays, t('stats.plays.sub', { n: days, sum: num(sum('plays')) })),
    tile(t('stats.newGames'), today.newGames, t('stats.newGames.sub', { n: days, sum: num(sum('newGames')), upd: num(sum('updates')) })),
    tile(t('stats.signups'), today.signups, t('stats.signups.sub', { n: days, sum: num(sum('signups')), total: num(stats.accounts) })),
    tile(t('stats.online'), stats.online, t('stats.online.sub', { n: num(stats.playing) })),
  ];
}

// ---- 그래프 ----

/**
 * 그래프 하나. 폭은 그릴 때 잽니다.
 * @param {object} o
 * @param {string} o.title
 * @param {'line'|'bar'} o.kind 선(겹쳐 그림) 또는 막대(쌓아 그림)
 * @param {{key: string, label: string}[]} o.series 최대 2개
 * @param {(d: object, key: string) => number|null} [o.value] 그날의 값. null이면 그날은 모릅니다 (선이 끊깁니다)
 * @param {string} [o.note] 그래프 아래 작은 글
 * @param {string} [o.empty] 값이 하나도 없을 때 그래프 대신 보일 글
 * @param {boolean} [o.wide] 두 칸을 차지합니다
 */
function chart(o) {
  const value = o.value ?? ((d, key) => d[key]);
  const fig = el('figure', `stat-chart${o.wide ? ' wide' : ''}`);
  const cap = el('figcaption');
  cap.append(el('b', '', o.title));
  if (o.series.length > 1) {
    const legend = el('span', 'stat-legend');
    o.series.forEach((s, i) => {
      const item = el('span', 'stat-key');
      const mark = el('i', o.kind === 'line' ? 'line' : 'box');
      mark.style.background = COLORS[i];
      item.append(mark, s.label);
      legend.append(item);
    });
    cap.append(legend);
  }
  const plot = el('div', 'stat-plot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'group');
  plot.setAttribute('aria-label', `${o.title}. ${t('stats.keys')}`);
  const tip = el('div', 'stat-tip');
  tip.hidden = true;
  tip.setAttribute('aria-live', 'polite');
  fig.append(cap, plot);
  if (o.note) fig.append(el('p', 'stat-note', o.note));

  const data = stats.days;
  const known = data.some((d) => o.series.some((s) => value(d, s.key) !== null));
  if (!known && o.empty) {
    plot.replaceChildren(el('p', 'stat-empty', o.empty));
    plot.removeAttribute('tabindex');
    return { fig, plot, draw() {} };
  }

  let at = -1; // 짚은 날 (-1이면 없음)
  let geo = null; // 마지막으로 그린 크기

  function draw() {
    const W = Math.max(240, Math.round(plot.clientWidth));
    const H = 160;
    const m = { t: 10, r: 10, b: 24, l: 36 };
    const w = W - m.l - m.r;
    const h = H - m.t - m.b;
    const n = data.length;
    const band = w / n;
    const total = (d) => (o.kind === 'bar'
      ? o.series.reduce((s, x) => s + (value(d, x.key) ?? 0), 0)
      : Math.max(0, ...o.series.map((x) => value(d, x.key) ?? 0)));
    const ys = ticks(Math.max(0, ...data.map(total)));
    const top = ys.at(-1);
    const y = (v) => m.t + h - (v / top) * h;
    const cx = (i) => m.l + band * (i + 0.5);
    geo = { W, H, m, w, h, band, y, cx };

    const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    // 짚은 날의 띠 (막대) 또는 세로선 (선). 마크보다 뒤에 둡니다
    const hover = svg('g', { class: 'stat-hover' });
    root.append(hover);
    // 가로 눈금선과 값
    for (const v of ys) {
      root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'stat-base' : 'stat-grid' }));
      const label = svg('text', { x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'stat-axis' });
      label.textContent = tickText(v);
      root.append(label);
    }
    // 날짜: 7일 이하면 날마다, 아니면 다섯 군데
    const marks = n <= 7 ? data.map((_, i) => i) : [...new Set([0, 1, 2, 3, 4].map((k) => Math.round((k * (n - 1)) / 4)))];
    for (const i of marks) {
      const anchor = n <= 7 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      const x = n <= 7 ? cx(i) : i === 0 ? m.l : i === n - 1 ? W - m.r : cx(i);
      const label = svg('text', { x, y: H - 6, 'text-anchor': anchor, class: 'stat-axis' });
      label.textContent = shortDay(data[i].day);
      root.append(label);
    }

    if (o.kind === 'bar') {
      // 막대 사이 2px. 날이 많아 띠가 좁으면 1px
      const cw = band >= 6 ? Math.min(24, band - 2) : Math.max(1, band - 1);
      data.forEach((d, i) => {
        let base = 0;
        const parts = o.series.map((s, k) => ({ v: value(d, s.key) ?? 0, k })).filter((p) => p.v > 0);
        parts.forEach((p, j) => {
          const y0 = y(base);
          base += p.v;
          let y1 = y(base);
          const last = j === parts.length - 1;
          if (!last) y1 = Math.min(y0, y1 + 2); // 위 조각과 2px 띄웁니다
          if (y0 - y1 < 0.5) return;
          root.append(svg('path', { d: barPath(cx(i) - cw / 2, y1, cw, y0 - y1, last ? Math.min(4, cw / 2) : 0), fill: COLORS[p.k] }));
        });
      });
    } else {
      o.series.forEach((s, k) => {
        const pts = data.map((d, i) => {
          const v = value(d, s.key);
          return v === null ? null : [cx(i), y(v)];
        });
        // 모르는 날에서 끊습니다
        const runs = [];
        let run = [];
        for (const p of pts) {
          if (p) run.push(p);
          else if (run.length) { runs.push(run); run = []; }
        }
        if (run.length) runs.push(run);
        for (const r of runs) {
          const line = r.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
          if (k === 0 && r.length > 1) {
            root.append(svg('path', { d: `${line}L${r.at(-1)[0].toFixed(1)},${y(0)}L${r[0][0].toFixed(1)},${y(0)}Z`, fill: COLORS[k], 'fill-opacity': 0.1 }));
          }
          root.append(svg('path', { d: line, fill: 'none', stroke: COLORS[k], 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        }
        const end = pts.findLast(Boolean);
        if (end) root.append(svg('circle', { cx: end[0], cy: end[1], r: 4, fill: COLORS[k], class: 'stat-dot' }));
      });
    }
    plot.replaceChildren(root, tip);
    paintHover(hover);
  }

  /** 짚은 날을 그리고 그날의 수를 띄웁니다 */
  function paintHover(hover = plot.querySelector('.stat-hover')) {
    if (!hover || !geo) return;
    hover.replaceChildren();
    if (at < 0) {
      tip.hidden = true;
      return;
    }
    const { H, m, band, y, cx } = geo;
    const d = data[at];
    if (o.kind === 'bar') {
      hover.append(svg('rect', { x: cx(at) - band / 2, y: m.t, width: band, height: H - m.t - m.b, class: 'stat-band' }));
    } else {
      hover.append(svg('line', { x1: cx(at), x2: cx(at), y1: m.t, y2: H - m.b, class: 'stat-cross' }));
      o.series.forEach((s, k) => {
        const v = value(d, s.key);
        if (v !== null) hover.append(svg('circle', { cx: cx(at), cy: y(v), r: 4, fill: COLORS[k], class: 'stat-dot' }));
      });
    }
    tip.replaceChildren(el('span', 'stat-tip-day', longDay(d.day)));
    o.series.forEach((s, k) => {
      const row = el('span', 'stat-tip-row');
      const key = el('i');
      key.style.background = COLORS[k];
      const v = value(d, s.key);
      row.append(key, el('b', '', v === null ? '–' : num(v)), ' ', el('span', '', s.label));
      tip.append(row);
    });
    tip.hidden = false;
    // 짚은 날 옆에 둡니다. 오른쪽이 모자라면 왼쪽에
    const x = cx(at);
    const right = x + 12 + tip.offsetWidth <= plot.clientWidth;
    tip.style.left = `${right ? x + 12 : Math.max(0, x - 12 - tip.offsetWidth)}px`;
  }

  const pick = (i) => {
    at = i;
    paintHover();
  };
  plot.addEventListener('pointermove', (e) => {
    if (!geo) return;
    const x = e.clientX - plot.getBoundingClientRect().left;
    pick(Math.min(data.length - 1, Math.max(0, Math.floor((x - geo.m.l) / geo.band))));
  });
  plot.addEventListener('pointerleave', () => pick(-1));
  plot.addEventListener('focus', () => pick(data.length - 1));
  plot.addEventListener('blur', () => pick(-1));
  plot.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (step) {
      e.preventDefault();
      pick(Math.min(data.length - 1, Math.max(0, (at < 0 ? data.length - 1 : at) + step)));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      pick(e.key === 'Home' ? 0 : data.length - 1);
    } else if (e.key === 'Escape') {
      pick(-1);
    }
  });
  return { fig, plot, draw };
}

/** 위 모서리만 둥근 막대 (바닥은 각지게) */
function barPath(x, y, w, h, r) {
  r = Math.min(r, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function renderCharts() {
  const since = stats.visitsSince;
  // 방문을 세기 전 날은 모르는 날입니다
  const visit = (d, key) => (since && d.day >= since ? d[key] : null);
  const sinceNote = since && since > stats.days[0].day ? t('stats.since', { date: longDay(since) }) : '';
  const list = [
    chart({
      title: t('stats.chart.visitors'), kind: 'line', wide: true, value: visit, note: sinceNote, empty: t('stats.noVisits'),
      series: [{ key: 'visitors', label: t('stats.s.all') }, { key: 'members', label: t('stats.s.members') }],
    }),
    chart({
      title: t('stats.chart.mau'), kind: 'line', value: visit, empty: t('stats.noVisits'),
      series: [{ key: 'mau', label: t('stats.s.all') }, { key: 'mauMembers', label: t('stats.s.members') }],
    }),
    chart({ title: t('stats.chart.plays'), kind: 'bar', series: [{ key: 'plays', label: t('stats.s.plays') }] }),
    chart({
      title: t('stats.chart.uploads'), kind: 'bar',
      series: [{ key: 'newGames', label: t('stats.s.new') }, { key: 'updates', label: t('stats.s.updates') }],
    }),
    chart({ title: t('stats.chart.signups'), kind: 'bar', series: [{ key: 'signups', label: t('stats.s.signups') }] }),
  ];
  return list;
}

// ---- 많이 둔 게임과 표 ----

function renderTop(gameName) {
  const list = el('ol', 'stat-top');
  const max = stats.top[0]?.plays ?? 0;
  for (const g of stats.top) {
    const li = el('li');
    const bar = el('span', 'stat-bar');
    const fill = el('i');
    fill.style.width = `${(g.plays / max) * 100}%`;
    bar.append(fill);
    li.append(el('span', 'stat-game', gameName(g.game)), bar, el('b', 'stat-count', t('stats.top.plays', { n: num(g.plays) })));
    list.append(li);
  }
  return list;
}

const COLUMNS = [
  ['visitors', 'stats.s.visitors'], ['members', 'stats.s.members'], ['mau', 'stats.s.mau'], ['plays', 'stats.s.plays'],
  ['newGames', 'stats.s.new'], ['updates', 'stats.s.updates'], ['signups', 'stats.s.signups'],
];

function renderTable() {
  const table = el('table', 'stat-table');
  const head = el('tr');
  head.append(el('th', '', t('stats.col.day')), ...COLUMNS.map(([, key]) => el('th', '', t(key))));
  table.append(el('thead'), el('tbody'));
  table.tHead.append(head);
  const since = stats.visitsSince;
  for (const d of [...stats.days].reverse()) {
    const tr = el('tr');
    tr.append(el('th', '', longDay(d.day)));
    for (const [key] of COLUMNS) {
      const unknown = ['visitors', 'members', 'mau'].includes(key) && !(since && d.day >= since);
      tr.append(el('td', '', unknown ? '–' : num(d[key])));
    }
    table.tBodies[0].append(tr);
  }
  return table;
}

// ---- 그리기 ----

/** 통계 칸을 다시 그립니다. gameName은 게임 id → 보일 이름 */
export function renderStats(gameName) {
  const section = document.querySelector('#stats');
  for (const b of section.querySelectorAll('#stat-range button')) {
    b.textContent = t('stats.days', { n: b.dataset.days });
    b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days));
    b.disabled = loading;
  }
  section.classList.toggle('loading', loading);
  const error = section.querySelector('#stat-error');
  error.textContent = failed;
  error.hidden = !failed;
  const body = section.querySelector('#stat-body');
  body.hidden = !stats;
  if (!stats) return;

  section.querySelector('#stat-tiles').replaceChildren(...renderTiles());
  charts = renderCharts();
  section.querySelector('#stat-charts').replaceChildren(...charts.map((c) => c.fig));
  charts.forEach((c) => c.draw());

  section.querySelector('#stat-top-title').textContent = t('stats.top', { n: days });
  const top = section.querySelector('#stat-top');
  top.replaceChildren(stats.top.length ? renderTop(gameName) : el('p', 'empty', t('stats.top.empty')));
  section.querySelector('#stat-table-label').textContent = t('stats.table');
  section.querySelector('#stat-table').replaceChildren(renderTable());
}
