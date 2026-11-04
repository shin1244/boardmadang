// AI 학습 기록: 운영자가 이 게임의 AI를 자기 컴퓨터에서 학습하는 동안 몇 분마다 찍은 스냅샷입니다 (trainer/train.py의 Snapshots).
// 스냅샷마다 그때의 AI끼리 둔 판(다시보기는 replay.html?training=<게임>&snap=<i>&n=<j>), 앞 스냅샷부터 그때까지의 자가 대국 통계,
// 마지막 평가(무작위 상대, 완전 탐색 상대, 정답 수 일치)가 있습니다. 제작자는 이것으로 AI가 제대로 배우는지,
// 한쪽만 이기는 꼼수나 규칙의 구멍, 게임 코드의 오류를 찾았는지 봅니다.
// 게임의 허점이 드러날 수 있어 게임 제작자와 운영자만 볼 수 있습니다 (GET /api/ai/<게임>/training, server/internal/ai).

import { PLAYER_COLORS } from '/sdk/playground/board.js';
import { localize } from '/sdk/playground/listing.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);
const game = new URLSearchParams(location.search).get('game') ?? '';

/** 자가 대국에서 한쪽이 이만큼 넘게 이기면 꼼수나 필승법을 의심합니다 (판이 MIN_GAMES판 넘을 때만) */
const ONE_SIDED = 0.9;
const MIN_GAMES = 10;
/** 되풀이로 끊은 판이 이만큼 넘으면 알립니다 */
const CUT_SHARE = 0.3;

let me = null;
let data = null; // GET /api/ai/<게임>/training
let entry = null; // /api/games의 항목 (내린 게임이면 없음)
/** 불러오지 못한 이유 { key, params } */
let problem = null;

const percent = (n, total) => Math.round((n / total) * 100);
const sideName = (p) => t(p === 0 ? 'match.first' : 'match.second');
/** 학습 몇 분째인지. 0분은 "학습 전" (web/replay.js와 같은 글) */
const minuteText = (m) => (m === 0 ? t('training.before') : t('training.minute', { m: m < 10 ? Math.round(m * 10) / 10 : Math.round(m) }));
const wdl = ([w, d, l]) => t('training.wdl', { w, d, l });

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const gameName = () => localize(entry?.listing?.name, lang).text || data?.game || game;

/** 스냅샷에서 눈여겨볼 것: 한쪽만 이김, 되풀이로 끊긴 판이 많음, 수 상한까지 간 판 */
function flags(s) {
  const out = [];
  const sp = s.selfplay;
  if (sp && sp.games >= MIN_GAMES) {
    for (const p of [0, 1]) {
      if (sp.wins[p] / sp.games >= ONE_SIDED) out.push(t('training.flag.oneSided', { side: sideName(p), pct: percent(sp.wins[p], sp.games) }));
    }
    if (sp.cut / sp.games >= CUT_SHARE) out.push(t('training.flag.cut', { pct: percent(sp.cut, sp.games) }));
  }
  if (s.games.some((g) => g.reason === 'maxActions')) out.push(t('training.flag.maxActions'));
  return out;
}

/** 자가 대국의 선공 승, 무승부, 후공 승, 되풀이로 끊음을 한 줄 막대로 */
function bar(sp) {
  const parts = [
    ['first', sp.wins[0]], ['draw', sp.draws - sp.cut], ['second', sp.wins[1]], ['cut', sp.cut],
  ];
  const wrap = el('div', 'training-bar');
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', t('training.barLabel', {
    first: percent(sp.wins[0], sp.games), second: percent(sp.wins[1], sp.games),
    draw: percent(sp.draws, sp.games),
  }));
  for (const [kind, n] of parts) {
    if (!n) continue;
    const seg = el('span', kind);
    seg.style.flexGrow = String(n);
    seg.title = `${t(`training.legend.${kind}`)} ${n}`;
    wrap.append(seg);
  }
  return wrap;
}

/** AI끼리 둔 판 하나의 결과 글 */
function gameResult(g) {
  if (g.reason === 'cut') return t('training.result.cut');
  if (g.reason === 'maxActions') return t('training.result.maxActions');
  if (g.winner === null) return t('match.draw');
  return t('replay.sideWon', { side: sideName(g.winner) });
}

function renderSnapshot(s, i) {
  const li = el('li', 'training-snap');
  const head = el('div', 'training-head');
  head.append(el('b', '', minuteText(s.minute)));
  if (s.iteration) head.append(el('small', 'training-iter', t('training.iteration', { n: s.iteration })));
  li.append(head);

  const sp = s.selfplay;
  if (sp && sp.games) {
    li.append(bar(sp));
    const line = t('training.selfplay', {
      games: sp.games, first: sp.wins[0], second: sp.wins[1], draws: sp.draws,
      avg: Math.round((sp.moves / sp.games) * 10) / 10,
    });
    li.append(el('p', 'training-line', sp.cut ? `${line} · ${t('training.cut', { n: sp.cut })}` : line));
  } else {
    li.append(el('p', 'training-line', t(i === 0 ? 'training.untrained' : 'training.noSelfplay')));
  }

  if (s.eval) {
    const ev = el('ul', 'training-eval');
    if (s.eval.random) ev.append(el('li', '', t('training.eval.random', { first: wdl(s.eval.random.first), second: wdl(s.eval.random.second) })));
    if (s.eval.perfect) ev.append(el('li', '', t('training.eval.perfect', { first: wdl(s.eval.perfect.first), second: wdl(s.eval.perfect.second) })));
    if (s.eval.accuracy) {
      ev.append(el('li', '', t('training.eval.accuracy', {
        policy: percent(s.eval.accuracy.policy, 1), search: percent(s.eval.accuracy.search, 1),
      })));
    }
    li.append(ev);
  }

  const warn = flags(s);
  if (warn.length) {
    const ul = el('ul', 'training-flags');
    for (const text of warn) ul.append(el('li', '', text));
    li.append(ul);
  }

  const games = el('ul', 'training-games');
  s.games.forEach((g, j) => {
    const a = el('a', 'btn ghost');
    a.href = `/web/replay.html?training=${encodeURIComponent(data.game)}&snap=${i}&n=${j}`;
    a.append(el('b', '', t('training.game', { n: j + 1 })), ' ', gameResult(g), ' · ', t('history.moves', { n: g.moves.length }));
    if (g.winner !== null) a.style.borderLeftColor = PLAYER_COLORS[g.winner];
    const item = el('li');
    item.append(a);
    games.append(item);
  });
  li.append(games);
  return li;
}

function render() {
  applyStatic('training.title');
  renderMe(me);
  const p = $('#problem');
  p.hidden = !problem;
  p.textContent = problem ? t(problem.key, problem.params) : '';
  $('#body').hidden = !data;
  $('#meta').hidden = !data;
  if (!data) return;
  document.title = `${gameName()} · ${t('training.title')} · ${t('site.name')}`;
  $('#title').textContent = `${gameName()} · ${t('training.title')}`;
  const last = data.snapshots.at(-1);
  $('#meta').textContent = t('training.meta', {
    minutes: last ? minuteText(last.minute) : '-',
    n: data.snapshots.length,
    version: data.version ? data.version.slice(0, 8) : '-',
    date: data.updated ? new Date(data.updated).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) : '-',
  });
  $('#version-note').hidden = !entry || !data.version || entry.version === data.version;
  $('#snaps').replaceChildren(...data.snapshots.map(renderSnapshot));
}

async function main() {
  setupLangButtons(render);
  setLang(await detectLang());
  render();
  me = await loadMe();
  try {
    const [res, gamesRes] = await Promise.all([
      fetch(`/api/ai/${encodeURIComponent(game)}/training`, { cache: 'no-store' }),
      fetch('/api/games').catch(() => null),
    ]);
    if (gamesRes?.ok) entry = (await gamesRes.json()).find((g) => g.id === game) ?? null;
    if (res.status === 401) problem = { key: 'training.login' };
    else if (res.status === 404 || !game) problem = { key: 'training.none' };
    else if (!res.ok) throw new Error(res.status);
    else data = await res.json();
  } catch (e) {
    problem = { key: 'training.failed', params: { msg: e.message } };
  }
  render();
}

main();
