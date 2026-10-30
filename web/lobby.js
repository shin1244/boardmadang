// 로비: 게임 목록, 이벤트 배너, 필터.
// 이름, 소개, 룰북, 난이도, 지원 언어는 등록 정보(listing)에서, 보드 모양은 게임 모듈에서 읽어 옵니다.
// 썸네일은 게임의 setup()이 만든 시작 화면을 플랫폼 렌더러로 그린 것입니다.

import { BoardView } from '/sdk/playground/board.js';
import { DIFFICULTIES, LANGS, LANG_NAMES, fullLangs, gameLang, localize } from '/sdk/playground/listing.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { loadMe, renderMe } from './me.js';

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

function addBadge(card, text, title, cls = '') {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  if (title) b.title = title;
  card.querySelector('h3').append(b);
}

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

  const { game, listing } = entry;
  const name = nameOf(entry);
  const playLang = gameLang(listing, lang);
  const play = `/sdk/playground/?game=${encodeURIComponent(entry.id)}&lang=${playLang}`;
  card.innerHTML = `
    <a class="thumb" href="${play}"><canvas></canvas></a>
    <div class="card-body">
      <h3><span class="name"></span></h3>
      <p class="desc"></p>
      <ul class="tags"></ul>
    </div>
    <div class="card-actions">
      <a class="btn" href="${play}"></a>
    </div>`;
  card.querySelector('.thumb').setAttribute('aria-label', t('card.try.label', { name }));
  card.querySelector('.name').textContent = name;
  card.querySelector('.btn').textContent = t('card.try');
  if (entry.private) addBadge(card, t('card.private'), t('card.private.title'));

  const actions = card.querySelector('.card-actions');
  const p = card.querySelector('.desc');
  if (!listing) {
    // 등록 정보가 없는 게임. 실제 사이트에서는 목록에 나오지 않고, 개발 서버에서만 보입니다.
    addBadge(card, t('card.unregistered'), null, 'warn');
    p.textContent = t('card.unregistered.desc');
    const reg = document.createElement('a');
    reg.className = 'btn ghost';
    reg.href = `/web/register.html?game=${encodeURIComponent(entry.id)}`;
    reg.textContent = t('card.register');
    actions.append(reg);
  } else {
    // 화면 언어로 쓴 소개가 없으면 다른 언어 소개를 보여주고, 읽기 프로그램을 위해 lang을 붙입니다.
    const desc = localize(listing.description, lang);
    p.textContent = desc.text;
    if (desc.lang !== lang) p.lang = desc.lang;

    const rb = document.createElement('button');
    rb.type = 'button';
    rb.className = 'btn ghost';
    rb.textContent = t('card.rulebook');
    rb.addEventListener('click', () => openRulebook(entry));
    actions.append(rb);
  }
  const match = document.createElement('a');
  match.className = 'btn ghost';
  match.href = `/web/match.html?game=${encodeURIComponent(entry.id)}`;
  match.textContent = t('card.match');
  actions.append(match);

  const tags = [
    [`${game.board.rows}×${game.board.cols}`],
    [t(game.board.places === 'points' ? 'tag.points' : 'tag.cells')],
    [t('tag.players')],
  ];
  if (listing) {
    tags.push([t('tag.difficulty', { d: t(`difficulty.${listing.difficulty}`) }), `diff-${listing.difficulty}`]);
    // 완전 번역 언어는 한데 묶고(KO · EN), 일부 번역 언어는 따로 점선 태그로
    const full = fullLangs(listing);
    tags.push([full.map((l) => l.toUpperCase()).join(' · '), 'lang-tag full', full.map((l) => t('tag.lang.full', { lang: LANG_NAMES[l] })).join(', ')]);
    for (const l of LANGS.filter((x) => listing.languages[x] === 'rulebook')) {
      tags.push([t('tag.rulebookOnly', { code: l.toUpperCase() }), 'lang-tag', t('tag.lang.rulebook', { lang: LANG_NAMES[l] })]);
    }
  }
  if (game.specialActions?.length) tags.push([t('tag.special', { n: game.specialActions.length })]);
  for (const [text, cls, title] of tags) {
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    if (title) li.title = title;
    card.querySelector('.tags').append(li);
  }

  // 시작 화면 썸네일
  try {
    const board = new BoardView(card.querySelector('canvas'), game.board, game.pieces);
    board.resize(168);
    const view = game.view(game.setup(fixedRng()), 0, playLang);
    board.draw({ ...view, marks: (view.marks ?? []).filter((m) => m.type !== 'last-move') });
  } catch {
    card.querySelector('.thumb').classList.add('no-thumb');
  }
  return card;
}

// ---- 룰북 ----

function openRulebook(entry) {
  const { listing } = entry;
  const dlg = $('#rulebook');
  const book = localize(listing.rulebook, lang);
  $('#rulebook-title').textContent = t('rulebook.title', { name: nameOf(entry) });

  const notes = [];
  if (book.lang !== lang) notes.push(t('rulebook.fallback', { ui: LANG_NAMES[lang], lang: LANG_NAMES[book.lang] }));
  notes.push(t('rulebook.ingame', { lang: LANG_NAMES[gameLang(listing, lang)] }));
  dlg.querySelector('.rulebook-notes').textContent = notes.join(' ');

  // 빈 줄로 문단을 나눕니다. 글은 textContent로만 넣습니다 (제작자가 쓴 글을 HTML로 해석하지 않음).
  const text = dlg.querySelector('.rulebook-text');
  text.lang = book.lang;
  text.replaceChildren(...book.text.split(/\n\s*\n/).map((para) => {
    const el = document.createElement('p');
    el.textContent = para.trim();
    return el;
  }));
  dlg.showModal();
  text.scrollTop = 0;
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
}

setupBanner();
setupFilters();
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
