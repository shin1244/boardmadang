// 로비: 게임 목록, 이벤트 배너, 필터.
// 이름, 소개, 룰북, 난이도, 지원 언어, 타이머는 등록 정보(listing)에서, 보드 모양은 게임 모듈에서 읽어 옵니다.
// 썸네일은 게임의 setup()이 만든 시작 화면을 플랫폼 렌더러로 그린 것입니다.

import { BoardView } from '/sdk/playground/board.js';
import { DIFFICULTIES, LANGS, LANG_NAMES, NO_TIMER, fullLangs, gameLang, localize, timerOf } from '/sdk/playground/listing.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { displayName, isMember, loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);

const BANNERS = [
  { key: 'banner.make', cta: '/sdk/playground/', tone: 'tone-a' },
  { key: 'banner.soon', tone: 'tone-b' },
];

// ---- 배너 ----

let showBanner = () => {};
let bannerIndex = 0;

function setupBanner() {
  let timer = null;

  showBanner = (i) => {
    bannerIndex = i;
    [...$('#slides').children].forEach((s, j) => { s.hidden = j !== i; });
    [...$('#dots').children].forEach((d, j) => d.setAttribute('aria-selected', String(j === i)));
  };

  function restart() {
    clearInterval(timer);
    if (BANNERS.length < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    timer = setInterval(() => showBanner((bannerIndex + 1) % BANNERS.length), 6000);
  }

  $('#dots').addEventListener('click', (e) => {
    const i = [...$('#dots').children].indexOf(e.target);
    if (i < 0) return;
    showBanner(i);
    restart();
  });
  const banner = $('.banner');
  banner.addEventListener('mouseenter', () => clearInterval(timer));
  banner.addEventListener('mouseleave', restart);
  restart();
}

/** 지금 언어로 슬라이드를 다시 만듭니다. 보던 슬라이드는 그대로 둡니다. */
function renderBanner() {
  const slides = BANNERS.map((b) => {
    const s = document.createElement('div');
    s.className = `slide ${b.tone}`;
    s.innerHTML = `<div class="slide-text"><h2></h2><p></p></div>`;
    s.querySelector('h2').textContent = t(`${b.key}.title`);
    s.querySelector('p').textContent = t(`${b.key}.body`);
    if (b.cta) {
      const a = document.createElement('a');
      a.className = 'cta';
      a.href = b.cta;
      a.textContent = t(`${b.key}.cta`);
      s.append(a);
    }
    return s;
  });
  const dots = BANNERS.map((_, i) => {
    const d = document.createElement('button');
    d.type = 'button';
    d.setAttribute('role', 'tab');
    d.setAttribute('aria-label', t('banner.n', { n: i + 1 }));
    return d;
  });
  $('#slides').replaceChildren(...slides);
  $('#dots').replaceChildren(...dots);
  showBanner(bannerIndex);
}

// ---- 게임 목록 ----

/** 썸네일에 쓸 고정 시드. 랜덤이 있는 게임도 매번 같은 그림이 나옵니다. */
function fixedRng() {
  let a = 1;
  const next = () => {
    a = (a * 1103515245 + 12345) % 2 ** 31;
    return a / 2 ** 31;
  };
  return { next, int: (n) => Math.floor(next() * n) };
}

function sizeClass(board) {
  const n = Math.max(board.rows, board.cols);
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

async function loadGames() {
  const res = await fetch('/api/games');
  const list = await res.json();
  return Promise.all(list.map(async (entry) => {
    try {
      const game = (await import(entry.module)).default;
      return { ...entry, game };
    } catch (e) {
      return { ...entry, error: e.message };
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

/** 판, 난이도, 타이머, 언어 태그 [글, class, title]. 카드와 게임 창에서 같이 씁니다. */
function tagsOf(entry) {
  const { game, listing } = entry;
  const tags = [
    [`${game.board.rows}×${game.board.cols}`],
    [t(game.board.places === 'points' ? 'tag.points' : 'tag.cells')],
    [t('tag.players')],
  ];
  if (listing) {
    tags.push([t('tag.difficulty', { d: t(`difficulty.${listing.difficulty}`) }), `diff-${listing.difficulty}`]);
    const timer = timerOfEntry(entry);
    tags.push([`⏱ ${timerText(timer.minutes)}`, timer.custom ? 'timer-tag custom' : 'timer-tag', timer.custom ? t('tag.timer.custom') : '']);
    // 완전 번역 언어는 한데 묶고(KO · EN), 일부 번역 언어는 따로 점선 태그로
    const full = fullLangs(listing);
    tags.push([full.map((l) => l.toUpperCase()).join(' · '), 'lang-tag full', full.map((l) => t('tag.lang.full', { lang: LANG_NAMES[l] })).join(', ')]);
    for (const l of LANGS.filter((x) => listing.languages[x] === 'rulebook')) {
      tags.push([t('tag.rulebookOnly', { code: l.toUpperCase() }), 'lang-tag', t('tag.lang.rulebook', { lang: LANG_NAMES[l] })]);
    }
  }
  if (game.specialActions?.length) tags.push([t('tag.special', { n: game.specialActions.length })]);
  return tags;
}

function fillTags(ul, entry) {
  ul.replaceChildren(...tagsOf(entry).map(([text, cls, title]) => {
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    if (title) li.title = title;
    return li;
  }));
}

/** 시작 화면 그림. 그리지 못하면 false */
function drawThumb(canvas, entry, size) {
  const { game } = entry;
  try {
    const board = new BoardView(canvas, game.board, game.pieces);
    board.resize(size);
    const view = game.view(game.setup(fixedRng()), 0, gameLang(entry.listing, lang));
    board.draw({ ...view, marks: (view.marks ?? []).filter((m) => m.type !== 'last-move') });
    return true;
  } catch {
    return false;
  }
}

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

/** 카드: 그림, 이름, 짧은 소개, 태그만. 누르면 게임 창이 뜹니다. */
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
  card.innerHTML = `
    <div class="thumb"><canvas></canvas></div>
    <div class="card-body">
      <h3><button type="button" class="card-open"></button></h3>
      <p class="desc"></p>
      <ul class="tags"></ul>
    </div>`;
  const open = card.querySelector('.card-open');
  open.textContent = name;
  open.setAttribute('aria-label', t('detail.open', { name }));
  open.addEventListener('click', () => openGame(entry));
  addBadges(card.querySelector('h3'), entry);
  fillDescription(card.querySelector('.desc'), entry);
  fillTags(card.querySelector('.tags'), entry);
  if (!drawThumb(card.querySelector('canvas'), entry, 168)) card.querySelector('.thumb').classList.add('no-thumb');
  return card;
}

// ---- 게임 창 ----
// 왼쪽: 그림, 이름, 대전 찾기, 방 만들기, 혼자 둬보기, 그리고 남은 자리를 채우는 의견 칸.
// 오른쪽: 소개 (방 만들기를 누르면 방 만들기, 의견 칸을 누르면 의견, 의견이나 게임을 신고하면 신고).
// 열려 있는 동안 주소에 ?game=<id>&tab=<메뉴>를 붙여 두므로 링크로 바로 열 수 있습니다.

const TABS = { about: 'detail.about', create: 'card.createRoom', comments: 'comments.title', report: 'report.title' };
let current = null; // 창에 띄운 게임
let tab = 'about';

function openGame(entry, startTab = 'about') {
  current = entry;
  tab = startTab in TABS ? startTab : 'about';
  if (tab === 'report') tab = 'comments'; // 무엇을 신고할지는 주소에 남기지 않습니다
  reportTarget = null;
  talkNote = '';
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
  const meta = [`${game.board.rows}×${game.board.cols}`, t('tag.players')];
  if (listing) meta.push(t('tag.difficulty', { d: t(`difficulty.${listing.difficulty}`) }));
  $('#gd-meta').textContent = meta.join(' · ');
  $('#gd-match').href = `/web/match.html?game=${id}`;
  $('#gd-try').href = `/sdk/playground/?game=${id}&lang=${gameLang(listing, lang)}`;
  $('#gd-create').setAttribute('aria-pressed', String(tab === 'create'));

  // 오른쪽
  $('#gd-title').textContent = t(TABS[tab]);
  const back = $('#gd-back');
  back.hidden = tab === 'about';
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

function fillAbout(entry) {
  const { listing } = entry;
  fillDescription($('#gd-desc'), entry);
  $('#gd-register').hidden = !!listing;
  $('#gd-register').href = `/web/register.html?game=${encodeURIComponent(entry.id)}`;
  fillTags($('#gd-tags'), entry);
  const timer = timerOfEntry(entry);
  $('#gd-timer').textContent = timer.custom
    ? `${timerText(timer.minutes)} · ${t('detail.timer.custom')}`
    : timerText(timer.minutes);
  $('#gd-langs-row').hidden = !listing;
  if (listing) {
    const levels = [...fullLangs(listing).map((l) => t('tag.lang.full', { lang: LANG_NAMES[l] })),
      ...LANGS.filter((l) => listing.languages[l] === 'rulebook').map((l) => t('tag.lang.rulebook', { lang: LANG_NAMES[l] }))];
    $('#gd-langs').textContent = levels.join(', ');
  }
}

function fillRulebook(entry) {
  const { listing } = entry;
  const field = $('#gd-rulebook');
  const text = field.querySelector('.rulebook-text');
  field.hidden = !listing; // 등록 전이면 룰북이 없습니다
  if (!listing) {
    text.replaceChildren();
    return;
  }
  const book = localize(listing.rulebook, lang);
  const notes = [];
  if (book.lang !== lang) notes.push(t('rulebook.fallback', { ui: LANG_NAMES[lang], lang: LANG_NAMES[book.lang] }));
  notes.push(t('rulebook.ingame', { lang: LANG_NAMES[gameLang(listing, lang)] }));
  field.querySelector('.rulebook-notes').textContent = notes.join(' ');

  // 빈 줄로 문단을 나눕니다. 글은 textContent로만 넣습니다 (제작자가 쓴 글을 HTML로 해석하지 않음).
  text.lang = book.lang;
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

  // 의견은 계정만 남깁니다. 게스트에게는 남기는 칸 대신 로그인 안내를 보여줍니다
  $('#comment-form').hidden = !isMember(me);
  $('#comment-login').hidden = isMember(me);
  $('.comments-foot').hidden = !isMember(me); // 게임 신고도 계정만
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
  } else if (!c.hidden && isMember(me)) { // 신고는 계정만
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
  // 방은 계정만 만듭니다
  $('#create-login').hidden = isMember(me);
  $('#create-submit').disabled = !isMember(me);
  syncCreateForm();
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
  const fullOnly = $('#full-only').checked;
  $('#full-only').disabled = !langs.length;
  const anyFilter = q || places.length || sizes.length || diffs.length || langs.length;
  const sort = $('#sort').value;

  const shown = entries.filter((e) => {
    if (e.error) return !anyFilter;
    const g = e.game;
    const l = e.listing;
    if (q && !searchText(e).includes(q)) return false;
    if (places.length && !places.includes(g.board.places === 'points' ? 'points' : 'cells')) return false;
    if (sizes.length && !sizes.includes(sizeClass(g.board))) return false;
    if (diffs.length && !diffs.includes(l?.difficulty)) return false;
    if (langs.length && !langs.some((x) => (fullOnly ? l?.languages[x] === 'full' : l?.languages[x]))) return false;
    return true;
  });

  const area = (e) => (e.game ? e.game.board.rows * e.game.board.cols : Infinity);
  // 난이도가 없는(등록 전) 게임은 뒤로
  const level = (e) => { const i = DIFFICULTIES.indexOf(e.listing?.difficulty); return i < 0 ? Infinity : i; };
  const by = { size: area, difficulty: level }[sort];
  shown.sort((a, b) => (by ? by(a) - by(b) || 0 : 0) || nameOf(a).localeCompare(nameOf(b), lang));

  $('#grid').replaceChildren(...shown.map((e) => cards.get(e)));
  $('#count').textContent = `${shown.length}`;
  $('#empty').hidden = shown.length > 0;
}

/**
 * 지원 언어 필터: 등록된 게임이 쓰는 언어만 보여줍니다 (LANGS를 다 늘어놓지 않도록).
 * 언어 이름은 그 언어로 씁니다 (한국어 / English). '게임 안 글자까지 번역된 것만'은 맨 아래에 둡니다.
 */
function buildLangFilter() {
  const used = LANGS.filter((l) => entries?.some((e) => e.listing?.languages?.[l]));
  const fullOnly = $('#full-only').closest('label');
  for (const l of used) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" name="support-lang" value="${l}"> <span></span>`;
    label.querySelector('span').textContent = LANG_NAMES[l];
    label.querySelector('span').lang = l;
    label.querySelector('input').addEventListener('change', apply);
    fullOnly.before(label);
  }
  $('#support-langs').hidden = !used.length;
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
  renderBanner();
  if (loadError) {
    $('#empty').hidden = false;
    $('#empty').textContent = t('load.failed', { msg: loadError });
    return;
  }
  if (entries) cards = new Map(entries.map((e) => [e, renderCard(e)]));
  apply();
  if (current) fillDialog();
}

setupBanner();
setupFilters();
setupDialog();
setupTalk();
setLang(await detectLang());
render();
me = await loadMe();
try {
  entries = await loadGames();
} catch (e) {
  loadError = e.message;
}
buildLangFilter();
render();
openFromUrl();
