// 운영자 화면 위쪽의 통계: GET /api/admin/stats?days=N 의 숫자, 그래프, 많이 둔 게임, 나라별 방문, 다시 오는 사람(리텐션), 표.
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

/** 통계를 다시 불러오는 간격. 그 사이에 온 방문, 나라, 지금 접속이 보입니다 (admin.js) */
export const REFRESH_MS = 60_000;

/**
 * 통계 칸만 다시 불러와 그립니다. 신고 처리 칸은 건드리지 않아 쓰던 메모와 초점이 그대로입니다.
 * 탭이 안 보이거나, 불러오는 중이거나, 통계 칸에 초점이 있거나 그래프 위에 마우스가 있으면 이번은 건너뜁니다.
 */
export async function refreshStats(gameName) {
  const section = document.querySelector('#stats');
  if (loading || document.hidden || section.closest('[hidden]') || section.contains(document.activeElement)) return;
  if (section.querySelector('#stat-charts:hover')) return;
  await loadStats();
  renderStats(gameName);
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

/** 숫자 칸 하나. value가 글자면 그대로 씁니다 (비율 등) */
function tile(label, value, sub) {
  const box = el('div', 'stat-tile');
  box.append(el('span', 'stat-label', label), el('b', 'stat-value', typeof value === 'string' ? value : num(value)), el('span', 'stat-sub', sub));
  return box;
}

function renderTiles() {
  const today = stats.days.at(-1);
  return [
    tile(t('stats.dau'), today.visitors, t('stats.dau.sub', { m: num(today.members), g: num(today.visitors - today.members) })),
    tile(t('stats.mau'), today.mau, t('stats.mau.sub', { m: num(today.mauMembers) })),
    // 대국은 온라인과 AI를 더한 수 (AI는 사람이 한 수 이상 둔 판)
    tile(t('stats.plays'), today.plays + today.aiPlays, t('stats.plays.sub', {
      on: num(today.plays), ai: num(today.aiPlays), n: days, sum: num(sum('plays') + sum('aiPlays')),
    })),
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
    chart({
      title: t('stats.chart.plays'), kind: 'bar',
      series: [{ key: 'plays', label: t('stats.s.online') }, { key: 'aiPlays', label: t('stats.s.ai') }],
    }),
    chart({
      title: t('stats.chart.uploads'), kind: 'bar',
      series: [{ key: 'newGames', label: t('stats.s.new') }, { key: 'updates', label: t('stats.s.updates') }],
    }),
    chart({ title: t('stats.chart.signups'), kind: 'bar', series: [{ key: 'signups', label: t('stats.s.signups') }] }),
  ];
  return list;
}

// ---- 많이 둔 게임과 표 ----

/** 많이 둔 게임. 서버가 온라인 + AI 판 수로 줄 세워 줍니다 */
function renderTop(gameName) {
  const list = el('ol', 'stat-top');
  const total = (g) => g.plays + g.aiPlays;
  const max = stats.top[0] ? total(stats.top[0]) : 0;
  for (const g of stats.top) {
    const li = el('li');
    const bar = el('span', 'stat-bar');
    const fill = el('i');
    fill.style.width = `${(total(g) / max) * 100}%`;
    bar.append(fill);
    const count = t('stats.top.plays', { n: num(total(g)), on: num(g.plays), ai: num(g.aiPlays) });
    li.append(el('span', 'stat-game', gameName(g.game)), bar, el('b', 'stat-count', count));
    list.append(li);
  }
  return list;
}

/** 나라별 방문에서 이름을 보이는 나라 수. 나머지는 한 줄로 묶습니다 */
const MAX_COUNTRIES = 10;

/** 나라 코드(KR) → 화면 언어의 나라 이름 (대한민국, South Korea) */
function countryName(code) {
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** 나라별 방문. 서버가 많은 나라부터 줍니다 (internal/admin/stats.go) */
function renderCountries() {
  const rows = stats.countries.slice(0, MAX_COUNTRIES).map((c) => [countryName(c.country), c.visitors]);
  const rest = stats.countries.slice(MAX_COUNTRIES);
  if (rest.length) rows.push([t('stats.countries.rest', { n: num(rest.length) }), rest.reduce((s, c) => s + c.visitors, 0)]);
  if (stats.countryUnknown) rows.push([t('stats.countries.unknown'), stats.countryUnknown, 'muted']);

  const out = [];
  if (rows.length) {
    const total = rows.reduce((s, [, n]) => s + n, 0);
    const max = Math.max(...rows.map(([, n]) => n));
    const list = el('ol', 'stat-top');
    for (const [name, n, className = ''] of rows) {
      const li = el('li', className);
      const bar = el('span', 'stat-bar');
      const fill = el('i');
      fill.style.width = `${(n / max) * 100}%`;
      bar.append(fill);
      const pct = ((n / total) * 100).toLocaleString(lang, { maximumFractionDigits: 1 });
      li.append(el('span', 'stat-game', name), bar, el('b', 'stat-count', t('stats.countries.count', { n: num(n), pct })));
      list.append(li);
    }
    out.push(list);
  } else {
    out.push(el('p', 'empty', t('stats.countries.empty')));
  }
  let note = t('stats.countries.note');
  if (stats.countriesSince && stats.countriesSince > stats.days[0].day) note += ` ${t('stats.countries.since', { date: longDay(stats.countriesSince) })}`;
  if (!stats.geo) note += ` ${t('stats.countries.noGeo')}`;
  out.push(el('p', 'stat-note', note));
  // DB-IP의 라이선스(CC BY 4.0): 나라를 보여 주는 화면에 DB-IP로 가는 링크를 둡니다
  const source = el('p', 'stat-note', `${t('stats.countries.source')} `);
  const link = el('a', '', 'IP Geolocation by DB-IP');
  link.href = 'https://db-ip.com';
  link.rel = 'noopener';
  link.target = '_blank';
  source.append(link);
  out.push(source);
  return out;
}

// ---- 표 ----

/** 표의 날짜 칸: 짧은 날짜와 요일. 올해가 아니면 연도도 씁니다 */
function dayCell(day) {
  const d = new Date(`${day}T12:00:00+09:00`);
  const sameYear = day.slice(0, 4) === stats.today.slice(0, 4);
  const date = d.toLocaleDateString(lang, { year: sameYear ? undefined : 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' });
  const th = el('th', 'stat-day', date);
  th.scope = 'row';
  th.append(' ', el('span', 'stat-weekday', d.toLocaleDateString(lang, { weekday: 'short', timeZone: 'Asia/Seoul' })));
  if (day === stats.today) th.append(' ', el('span', 'stat-today', t('stats.today')));
  return th;
}

/**
 * 숫자 칸. 0은 흐리게, 모르거나 아직 셀 수 없는 값(null)은 –로.
 * pct를 주면 숫자 옆에 비율을 작게 붙입니다. 0이나 –여도 그 자리를 비워 두어 숫자의 세로줄이 맞습니다
 */
function numCell(v, pct) {
  const td = v == null ? el('td', 'none', '–') : el('td', v === 0 ? 'zero' : '', num(v));
  if (pct !== undefined) td.append(el('span', 'stat-pct', v ? pct : ''));
  return td;
}

const percent = (n, of) => (of ? `${Math.round((n / of) * 100).toLocaleString(lang)}%` : '');

/**
 * 날짜를 줄로 둔 표. groups는 [묶음 이름 키, [[칸 이름 키, 줄 → 칸]]]이고, 묶음 이름이 있으면 머리글이 두 줄입니다.
 * rows는 위에서부터 보일 순서 (최근 날부터). narrow면 칸이 적은 표라 화면 폭에 맞춰 늘리지 않습니다
 */
function dayTable(groups, rows, { narrow = false } = {}) {
  const table = el('table', narrow ? 'stat-table narrow' : 'stat-table');
  const head = table.createTHead();
  const grouped = groups.some(([label]) => label);
  const top = head.insertRow();
  const corner = el('th', 'stat-corner', t('stats.col.day'));
  corner.scope = 'col';
  top.append(corner);
  const sub = grouped ? head.insertRow() : top;
  if (grouped) corner.rowSpan = 2;
  for (const [label, cols] of groups) {
    if (grouped) {
      const g = el('th', 'stat-group group-start', t(label));
      g.colSpan = cols.length;
      g.scope = 'colgroup';
      top.append(g);
    }
    cols.forEach(([key], i) => {
      const th = el('th', i === 0 && grouped ? 'group-start' : '', t(key));
      th.scope = 'col';
      sub.append(th);
    });
  }
  const body = table.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    if (row.day === stats.today) tr.className = 'today';
    tr.append(dayCell(row.day));
    for (const [, cols] of groups) {
      cols.forEach(([, cell], i) => {
        const td = cell(row);
        if (i === 0 && grouped) td.classList.add('group-start');
        tr.append(td);
      });
    }
  }
  return table;
}

/** 기보와 등록 기록에서 세는 칸. 방문 칸은 세기 시작한 날부터만 있습니다 */
const COUNTS = ['plays', 'aiPlays', 'aiEnds', 'aiWins', 'newGames', 'updates', 'signups'];

/** "표로 보기": 날마다의 수. 방문을 세기 전이고 아무 기록도 없는 날은 뺍니다 (위 그래프 아래에 세기 시작한 날이 있습니다) */
function renderTable() {
  const since = stats.visitsSince;
  const counted = (d) => since && d.day >= since;
  const visit = (key) => (d) => numCell(counted(d) ? d[key] : null);
  const count = (key) => (d) => numCell(d[key]);
  const rows = [...stats.days].reverse().filter((d) => counted(d) || COUNTS.some((k) => d[k] > 0));
  return dayTable([
    ['stats.g.visits', [['stats.s.all', visit('visitors')], ['stats.c.members', visit('members')], ['stats.s.mau', visit('mau')]]],
    ['stats.g.plays', [['stats.s.online', count('plays')], ['stats.s.ai', count('aiPlays')]]],
    ['stats.g.ai', [['stats.c.ends', count('aiEnds')], ['stats.c.wins', count('aiWins')]]],
    ['stats.g.growth', [['stats.c.new', count('newGames')], ['stats.c.updates', count('updates')], ['stats.s.signups', count('signups')]]],
  ], rows);
}

// ---- 리텐션 ----

/** 셀 수 있는 날의 묶음만 더한 비율 {n, of}. 다음 날이 아직 안 온 묶음은 다음 날 비율에 넣지 않습니다 */
function retentionSum(pick, usable) {
  const rows = stats.retention.filter(usable);
  return { n: rows.reduce((s, c) => s + pick(c), 0), of: rows.reduce((s, c) => s + c.new, 0) };
}

/** 오늘 처음 온 사람은 아직 다시 올 날이 없으므로 "다시 옴"을 셀 수 없습니다 */
const returned = (c) => (c.day === stats.today ? null : c.returned);

/** 다시 오는 사람: 요약 숫자 세 개와 설명. 날마다 표는 renderRetentionTable */
function renderRetention() {
  if (!stats.retention.length) return [el('p', 'empty', t('stats.ret.empty'))];
  const box = (label, { n, of }) => tile(t(label), of ? percent(n, of) : '–', of ? t('stats.ret.of', { n: num(n), of: num(of) }) : t('stats.ret.notYet'));
  const tiles = el('div', 'stat-tiles');
  tiles.append(
    box('stats.ret.d1', retentionSum((c) => c.d1, (c) => c.d1 != null)),
    box('stats.ret.d7', retentionSum((c) => c.d7, (c) => c.d7 != null)),
    box('stats.ret.back', retentionSum((c) => c.returned, (c) => returned(c) != null)),
  );
  return [tiles, el('p', 'stat-note', t('stats.ret.note'))];
}

function renderRetentionTable() {
  const share = (pick) => (c) => numCell(pick(c), c.new ? percent(pick(c) ?? 0, c.new) : '');
  return dayTable([['', [
    ['stats.ret.new', (c) => numCell(c.new)],
    ['stats.ret.c.d1', share((c) => c.d1)],
    ['stats.ret.c.d7', share((c) => c.d7)],
    ['stats.ret.c.back', share(returned)],
  ]]], [...stats.retention].reverse(), { narrow: true });
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
  section.querySelector('#stat-countries-title').textContent = t('stats.countries', { n: days });
  section.querySelector('#stat-countries').replaceChildren(...renderCountries());
  section.querySelector('#stat-ret-title').textContent = t('stats.ret', { n: days });
  section.querySelector('#stat-ret').replaceChildren(...renderRetention());
  section.querySelector('#stat-ret-label').textContent = t('stats.ret.table');
  section.querySelector('#stat-ret-table').replaceChildren(stats.retention.length ? renderRetentionTable() : '');
  section.querySelector('#stat-ret-label').parentElement.hidden = !stats.retention.length;
  section.querySelector('#stat-table-label').textContent = t('stats.table');
  section.querySelector('#stat-table').replaceChildren(renderTable());
}
