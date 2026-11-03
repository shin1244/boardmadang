// 내 프로필: 상단의 내 이름을 누르면 오는 화면입니다.
// 내가 올린 게임(계정만, GET /api/uploads): 내리기와 다시 올리기는 여기서 바로 하고(PATCH /api/uploads/<id>),
//   등록 정보 고치기는 게임 등록 화면을 ?edit=<id>로 엽니다. 개발 서버에는 /api/uploads가 없어서(404) 빠집니다.
// 내 대국: 서버에 저장된 내 기보를 최근 것부터 보여줍니다 (GET /api/matches).
// 게스트의 기록은 이 브라우저의 세션 쿠키에 묶여 있습니다. 쿠키를 지우면 새 게스트가 되어 목록이 비어 보입니다.

import { localize } from '/sdk/playground/listing.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { displayName, isMember, loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);

let me = null;
let games = new Map(); // 게임 id → /api/games 항목
let matches = null;
let loadError = null;
/** GET /api/uploads의 내 게임(로비 항목 + published, hidden). 게스트이거나 개발 서버면 null */
let mine = null;
let mineError = '';
/** 내리기나 다시 올리기를 보내는 중인 게임 id */
let mineBusy = null;

const gameName = (id) => localize(games.get(id)?.listing?.name, lang).text || id;

// ---- 내가 올린 게임 ----

async function loadMine() {
  try {
    const res = await fetch('/api/uploads', { cache: 'no-store' });
    if (res.status === 404) return; // 개발 서버
    if (!res.ok) throw new Error(res.status);
    mine = (await res.json()).games;
    mineError = '';
  } catch (e) {
    mine ??= [];
    mineError = t('mine.loadFailed', { msg: e.message });
  }
}

function renderMine() {
  const section = $('#mine');
  section.hidden = !isMember(me) || mine === null;
  if (section.hidden) return;
  $('#mine-count').textContent = `${mine.length}`;
  $('#mine-list').replaceChildren(...mine.map(renderMyGame));
  const empty = $('#mine-empty');
  empty.hidden = mine.length > 0;
  empty.textContent = t('mine.empty');
  $('#mine-status').textContent = mineError;
}

function renderMyGame(g) {
  const li = document.createElement('li');
  li.className = 'room mine';
  li.classList.toggle('off', !!g.hidden);
  li.innerHTML = `
    <div class="room-info"><b class="room-game"></b><span class="room-sub"></span></div>
    <div class="mine-actions"></div>`;
  const name = li.querySelector('.room-game');
  name.textContent = localize(g.listing?.name, lang).text || g.id;
  if (g.hidden) {
    const tag = document.createElement('small');
    tag.className = 'mine-tag';
    tag.textContent = t('mine.hidden');
    name.append(tag);
  }
  li.querySelector('.room-sub').textContent = t('mine.meta', {
    id: g.id, version: g.version.slice(0, 8), date: new Date(g.published).toLocaleDateString(lang),
  });

  const actions = li.querySelector('.mine-actions');
  const link = (key, href) => {
    const a = document.createElement('a');
    a.className = 'btn ghost';
    a.href = href;
    a.textContent = t(key);
    actions.append(a);
  };
  const id = encodeURIComponent(g.id);
  link('mine.edit', `/web/register.html?edit=${id}`);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn ghost';
  toggle.textContent = t(g.hidden ? 'mine.show' : 'mine.hide');
  toggle.disabled = mineBusy !== null;
  toggle.addEventListener('click', () => setHidden(g, !g.hidden));
  actions.append(toggle);
  // 내린 게임은 로비에 없습니다
  if (!g.hidden) link('register.toLobby', `/web/?game=${id}`);
  return li;
}

/** 로비에서 내리거나(hidden = true) 다시 올립니다 */
async function setHidden(g, hidden) {
  const name = localize(g.listing?.name, lang).text || g.id;
  if (mineBusy !== null || (hidden && !confirm(t('mine.hideConfirm', { name })))) return;
  mineBusy = g.id;
  mineError = '';
  render();
  try {
    const res = await fetch(`/api/uploads/${encodeURIComponent(g.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(editError(res.status, body));
    mine = mine.map((x) => (x.id === g.id ? body.game : x));
  } catch (e) {
    mineError = t('mine.failed', { msg: e.message });
  }
  mineBusy = null;
  render();
}

/** PATCH /api/uploads/<id>의 실패 이유 (게임 등록 화면과 같음) */
function editError(status, body) {
  if (status === 429) return t('mine.tooMany');
  if (status === 404) return t('mine.gone');
  return body.error ?? String(status);
}

// ---- 내 대국 ----

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
  applyStatic('profile.title');
  renderMe(me);
  $('#who').textContent = me ? displayName(me) : t('profile.title');
  renderMine();
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
  render();
  try {
    const [gamesRes, matchesRes] = await Promise.all([
      fetch('/api/games'),
      fetch('/api/matches', { cache: 'no-store' }),
      isMember(me) ? loadMine() : null,
    ]);
    games = new Map((await gamesRes.json()).map((g) => [g.id, g]));
    if (!matchesRes.ok) throw new Error(matchesRes.status);
    matches = await matchesRes.json();
  } catch (e) {
    loadError = e.message;
  }
  render();
}

main();
