// 로비: 첫 화면(무엇을 하는 곳인지), 게임 목록, 필터.
// 이름, 소개, 룰북, 난이도, 지원 언어, 타이머는 등록 정보(listing)에서, 보드 모양은 게임 모듈에서 읽어 옵니다.
// 썸네일은 게임의 setup()이 만든 시작 화면을 플랫폼 렌더러로 그린 것입니다.

import { BoardView, PLAYER_COLORS, fieldOf, innerSize } from '/sdk/playground/board.js';
import { loadGame, modelFits } from './engine.js';
import { LANGS, LANG_NAMES, NO_TIMER, fullLangs, gameLang, isRtl, localize, timerOf } from '/sdk/playground/listing.js';
import { applyStatic, byLangOrder, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { displayName, isMember, loadMe, openLogin, renderMe, suspendedText } from './me.js';

const $ = (sel) => document.querySelector(sel);

/** 게임 만드는 법 (SDK 안내). 한국어 화면은 한국어판, 나머지는 영어판 */
const sdkDocs = () => `https://github.com/shin1244/boardmadang/blob/main/sdk/README${lang === 'ko' ? '.ko' : ''}.md`;

// ---- 게임 목록 ----

/** 썸네일이 없는 게임의 시작 판에 쓸 고정 시드. 랜덤이 있는 게임도 매번 같은 그림이 나옵니다. */
const THUMB_SEED = 1;

/** 판 크기 { rows, cols }. 판 밖 영역(board.areas)이 있으면 영역을 뺀 가운데 판만 셉니다 */
function fieldSize(board) {
  const { field } = fieldOf(board);
  return { rows: field.bottom - field.top, cols: field.right - field.left };
}
/** 화면에 보일 판 크기 글자 ("8×8") */
const dimsOf = (board) => {
  const { rows, cols } = fieldSize(board);
  return `${rows}×${cols}`;
};

function sizeClass(board) {
  const { rows, cols } = fieldSize(board);
  const n = Math.max(rows, cols);
  if (n <= 5) return 'small';
  if (n <= 10) return 'medium';
  return 'large';
}

const nameOf = (e) => localize(e.listing?.name, lang).text || e.id;

/** 이 게임이 실제로 쓰는 타이머. turn()이 없으면 시계를 돌릴 수 없어 없음입니다 (match.js와 같음). */
const timerOfEntry = (e) => (e.game?.turn ? timerOf(e.listing) : NO_TIMER);
const timerText = (m) => (m === null ? t('timer.none') : t('timer.each', { m }));

/** 검색에는 화면 언어와 상관없이 모든 언어의 이름과 소개를 씁니다. */
function searchText(e) {
  const all = (v) => (v ? Object.values(v) : []);
  return [e.id, ...all(e.listing?.name), ...all(e.listing?.description)].join(' ').toLowerCase();
}

/**
 * 게임 목록을 받고, 게임마다 실행기(engine.js)의 샌드박스에서 코드를 불러와 판 정보와 시작 판만 받은 뒤 닫습니다.
 * 남이 올린 게임 코드를 이 페이지(사이트 권한)에서 돌리지 않기 위해서입니다.
 * e.game은 실행기가 알려 준 정보 { board, pieces, specialActions, maxActions, turn: turn()이 있는지 }입니다.
 * 학습한 AI(e.ai)가 있으면 그 관측과 행동의 모양이 지금 코드와 같은지도 봅니다 (e.aiReady, web/ai.js와 같은 확인).
 */
async function loadGames() {
  const res = await fetch('/api/games');
  const list = await res.json();
  return Promise.all(list.map(async (entry) => {
    let runner = null;
    try {
      runner = await loadGame(entry);
      const { look } = await runner.start(THUMB_SEED, { players: [0], lang: gameLang(entry.listing, lang) });
      const aiReady = !!entry.ai && runner.info.turn && modelFits(entry.ai, await runner.ai(entry.ai.lang).catch(() => null));
      return { ...entry, game: runner.info, startView: look.views[0], aiReady };
    } catch (e) {
      return { ...entry, error: e.message };
    } finally {
      runner?.close();
    }
  }));
}

function addBadge(el, text, title, cls = '') {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  if (title) b.title = title;
  el.append(b);
}

/**
 * 게임 그림. 제작자가 혼자 두던 판을 그대로 찍은 썸네일(thumbnail.json)이 있으면 그 판을, 없으면 시작 판을 그립니다.
 * 썸네일은 이미지가 아니라 판 설정, 기물 세트, 화면 데이터라서 같은 보드 렌더러로 그립니다. 그리지 못하면 false
 */
function drawThumb(canvas, entry, size) {
  canvas.dataset.size = String(size);
  const { game, thumbnail: shot } = entry;
  if (shot) {
    try {
      const board = new BoardView(canvas, shot.board, shot.pieces);
      board.resize(size);
      board.draw(shot.view, { flip: shot.board.flipForPlayer === shot.player, animate: false });
      return true;
    } catch {
      // 깨진 썸네일이면 시작 판을 그립니다
    }
  }
  try {
    const board = new BoardView(canvas, game.board, game.pieces);
    board.resize(size);
    const view = entry.startView ?? { pieces: [] };
    board.draw({ ...view, marks: (view.marks ?? []).filter((m) => m.type !== 'last-move') }, { animate: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * 그림 칸이 정해진 뒤 그 칸에 꼭 맞는 크기로 다시 그립니다 (처음에는 칸이 화면에 붙기 전이라 크기를 모름).
 * 화면 크기가 바뀌어도 다시 맞춥니다.
 */
function fitThumb(box, canvas, entry) {
  if (!box.isConnected || box.classList.contains('no-thumb')) return;
  const { w, h } = innerSize(box);
  const size = Math.floor(Math.min(w, h));
  if (size > 0 && canvas.dataset.size !== String(size)) drawThumb(canvas, entry, size);
}

function fitThumbs() {
  for (const [entry, card] of cards) {
    const box = card.querySelector('.thumb');
    if (box) fitThumb(box, box.querySelector('canvas'), entry);
  }
  if (current && $('#game').open) fitThumb($('#gd-thumb'), $('#gd-thumb canvas'), current);
}

let fitTimer = 0;
addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitThumbs, 120);
});

/** 소개 글. 화면 언어로 쓴 소개가 없으면 다른 언어 소개를 보여주고, 읽기 프로그램을 위해 lang을 붙입니다. */
function fillDescription(p, entry) {
  p.removeAttribute('lang');
  if (!entry.listing) {
    // 등록 정보가 없는 게임. 실제 사이트에서는 목록에 나오지 않고, 개발 서버에서만 보입니다.
    p.textContent = t('card.unregistered.desc');
    return;
  }
  const desc = localize(entry.listing.description, lang);
  p.textContent = desc.text;
  if (desc.lang !== lang) p.lang = desc.lang;
}

function addBadges(el, entry) {
  if (entry.private) addBadge(el, t('card.private'), t('card.private.title'));
  if (!entry.listing) addBadge(el, t('card.unregistered'), null, 'warn');
}

/** 카드와 필터에 쓰는 작은 그림 (16×16, 선은 CSS가 글자 색으로 칠합니다. .fill은 면) */
const ICONS = {
  cells: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M8 2v12M2 8h12"/><rect class="fill" x="9.5" y="3.5" width="3" height="3"/></svg>',
  points: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h12M2 11h12M5 2v12M11 2v12"/><circle class="fill" cx="11" cy="5" r="2"/></svg>',
  clock: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 1.5"/></svg>',
  plays: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="fill" d="M5 3.5v9l7-4.5z"/></svg>',
  chip: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 1.5v2.5M9.5 1.5v2.5M6.5 12v2.5M9.5 12v2.5M1.5 6.5h2.5M1.5 9.5h2.5M12 6.5h2.5M12 9.5h2.5"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  globe: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2.2 2 2.2 10 0 12M8 2c-2.2 2-2.2 10 0 12"/></svg>',
};

/** 난이도 막대 (하 1칸, 중 2칸, 상 3칸). 글자는 title과 읽기 프로그램용 이름으로 */
function difficultyBars(d) {
  const bars = document.createElement('span');
  bars.className = `bars d${{ easy: 1, normal: 2, hard: 3 }[d] ?? 0}`;
  bars.innerHTML = '<i></i><i></i><i></i>';
  bars.setAttribute('role', 'img');
  const label = t('tag.difficulty', { d: t(`difficulty.${d}`) });
  bars.setAttribute('aria-label', label);
  bars.title = label;
  return bars;
}

/** 카드 아래의 한 줄: 판 크기, 시간, 난이도, 언어, 둔 판 수를 아이콘과 숫자로 (글은 title에) */
function cardMeta(entry) {
  const { game, listing } = entry;
  const row = document.createElement('div');
  row.className = 'card-meta';
  const item = (icon, text, title, cls = '') => {
    const s = document.createElement('span');
    s.className = `meta ${cls}`;
    s.innerHTML = icon;
    s.append(text);
    s.title = title;
    row.append(s);
  };
  const dims = dimsOf(game.board);
  const points = game.board.places === 'points';
  item(points ? ICONS.points : ICONS.cells, dims, `${t(points ? 'tag.points' : 'tag.cells')} · ${dims}`);
  if (listing) {
    const timer = timerOfEntry(entry);
    if (timer.minutes !== null) item(ICONS.clock, t('timer.short', { m: timer.minutes }), timerText(timer.minutes));
    row.append(difficultyBars(listing.difficulty));
  }
  if (entry.plays) {
    const n = entry.plays.toLocaleString(lang);
    item(ICONS.plays, n, entry.plays === 1 ? t('tag.plays.one') : t('tag.plays', { n }));
  }
  if (listing) {
    const full = fullLangs(listing);
    item('', full.map((l) => l.toUpperCase()).join(' · '), full.map((l) => t('tag.lang.full', { lang: LANG_NAMES[l] })).join(', '), 'langs');
  }
  return row;
}

/** 카드: 판 그림이 크게, 아래에 이름과 아이콘 한 줄. 누르면 게임 창이 뜨고, 마우스를 올리면 대전 찾기·방 만들기가 보입니다. */
function renderCard(entry) {
  const card = document.createElement('article');
  card.className = 'card';

  if (entry.error) {
    card.classList.add('broken');
    card.innerHTML = `<div class="card-body"><h3></h3><p class="desc"></p></div>`;
    card.querySelector('h3').textContent = entry.id;
    card.querySelector('.desc').textContent = t('card.failed', { msg: entry.error });
    return card;
  }

  const name = nameOf(entry);
  const id = encodeURIComponent(entry.id);
  card.innerHTML = `
    <div class="thumb"><canvas></canvas><button type="button" class="star-btn" aria-pressed="false"></button>
      <div class="card-actions"><a class="btn"></a><button type="button" class="btn ghost"></button></div>
    </div>
    <div class="card-body">
      <h3><button type="button" class="card-open"></button></h3>
    </div>`;
  const open = card.querySelector('.card-open');
  open.textContent = name;
  open.setAttribute('aria-label', t('detail.open', { name }));
  open.addEventListener('click', () => openGame(entry));
  addBadges(card.querySelector('h3'), entry);
  card.querySelector('.card-body').append(cardMeta(entry));
  if (!drawThumb(card.querySelector('canvas'), entry, 260)) card.querySelector('.thumb').classList.add('no-thumb');
  if (entry.aiReady) {
    const ai = document.createElement('span');
    ai.className = 'card-badge ai';
    ai.innerHTML = `${ICONS.chip}AI`;
    ai.title = t('card.ai');
    card.querySelector('.thumb').append(ai);
  }
  const [match, create] = card.querySelectorAll('.card-actions .btn');
  match.textContent = t('card.match');
  match.href = `/web/match.html?game=${id}`;
  create.textContent = t('card.createRoom');
  create.addEventListener('click', () => openGame(entry, 'create'));
  const star = card.querySelector('.star-btn');
  fillStar(star, entry);
  star.addEventListener('click', (e) => toggleStar(entry, e));
  return card;
}

/** 목록 끝의 "내 게임 올리기" 칸 */
function renderAddCard() {
  const a = document.createElement('a');
  a.className = 'add-card';
  a.href = '/web/register.html';
  a.innerHTML = `<span class="add-icon">${ICONS.plus}</span><b></b><code>index.js → .zip</code>`;
  a.querySelector('b').textContent = t('card.addGame');
  return a;
}

// ---- 즐겨찾기 (별) ----
// 별은 계정만 답니다 (PUT·DELETE /api/games/<id>/star). 별 수는 /api/games의 stars, 내가 단 게임은 GET /api/stars.
// 누르면 먼저 바꿔 보여주고, 서버가 거절하면 되돌립니다.

let starred = new Set(); // 내가 별을 단 게임 id
const starBusy = new Set(); // 서버에 보내는 중인 게임 id

const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.9l2.8 5.7 6.3.9-4.55 4.43 1.07 6.27L12 17.25 6.38 20.2l1.07-6.27L2.9 9.5l6.3-.9z"/></svg>';

const starCount = (n) => (n === 1 ? t('star.count.one') : t('star.count', { n: n.toLocaleString(lang) }));

/** 별 버튼을 채웁니다. 카드는 별과 수만(수가 0이면 별만), 게임 창(wide)은 "즐겨찾기"라는 글자와 수까지 */
function fillStar(btn, entry) {
  const on = starred.has(entry.id);
  const n = entry.stars ?? 0;
  const wide = btn.classList.contains('wide');
  if (!btn.firstChild) btn.innerHTML = `${STAR_SVG}${wide ? '<span class="star-label"></span>' : ''}<span class="star-count"></span>`;
  btn.setAttribute('aria-pressed', String(on));
  if (wide) btn.querySelector('.star-label').textContent = t(on ? 'star.button.on' : 'star.button');
  const count = btn.querySelector('.star-count');
  count.textContent = n.toLocaleString(lang);
  count.hidden = !wide && n === 0;
  const label = t(on ? 'star.remove' : 'star.add', { name: nameOf(entry) });
  btn.setAttribute('aria-label', `${label} (${starCount(n)})`);
  btn.title = label;
}

/** 한 게임의 별 버튼(카드와 열린 게임 창)을 다시 채웁니다 */
function refreshStar(entry) {
  const card = cards.get(entry)?.querySelector('.star-btn');
  if (card) fillStar(card, entry);
  if (current === entry) fillStar($('#gd-star'), entry);
}

function setStar(entry, on, n) {
  if (on) starred.add(entry.id);
  else starred.delete(entry.id);
  entry.stars = Math.max(0, n);
  refreshStar(entry);
  // 별 단 게임만 보는 중이면 뺀 게임을 바로 감춥니다. 별 많은순은 누른 카드가 손 밑에서 움직이지 않게 다시 정렬하지 않습니다
  if ($('#only-starred').checked) apply();
}

/** 게임 창 안의 별 안내 (로그인, 오류). 창이 닫혀 있으면 오류는 알림으로 */
function starNote(kind, text = '') {
  const inDialog = $('#game').open;
  $('#gd-star-login').hidden = !(inDialog && kind === 'login');
  showError('#gd-star-error', inDialog && kind === 'error' ? text : null);
  if (!inDialog && kind === 'error') alert(text);
}

async function toggleStar(entry, e) {
  // 게스트면 로그인을 권합니다. 게임 창이 떠 있으면 상단 메뉴가 가려지므로 창 안에 안내를 보입니다
  e.stopPropagation(); // 이 클릭으로 연 로그인 메뉴가 바로 닫히지 않게
  if (!isMember(me)) {
    if ($('#game').open) starNote('login');
    else if (!openLogin()) alert(t('star.needLogin')); // 로그인 방법이 없는 서버 (준비 중)
    return;
  }
  if (starBusy.has(entry.id)) return;
  starNote(null);
  const on = !starred.has(entry.id);
  const before = entry.stars ?? 0;
  setStar(entry, on, before + (on ? 1 : -1));
  if (on) popStar(entry);
  starBusy.add(entry.id);
  let res = null;
  let body = {};
  try {
    res = await fetch(`/api/games/${encodeURIComponent(entry.id)}/star`, { method: on ? 'PUT' : 'DELETE' });
    body = await res.json().catch(() => ({ error: String(res.status) }));
  } catch (err) {
    body = { error: err.message };
  }
  starBusy.delete(entry.id);
  if (res?.ok) return setStar(entry, body.starred, body.stars);
  setStar(entry, !on, before);
  starNote('error', body.error === 'suspended' ? t('suspended') : t('star.error', { msg: body.error ?? '-' }));
}

/** 별을 달 때 별이 한 번 통통 튑니다 */
function popStar(entry) {
  for (const btn of [cards.get(entry)?.querySelector('.star-btn'), current === entry ? $('#gd-star') : null]) {
    if (!btn) continue;
    btn.classList.remove('pop');
    void btn.offsetWidth; // 연달아 눌러도 다시 튀게
    btn.classList.add('pop');
  }
}

/** 내가 별을 단 게임. 게스트이거나 못 받으면 빈 목록 */
async function loadStars() {
  if (!isMember(me)) return new Set();
  try {
    const res = await fetch('/api/stars', { cache: 'no-store' });
    const body = await res.json();
    return new Set(res.ok && Array.isArray(body.games) ? body.games : []);
  } catch {
    return new Set();
  }
}

// ---- 게임 창 ----
// 왼쪽: 그림, 이름, 대전 찾기, 방 만들기, 그리고 남은 자리를 채우는 의견 칸.
// 오른쪽: 소개 (방 만들기를 누르면 방 만들기, 의견 칸을 누르면 의견, 의견이나 게임을 신고하면 신고).
// 열려 있는 동안 주소에 ?game=<id>&tab=<메뉴>를 붙여 두므로 링크로 바로 열 수 있습니다.

const TABS = { about: 'detail.about', rules: 'card.rulebook', create: 'card.createRoom', comments: 'comments.title', report: 'report.title' };
/** 위의 탭으로 고르는 칸. 나머지(방 만들기, 신고)는 ‹와 제목으로 */
const TOP_TABS = ['about', 'rules', 'comments'];
let current = null; // 창에 띄운 게임
let tab = 'about';

function openGame(entry, startTab = 'about') {
  current = entry;
  tab = startTab in TABS ? startTab : 'about';
  if (tab === 'report') tab = 'comments'; // 무엇을 신고할지는 주소에 남기지 않습니다
  reportTarget = null;
  talkNote = '';
  starNote(null);
  loadComments(entry);
  initCreate();
  for (const d of document.querySelectorAll('.gd-fold')) d.open = false;
  fillDialog();
  const dlg = $('#game');
  if (!dlg.open) dlg.showModal();
  syncUrl();
}

function setTab(name) {
  tab = name;
  if (name !== 'comments') talkNote = '';
  fillDialog();
  syncUrl();
  $('.gd-body').scrollTop = 0;
  // 휴대폰에서는 오른쪽 칸이 아래에 있으므로 거기로 내려갑니다
  if (name !== 'about' && matchMedia('(max-width: 760px)').matches) $('.gd-main').scrollIntoView({ block: 'start' });
}

function syncUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('game');
  url.searchParams.delete('tab');
  if (current) {
    url.searchParams.set('game', current.id);
    if (tab !== 'about') url.searchParams.set('tab', tab === 'report' ? 'comments' : tab);
  }
  history.replaceState(null, '', url);
}

/** 지금 언어로 창을 채웁니다. 방 만들기에서 고르던 시간은 그대로 둡니다. */
function fillDialog() {
  const entry = current;
  const { game, listing } = entry;
  const id = encodeURIComponent(entry.id);

  // 왼쪽
  const name = $('#gd-name');
  name.textContent = nameOf(entry);
  addBadges(name, entry);
  $('#gd-thumb').classList.toggle('no-thumb', !drawThumb($('#gd-thumb canvas'), entry, 220));
  requestAnimationFrame(() => current === entry && fitThumb($('#gd-thumb'), $('#gd-thumb canvas'), entry));
  const meta = [dimsOf(game.board), t('tag.players')];
  if (listing) meta.push(t('tag.difficulty', { d: t(`difficulty.${listing.difficulty}`) }));
  $('#gd-meta').textContent = meta.join(' · ');
  fillStar($('#gd-star'), entry);
  $('#gd-match').href = `/web/match.html?game=${id}`;
  $('#gd-ai').hidden = !entry.aiReady;
  $('#gd-ai').href = `/web/ai.html?game=${id}`;
  $('#gd-create').setAttribute('aria-pressed', String(tab === 'create'));

  // 오른쪽: 룰북은 등록한 게임만 있습니다
  if (tab === 'rules' && !listing) tab = 'about';
  $('#gd-tab-rules').hidden = !listing;
  const top = TOP_TABS.includes(tab);
  $('#gd-tabs').hidden = !top;
  for (const b of document.querySelectorAll('#gd-tabs [data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === (tab === 'report' ? 'comments' : tab)));
  $('#gd-title').hidden = top;
  $('#gd-title').textContent = t(TABS[tab]);
  const back = $('#gd-back');
  back.hidden = top;
  // 신고에서 ‹를 누르면 의견으로, 나머지는 소개로 돌아갑니다
  const backLabel = t(tab === 'report' ? 'detail.backToComments' : 'detail.back');
  back.setAttribute('aria-label', backLabel);
  back.title = backLabel;
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab;
  fillAbout(entry);
  fillRulebook(entry);
  fillCreate(entry);
  renderTalk();
  fillReport();
}

/**
 * 선공·후공 승률: 학습 마지막 구간에 AI끼리 둔 판의 결과 (entry.ai.balance, trainer/train.py의 balance_from_log).
 * 막대(선공 승, 무승부, 후공 승), 범례, 몇 판에서 쟀는지와 한 줄 풀이. 이 기능 전에 내보낸 모델이면 줄을 숨깁니다.
 */
function fillBalance(entry) {
  const b = entry.ai?.balance;
  $('#gd-balance-row').hidden = !b?.games;
  if (!b?.games) return;
  const pct = (n) => Math.round((n / b.games) * 100);
  const parts = [
    { kind: 'first', n: b.wins[0], color: PLAYER_COLORS[0] },
    { kind: 'draw', n: b.draws },
    { kind: 'second', n: b.wins[1], color: PLAYER_COLORS[1] },
  ];
  const bar = $('#gd-balance-bar');
  bar.setAttribute('aria-label', t('balance.label', { first: pct(b.wins[0]), draw: pct(b.draws), second: pct(b.wins[1]) }));
  bar.replaceChildren();
  const legend = $('#gd-balance-legend');
  legend.replaceChildren();
  for (const { kind, n, color } of parts) {
    if (kind === 'draw' && !n) continue; // 무승부가 없는 게임은 범례에서도 뺍니다
    const seg = document.createElement('span');
    seg.className = kind;
    seg.style.flexGrow = String(n);
    if (color) seg.style.background = color;
    if (n) bar.append(seg);
    const li = document.createElement('li');
    const swatch = document.createElement('i');
    swatch.className = `swatch ${kind}`;
    if (color) swatch.style.background = color;
    li.append(swatch, `${t(`balance.${kind}`)} ${pct(n)}%`);
    legend.append(li);
  }
  // 풀이: 무승부가 반 넘으면 그것을, 아니면 선공과 후공 승률의 차이로
  const diff = (b.wins[0] - b.wins[1]) / b.games;
  const side = diff > 0 ? 'first' : 'second';
  const verdict = b.draws * 2 > b.games ? t('balance.drawish')
    : Math.abs(diff) < 0.1 ? t('balance.even')
      : t(`balance.${Math.abs(diff) < 0.25 ? 'slight' : 'strong'}.${side}`);
  const note = [t('balance.note', { games: b.games.toLocaleString(lang) }), verdict];
  if (entry.ai.version && entry.version && entry.ai.version !== entry.version) note.push(t('balance.oldVersion'));
  $('#gd-balance-note').textContent = note.join(' ');
}

/** 게임 창의 정보 타일: 판, 타이머, 난이도, 지원 언어. 둔 판 수와 특수 행동은 아래의 작은 태그로 */
function fillTiles(entry) {
  const { game, listing } = entry;
  const tiles = [];
  const tile = (icon, value, label) => {
    const d = document.createElement('div');
    d.className = 'gd-tile';
    if (typeof icon === 'string') d.innerHTML = icon;
    else d.append(icon);
    const b = document.createElement('b');
    b.append(value);
    const s = document.createElement('span');
    s.textContent = label;
    d.append(b, s);
    tiles.push(d);
  };
  const points = game.board.places === 'points';
  tile(points ? ICONS.points : ICONS.cells, dimsOf(game.board), t(points ? 'tag.points' : 'tag.cells'));
  const timer = timerOfEntry(entry);
  const none = timer.minutes === null;
  tile(ICONS.clock, none ? '—' : t('timer.short', { m: timer.minutes }),
    timer.custom ? t('detail.timer.custom') : none ? t('timer.none') : t('detail.timer.each'));
  if (listing) {
    tile(difficultyBars(listing.difficulty), t(`difficulty.${listing.difficulty}`), t('filter.difficulty'));
    tile(ICONS.globe, fullLangs(listing).map((l) => l.toUpperCase()).join(' · '), t('filter.lang'));
  }
  $('#gd-tiles').replaceChildren(...tiles);

  const extras = [];
  if (entry.plays) extras.push(entry.plays === 1 ? t('tag.plays.one') : t('tag.plays', { n: entry.plays.toLocaleString(lang) }));
  extras.push(t('tag.players'));
  if (game.specialActions?.length) extras.push(t('tag.special', { n: game.specialActions.length }));
  const ul = $('#gd-tags');
  ul.replaceChildren(...extras.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
  ul.hidden = !extras.length;
}

function fillAbout(entry) {
  const { listing } = entry;
  fillDescription($('#gd-desc'), entry);
  $('#gd-register').hidden = !!listing;
  $('#gd-register').href = `/web/register.html?game=${encodeURIComponent(entry.id)}`;
  fillTiles(entry);
  fillBalance(entry);
  // 제작자: 올린 게임만 이름(서버가 지금 계정 이름으로 줌)과 직접 이긴 판이 있습니다. 레포 게임은 둘 다 없어서 줄을 숨깁니다
  $('#gd-author-row').hidden = !entry.author && !entry.clear;
  $('#gd-author').hidden = !entry.author;
  $('#gd-author').textContent = entry.author ?? '';
  $('#gd-clear').hidden = !entry.clear;
  $('#gd-clear').href = `/web/replay.html?clear=${encodeURIComponent(entry.id)}`;
  $('#gd-langs-row').hidden = !listing;
  if (listing) {
    const levels = [...fullLangs(listing).map((l) => t('tag.lang.full', { lang: LANG_NAMES[l] })),
      ...LANGS.filter((l) => listing.languages[l] === 'rulebook').map((l) => t('tag.lang.rulebook', { lang: LANG_NAMES[l] }))];
    $('#gd-langs').textContent = levels.join(', ');
  }
}

// 룰북 언어: 처음에는 화면 언어로 보여 줍니다 (그 언어 룰북이 없으면 listing.js의 대체 순서).
// 화면 언어를 지원하지 않아도 읽을 수 있게, 게임이 가진 룰북 언어 중에서 고를 수 있습니다. 화면 언어는 그대로입니다.
// 고른 언어는 이 탭에서 여는 다른 게임에도 씁니다 (그 게임에 그 언어 룰북이 있으면). 화면 언어와 같은 언어를 고르면 다시 화면 언어를 따릅니다.
const RULEBOOK_KEY = 'boardmadang.rulebookLang';
let rulebookPick = null;
try {
  rulebookPick = sessionStorage.getItem(RULEBOOK_KEY);
} catch {
  // 저장소를 못 쓰면 이 화면에서만 기억합니다
}

function pickRulebookLang(l) {
  rulebookPick = l === lang ? null : l;
  try {
    if (rulebookPick) sessionStorage.setItem(RULEBOOK_KEY, rulebookPick);
    else sessionStorage.removeItem(RULEBOOK_KEY);
  } catch {
    // 저장 못 해도 이 화면에는 적용됩니다
  }
  if (current) fillRulebook(current);
}

/** 이 게임에 룰북이 있는 언어들 (i18n.js의 LANG_ORDER 순서: 화자 수가 많은 언어부터) */
const rulebookLangs = (listing) => byLangOrder(LANGS.filter((l) => typeof listing.rulebook?.[l] === 'string' && listing.rulebook[l]));

function fillRulebook(entry) {
  const { listing } = entry;
  const field = $('#gd-rulebook');
  const text = field.querySelector('.rulebook-text');
  field.hidden = !listing; // 등록 전이면 룰북이 없습니다
  if (!listing) {
    text.replaceChildren();
    return;
  }
  const have = rulebookLangs(listing);
  const picked = have.includes(rulebookPick) ? rulebookPick : null;
  const book = picked ? { text: listing.rulebook[picked], lang: picked } : localize(listing.rulebook, lang);

  // 룰북 언어가 둘 이상이면 고르는 칸을 보입니다. 언어 이름은 그 언어로 씁니다
  const select = $('#rulebook-lang');
  select.replaceChildren(...have.map((l) => {
    const option = new Option(LANG_NAMES[l], l, false, l === book.lang);
    option.lang = l;
    return option;
  }));
  select.closest('.rulebook-lang').hidden = have.length < 2;

  const notes = [];
  if (!picked && book.lang !== lang) notes.push(t('rulebook.fallback', { ui: LANG_NAMES[lang], lang: LANG_NAMES[book.lang] }));
  notes.push(t('rulebook.ingame', { lang: LANG_NAMES[gameLang(listing, lang)] }));
  field.querySelector('.rulebook-notes').textContent = notes.join(' ');

  // 빈 줄로 문단을 나눕니다. 글은 textContent로만 넣습니다 (제작자가 쓴 글을 HTML로 해석하지 않음).
  text.lang = book.lang ?? '';
  text.dir = isRtl(book.lang) ? 'rtl' : 'ltr';
  text.replaceChildren(...book.text.split(/\n\s*\n/).map((para) => {
    const el = document.createElement('p');
    el.textContent = para.trim();
    return el;
  }));
}

// ---- 의견과 신고 ----
// 의견은 게임마다 Go 서버에 쌓입니다 (GET·POST /api/games/<id>/comments, 내 의견 지우기는 DELETE).
// 신고는 POST /api/reports로 운영자에게 갑니다. 여러 사람이 신고한 의견은 서버가 글을 빼고 보냅니다 (hidden).

const COMMENT_REASONS = ['spam', 'abuse', 'adult', 'other'];
const GAME_REASONS = ['broken', 'copyright', 'abuse', 'adult', 'spam', 'other'];
const MAX_COMMENT = 500;
const ERRORS = {
  empty: 'comments.error.empty',
  'too long': 'comments.error.tooLong',
  'too soon': 'comments.error.tooSoon',
  'no session': 'comments.error.noSession',
  'too many reports': 'report.error.tooMany',
  'not found': 'report.error.gone',
  'member only': 'comments.error.memberOnly',
  suspended: 'suspended',
};

let talk = null; // 창에 띄운 게임의 의견 { game, list, count, error }. list가 null이면 불러오는 중
let reportTarget = null; // 신고할 것: { comment } 또는 { game: true }
let talkNote = ''; // 의견 위에 잠깐 보여줄 안내 (글자 key)

const commentsUrl = (game) => `/api/games/${encodeURIComponent(game)}/comments`;
const errorText = (code) => (ERRORS[code] ? t(ERRORS[code]) : t('comments.error.server', { msg: code }));

/** POST JSON. 응답 본문과 함께 돌려줍니다. 서버에 닿지 못하면 { ok: false, body: { error: 메시지 } } */
async function postJSON(url, data) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await res.json().catch(() => ({ error: String(res.status) }));
    return { ok: res.ok, body };
  } catch (e) {
    return { ok: false, body: { error: e.message } };
  }
}

async function loadComments(entry) {
  const game = entry.id;
  talk = { game, list: null, count: 0, error: null };
  try {
    const res = await fetch(commentsUrl(game), { cache: 'no-store' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.status);
    if (talk?.game !== game) return; // 그 사이에 다른 게임을 열었음
    talk.list = body.comments;
    talk.count = body.count;
  } catch (e) {
    if (talk?.game !== game) return;
    talk.error = e.message;
  }
  if (current?.id === game) renderTalk();
}

/** 지난 시간. 한 달이 넘으면 날짜로 씁니다. */
function ago(at) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(at)) / 1000));
  if (s < 60) return t('rooms.age.now');
  if (s < 3600) return t('rooms.age.min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('rooms.age.hour', { n: Math.floor(s / 3600) });
  if (s < 30 * 86400) return t('comments.age.day', { n: Math.floor(s / 86400) });
  return new Date(at).toLocaleDateString(lang);
}

/** 왼쪽 의견 칸(수와 최근 의견 하나)과 오른쪽 의견 목록 */
function renderTalk() {
  const list = talk?.list;
  const latest = list?.[0];
  $('#gd-talk').setAttribute('aria-pressed', String(tab === 'comments' || tab === 'report'));
  $('#gd-talk-count').textContent = list ? String(talk.count) : '';
  let preview = '';
  if (talk?.error) preview = t('comments.failed', { msg: talk.error });
  else if (list) preview = !latest ? t('comments.preview.empty')
    : `${displayName(latest.author)} · ${ago(latest.at)}\n${latest.hidden ? t('comments.preview.hidden') : latest.text}`;
  $('#gd-talk-preview').textContent = preview;

  // 의견은 계정만 남깁니다. 게스트에게는 남기는 칸 대신 로그인 안내를, 정지된 계정에는 정지 안내를 보여줍니다
  const writer = isMember(me) && !me.suspended;
  $('#comment-form').hidden = !writer;
  $('#comment-login').hidden = isMember(me);
  showSuspended('#comment-suspended');
  $('.comments-foot').hidden = !writer; // 게임 신고도 계정만
  $('#comment-as').textContent = me ? t('comments.as', { name: displayName(me) }) : '';
  syncCommentLength();
  const note = $('#comments-note');
  note.hidden = !talkNote;
  note.textContent = talkNote ? t(talkNote) : '';
  const shown = list ?? [];
  const empty = $('#comments-empty');
  empty.hidden = shown.length > 0 || (!list && !talk?.error);
  empty.textContent = talk?.error ? t('comments.failed', { msg: talk.error }) : t('comments.empty');
  $('#comments').replaceChildren(...shown.map(renderComment));
  $('#comments-more').hidden = !list || talk.count <= shown.length;
  $('#comments-more').textContent = t('comments.more', { n: shown.length });
}

function textButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'text-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function renderComment(c) {
  const li = document.createElement('li');
  li.className = 'comment';
  li.classList.toggle('hidden', !!c.hidden);
  li.innerHTML = `
    <div class="comment-head"><b></b><small></small><span class="comment-actions"></span></div>
    <p class="comment-text"></p>`;
  // 글은 textContent로만 넣습니다 (남이 쓴 글을 HTML로 해석하지 않음)
  li.querySelector('b').textContent = c.mine ? `${displayName(c.author)} (${t('match.you')})` : displayName(c.author);
  const when = li.querySelector('small');
  when.textContent = ago(c.at);
  when.title = new Date(c.at).toLocaleString(lang);
  li.querySelector('.comment-text').textContent = c.hidden ? t('comments.hidden') : c.text;
  const actions = li.querySelector('.comment-actions');
  if (c.mine) {
    actions.append(textButton(t('comments.delete'), () => deleteComment(c)));
  } else if (!c.hidden && isMember(me) && !me.suspended) { // 신고는 계정만 (정지된 계정은 안 됨)
    const report = textButton(t(c.reported ? 'comments.reported' : 'comments.report'), () => openReport({ comment: c }));
    report.disabled = !!c.reported;
    actions.append(report);
  }
  return li;
}

function showError(sel, text) {
  const el = $(sel);
  el.hidden = !text;
  el.textContent = text ?? '';
}

function syncCommentLength() {
  const n = [...$('#comment-text').value].length;
  const el = $('#comment-len');
  el.textContent = n ? `${n} / ${MAX_COMMENT}` : '';
  el.classList.toggle('over', n > MAX_COMMENT);
}

async function postComment(e) {
  e.preventDefault();
  const input = $('#comment-text');
  const text = input.value.trim();
  if (!text) return showError('#comment-error', errorText('empty'));
  if ([...text].length > MAX_COMMENT) return showError('#comment-error', errorText('too long'));
  const game = current.id;
  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true;
  const { ok, body } = await postJSON(commentsUrl(game), { text });
  button.disabled = false;
  if (!ok) return showError('#comment-error', errorText(body.error));
  showError('#comment-error', null);
  input.value = '';
  talkNote = '';
  if (talk?.game === game && talk.list) {
    talk.list.unshift(body);
    talk.count++;
  }
  renderTalk();
}

async function deleteComment(c) {
  if (!confirm(t('comments.deleteConfirm'))) return;
  const game = talk.game;
  let res = null;
  try {
    res = await fetch(`${commentsUrl(game)}/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
  } catch {
    // 아래에서 알립니다
  }
  // 이미 없으면(404) 지워진 것으로 봅니다
  if (!res?.ok && res?.status !== 404) {
    showError('#comment-error', t('comments.error.server', { msg: res?.status ?? '-' }));
    return;
  }
  if (talk?.game === game && talk.list?.includes(c)) {
    talk.list = talk.list.filter((x) => x !== c);
    talk.count--;
  }
  renderTalk();
}

function openReport(target) {
  reportTarget = target;
  $('#report-form').reset();
  showError('#report-error', null);
  setTab('report');
}

/** 신고 칸: 무엇을 신고하는지와 사유. 의견과 게임은 고를 수 있는 사유가 다릅니다. */
function fillReport() {
  if (tab !== 'report' || !reportTarget) return;
  const c = reportTarget.comment;
  $('#report-what').textContent = c ? t('report.what.comment') : t('report.what.game', { name: nameOf(current) });
  $('#report-quote').textContent = c ? `${displayName(c.author)}: ${c.text}` : '';
  const chosen = document.querySelector('input[name=report-reason]:checked')?.value;
  $('#report-reasons').replaceChildren(...(c ? COMMENT_REASONS : GAME_REASONS).map((r) => {
    const label = document.createElement('label');
    label.className = 'pick';
    label.innerHTML = '<input type="radio" name="report-reason"> <span></span>';
    const input = label.querySelector('input');
    input.value = r;
    input.checked = r === chosen;
    label.querySelector('span').textContent = t(`report.reason.${r}`);
    return label;
  }));
}

async function sendReport(e) {
  e.preventDefault();
  const reason = document.querySelector('input[name=report-reason]:checked')?.value;
  if (!reason) return showError('#report-error', t('report.pick'));
  const c = reportTarget?.comment;
  const data = { game: current.id, reason, detail: $('#report-detail').value };
  if (c) data.comment = c.id;
  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true;
  const { ok, body } = await postJSON('/api/reports', data);
  button.disabled = false;
  if (!ok) {
    showError('#report-error', errorText(body.error));
    // 그 사이에 지워진 의견이면 목록에서도 뺍니다
    if (body.error === 'not found' && c && talk?.list?.includes(c)) {
      talk.list = talk.list.filter((x) => x !== c);
      talk.count--;
    }
    return;
  }
  if (c) {
    c.reported = true;
    if (body.hidden) c.hidden = true;
  }
  reportTarget = null;
  setTab('comments');
  talkNote = 'report.done';
  renderTalk();
}

function setupTalk() {
  // 의견 칸을 다시 누르면 소개로 돌아갑니다
  $('#gd-talk').addEventListener('click', () => setTab(tab === 'comments' || tab === 'report' ? 'about' : 'comments'));
  $('#comment-form').addEventListener('submit', postComment);
  $('#comment-text').addEventListener('input', () => {
    syncCommentLength();
    showError('#comment-error', null);
  });
  $('#report-game').addEventListener('click', () => openReport({ game: true }));
  $('#report-form').addEventListener('submit', sendReport);
  $('#report-form').addEventListener('change', () => showError('#report-error', null));
  $('#report-cancel').addEventListener('click', () => setTab('comments'));
}

// ---- 방 만들기 ----

const roomUrl = (entry, minutes) => `/web/match.html?game=${encodeURIComponent(entry.id)}&create=1&minutes=${minutes ?? 'none'}`;

/** 다른 게임을 열 때만 고르는 칸을 그 게임의 기본 타이머로 맞춥니다. */
function initCreate() {
  const timer = timerOfEntry(current);
  const on = timer.minutes !== null;
  for (const r of document.querySelectorAll('input[name=create-timer]')) r.checked = r.value === (on ? 'on' : 'none');
  $('#create-minutes').value = timer.minutes ?? 10;
}

/** 제작자가 커스텀 타이머를 허용했으면 시간을 고르고, 아니면 기본 타이머로 정해져 있다고 알려 줍니다. */
function fillCreate(entry) {
  const timer = timerOfEntry(entry);
  $('#create-picks').hidden = !timer.custom;
  $('#create-fixed').hidden = timer.custom;
  $('#create-fixed').textContent = t('detail.fixed', { timer: timerText(timer.minutes) });
  // 방은 계정만 만듭니다 (정지된 계정은 안 됨)
  $('#create-login').hidden = isMember(me);
  $('#create-submit').disabled = !isMember(me) || !!me.suspended;
  showSuspended('#create-suspended');
  syncCreateForm();
}

/** 정지된 계정이면 그 안내를 보여줍니다 */
function showSuspended(sel) {
  const text = suspendedText(me);
  $(sel).hidden = !text;
  $(sel).textContent = text;
}

function syncCreateForm() {
  const on = document.querySelector('input[name=create-timer]:checked')?.value === 'on';
  $('#create-minutes').disabled = !on;
}

function setupDialog() {
  const dlg = $('#game');
  // 방 만들기를 다시 누르거나 ‹를 누르면 소개로 돌아갑니다
  $('#gd-create').addEventListener('click', () => setTab(tab === 'create' ? 'about' : 'create'));
  $('#gd-back').addEventListener('click', () => setTab(tab === 'report' ? 'comments' : 'about'));
  for (const b of document.querySelectorAll('#gd-tabs [data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('#gd-star').addEventListener('click', (e) => current && toggleStar(current, e));
  // 창 바깥(어두운 곳)을 누르면 닫습니다
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
  dlg.addEventListener('close', () => {
    current = null;
    talk = null;
    reportTarget = null;
    syncUrl();
  });
  $('#rulebook-lang').addEventListener('change', (e) => pickRulebookLang(e.target.value));
  $('#create-form').addEventListener('change', syncCreateForm);
  $('#create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const timer = timerOfEntry(current);
    if (!timer.custom) {
      location.href = roomUrl(current, timer.minutes);
      return;
    }
    const on = document.querySelector('input[name=create-timer]:checked')?.value === 'on';
    const input = $('#create-minutes');
    // 범위는 input의 min/max로 브라우저가 먼저 막고, 서버도 다시 봅니다
    if (on && !input.reportValidity()) return;
    location.href = roomUrl(current, on ? Number(input.value) : null);
  });
}

/** 주소에 ?game=이 있으면 그 게임 창을 엽니다 (링크 공유, 새로고침). */
function openFromUrl() {
  const params = new URLSearchParams(location.search);
  const entry = entries?.find((e) => e.id === params.get('game') && !e.error);
  if (entry) openGame(entry, params.get('tab') ?? 'about');
}

// ---- 필터 ----

let entries = null;
let cards = new Map();
let loadError = null;
let me = null;
let addCard = null; // 목록 끝의 "내 게임 올리기" 칸 (언어가 바뀌면 다시 만듭니다)
let meReady = false; // loadMe를 마쳤는지 (게스트 안내를 그 뒤에만 보입니다)

function checked(name) {
  return [...document.querySelectorAll(`input[name=${name}]:checked`)].map((x) => x.value);
}

function apply() {
  if (!entries) return;
  const q = $('#q').value.trim().toLowerCase();
  const places = checked('places');
  const sizes = checked('size');
  const diffs = checked('difficulty');
  const langs = checked('support-lang');
  const onlyStarred = $('#only-starred').checked;
  const anyFilter = q || places.length || sizes.length || diffs.length || langs.length || onlyStarred;
  const sort = $('#sort').value;

  const shown = entries.filter((e) => {
    if (e.error) return !anyFilter;
    if (onlyStarred && !starred.has(e.id)) return false;
    const g = e.game;
    const l = e.listing;
    if (q && !searchText(e).includes(q)) return false;
    if (places.length && !places.includes(g.board.places === 'points' ? 'points' : 'cells')) return false;
    if (sizes.length && !sizes.includes(sizeClass(g.board))) return false;
    if (diffs.length && !diffs.includes(l?.difficulty)) return false;
    if (langs.length && !langs.some((x) => l?.languages?.[x])) return false;
    return true;
  });

  const plays = (e) => -(e.plays ?? 0); // 많이 둔 게임부터
  const stars = (e) => -(e.stars ?? 0); // 별을 많이 받은 게임부터
  // 최근에 처음 등록한 게임부터. 출시일이 없는 레포 게임은 뒤로
  const released = (e) => (e.released ? -Date.parse(e.released) : Infinity);
  const by = { plays, stars, released }[sort] ?? plays;
  const then = sort === 'stars' ? plays : () => 0; // 별 수가 같으면 많이 둔 게임부터
  // 그래도 같으면 이름순 (둘 다 Infinity면 NaN이라 이름으로 넘어갑니다)
  shown.sort((a, b) => by(a) - by(b) || then(a) - then(b) || nameOf(a).localeCompare(nameOf(b), lang));

  $('#grid').replaceChildren(...shown.map((e) => cards.get(e)), ...(addCard ? [addCard] : []));
  requestAnimationFrame(fitThumbs);
  $('#count').textContent = `${shown.length}`;
  $('#empty').hidden = shown.length > 0;
}

/**
 * 지원 언어 필터: 등록된 게임이 쓰는 언어만 보여줍니다 (LANGS를 다 늘어놓지 않도록).
 * 언어 이름은 그 언어로 씁니다 (한국어 / English). 룰북만 있는 언어도 그 언어를 지원하는 것으로 봅니다.
 */
function buildLangFilter() {
  const used = LANGS.filter((l) => entries?.some((e) => e.listing?.languages?.[l]));
  const box = $('#support-langs');
  for (const l of used) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" name="support-lang" value="${l}"> <span></span>`;
    label.querySelector('span').textContent = LANG_NAMES[l];
    label.querySelector('span').lang = l;
    label.querySelector('input').addEventListener('change', apply);
    box.append(label);
  }
  box.hidden = !used.length;
}

function setupFilters() {
  $('#q').addEventListener('input', apply);
  $('#sort').addEventListener('change', apply);
  for (const box of document.querySelectorAll('.filters input[type=checkbox]')) box.addEventListener('change', apply);
  $('#reset').addEventListener('click', () => {
    $('#q').value = '';
    for (const box of document.querySelectorAll('.filters input[type=checkbox]')) box.checked = false;
    apply();
  });
  setupLangButtons(render);
}

/** 지금 언어로 화면 전체를 다시 그립니다. 필터와 검색어는 그대로 둡니다. */
function render() {
  applyStatic();
  renderMe(me);
  $('#sdk-docs').href = sdkDocs();
  // 별 단 게임만 보기는 계정만 (게스트는 별을 달 수 없음)
  $('#only-starred').disabled = !isMember(me);
  if (!isMember(me)) $('#only-starred').checked = false;
  $('#starred-login').hidden = isMember(me) || !meReady; // 신원을 받기 전에는 안내를 띄우지 않습니다
  if (loadError) {
    $('#empty').hidden = false;
    $('#empty').textContent = t('load.failed', { msg: loadError });
    return;
  }
  if (entries) cards = new Map(entries.map((e) => [e, renderCard(e)]));
  addCard = renderAddCard();
  apply();
  if (current) fillDialog();
}

setupFilters();
setupDialog();
setupTalk();
setLang(await detectLang());
render();
me = await loadMe();
meReady = true;
const myStars = loadStars();
try {
  entries = await loadGames();
} catch (e) {
  loadError = e.message;
}
starred = await myStars;
buildLangFilter();
render();
openFromUrl();
