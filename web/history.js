// 내 대국: 서버에 저장된 내 기보를 최근 것부터 보여줍니다 (GET /api/matches).
// 게스트의 기록은 이 브라우저의 세션 쿠키에 묶여 있습니다. 쿠키를 지우면 새 게스트가 되어 목록이 비어 보입니다.

import { localize } from '/sdk/playground/listing.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { displayName, loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);

let me = null;
let games = new Map(); // 게임 id → /api/games 항목
let matches = null;
let loadError = null;

const gameName = (id) => localize(games.get(id)?.listing?.name, lang).text || id;

/** 내 쪽에서 본 결과: [글, class] */
function resultOf(m) {
  if (['desync', 'disagree', 'limit'].includes(m.reason)) return [t('history.void'), 'void'];
  if (m.winner === null) return [t('history.draw'), 'draw'];
  if (m.you.length !== 1) return [t('history.self'), 'draw']; // 혼자 두 자리
  return m.winner === m.you[0] ? [t('history.win'), 'win'] : [t('history.lose'), 'lose'];
}

function renderMatch(m) {
  const li = document.createElement('li');
  li.className = 'room';
  li.innerHTML = `
    <span class="result-tag"></span>
    <div class="room-info"><b class="room-game"></b><span class="room-sub"></span></div>
    <span class="room-timer"></span>
    <a class="btn ghost"></a>`;
  const [text, cls] = resultOf(m);
  const tag = li.querySelector('.result-tag');
  tag.textContent = text;
  tag.classList.add(cls);
  li.querySelector('.room-game').textContent = gameName(m.game);
  const opp = m.you.length === 1 ? m.players[1 - m.you[0]] : null;
  const date = new Date(m.ended).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
  li.querySelector('.room-sub').textContent = [
    opp ? t('history.vs', { name: displayName(opp) }) : null,
    t('history.moves', { n: m.count }),
    date,
  ].filter(Boolean).join(' · ');
  const timer = li.querySelector('.room-timer');
  timer.textContent = m.minutes === null ? t('timer.none') : t('timer.each', { m: m.minutes });
  timer.classList.toggle('none', m.minutes === null);
  const a = li.querySelector('.btn');
  a.href = `/web/replay.html?id=${encodeURIComponent(m.id)}`;
  a.textContent = t('history.open');
  return li;
}

function render() {
  applyStatic('history.title');
  renderMe(me);
  const list = matches ?? [];
  $('#list').replaceChildren(...list.map(renderMatch));
  $('#count').textContent = matches ? `${list.length}` : '';
  const empty = $('#empty');
  empty.hidden = list.length > 0 || (!matches && !loadError);
  empty.textContent = loadError ? t('history.failed', { msg: loadError }) : t('history.empty');
}

async function main() {
  setupLangButtons(render);
  setLang(await detectLang());
  render();
  me = await loadMe();
  try {
    games = new Map((await (await fetch('/api/games')).json()).map((g) => [g.id, g]));
    const res = await fetch('/api/matches', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    matches = await res.json();
  } catch (e) {
    loadError = e.message;
  }
  render();
}

main();
