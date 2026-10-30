// 방 목록: 방 만들기로 열린 방들을 최근에 만들거나 올린 순서로 보여줍니다 (GET /api/rooms).
// 방장은 대전 화면에서 1분에 한 번 자기 방을 맨 위로 다시 올릴 수 있습니다.
// 들어가기를 누르면 대전 화면(match.html?game=x&room=CODE)으로 가서 바로 시작합니다.

import { localize } from '/sdk/playground/listing.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { displayName, loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);
const REFRESH_MS = 15_000;

let me = null;
let games = new Map(); // 게임 id → /api/games 항목
let rooms = null; // 마지막으로 받은 목록
let fetchedAt = 0;
let loadError = null;

const gameName = (id) => localize(games.get(id)?.listing?.name, lang).text || id;

/** 마지막으로 올린 뒤 지난 시간. 받은 뒤로 흐른 시간도 더합니다. */
function ageText(room) {
  const s = room.age + Math.floor((Date.now() - fetchedAt) / 1000);
  if (s < 60) return t('rooms.age.now');
  if (s < 3600) return t('rooms.age.min', { n: Math.floor(s / 60) });
  return t('rooms.age.hour', { n: Math.floor(s / 3600) });
}

async function load() {
  try {
    const res = await fetch('/api/rooms', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    rooms = await res.json();
    fetchedAt = Date.now();
    loadError = null;
  } catch (e) {
    loadError = e.message;
  }
  render();
}

function renderFilter() {
  const select = $('#game-filter');
  const chosen = select.value;
  // 열린 방이 있는 게임만 고를 수 있게 합니다. 고른 게임은 방이 없어져도 남겨 둡니다.
  const ids = [...new Set([...(rooms ?? []).map((r) => r.game), ...(chosen ? [chosen] : [])])];
  ids.sort((a, b) => gameName(a).localeCompare(gameName(b), lang));
  select.replaceChildren(select.options[0], ...ids.map((id) => new Option(gameName(id), id)));
  select.value = chosen;
}

function renderRoom(room) {
  const li = document.createElement('li');
  li.className = 'room';
  li.innerHTML = `
    <div class="room-info"><b class="room-game"></b><span class="room-sub"></span></div>
    <span class="room-timer"></span>
    <a class="btn"></a>`;
  li.querySelector('.room-game').textContent = gameName(room.game);
  li.querySelector('.room-sub').textContent = `${displayName(room.host)} · ${ageText(room)}`;
  const timer = li.querySelector('.room-timer');
  timer.textContent = room.minutes === null ? t('timer.none') : t('timer.each', { m: room.minutes });
  timer.classList.toggle('none', room.minutes === null);
  const a = li.querySelector('.btn');
  a.href = `/web/match.html?game=${encodeURIComponent(room.game)}&room=${encodeURIComponent(room.room)}`;
  a.textContent = t('rooms.enter');
  return li;
}

function render() {
  applyStatic('rooms.title');
  renderMe(me);
  renderFilter();
  const filter = $('#game-filter').value;
  const shown = (rooms ?? []).filter((r) => !filter || r.game === filter);
  $('#list').replaceChildren(...shown.map(renderRoom));
  $('#count').textContent = rooms ? `${shown.length}` : '';
  const empty = $('#empty');
  empty.hidden = shown.length > 0 || (!rooms && !loadError);
  empty.textContent = loadError ? t('rooms.failed', { msg: loadError }) : t('rooms.empty');
}

async function main() {
  setupLangButtons(render);
  setLang(await detectLang());
  render();
  me = await loadMe();
  try {
    games = new Map((await (await fetch('/api/games')).json()).map((g) => [g.id, g]));
  } catch {
    // 이름 대신 게임 id를 보여줍니다
  }
  $('#game-filter').addEventListener('change', render);
  $('#refresh').addEventListener('click', load);
  // 보고 있는 동안만 자동으로 새로고침합니다
  setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });
  await load();
}

main();
