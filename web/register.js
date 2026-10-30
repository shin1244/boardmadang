// 게임 등록창: 두 단계로 나눕니다.
//   1단계: 게임, 난이도, 타이머, 지원 언어 (일부 번역 / 완전 번역으로 나눠 언어를 고릅니다)
//   2단계: 고른 언어마다 이름, 소개, 룰북
// 게임 코드에는 규칙만 두고 이 정보는 플랫폼이 따로 저장하므로, 코드를 다시 올리지 않아도 고칠 수 있습니다.
// 개발 서버에서는 PUT /api/games/<id>/listing 으로 games/<id>/listing.json 에 저장합니다.

import { LANGS, LANG_NAMES, LIMITS, NO_TIMER, TIMER_MINUTES, isRtl, localize, validateListing } from '/sdk/playground/listing.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { loadGame } from './engine.js';
import { isMember, loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);
const TEXT_FIELDS = ['name', 'description', 'rulebook'];
/** 타이머를 정한 적 없는 게임에 처음 보여주는 값 */
const DEFAULT_TIMER = { minutes: 10, custom: true };

let me = null;
let games = [];
let current = null;
let step = 1;
/** 언어 → 'full' | 'rulebook'. 없으면 지원 안 함 */
let support = new Map();
/** 언어별로 쓴 글. 언어를 뺐다가 다시 넣어도 쓴 글이 돌아오도록 지우지 않습니다. */
let texts = { name: {}, description: {}, rulebook: {} };
let problems = [];
/** @type {{ kind: 'saving' | 'saved' | 'failed', msg?: string } | null} */
let saveState = null;
let dirty = false;
/** 고른 게임 코드에 turn()이 있는지. 불러오는 중이면 null */
let hasTurn = null;

// ---- 1단계: 언어 고르기 ----

function buildChips() {
  for (const box of document.querySelectorAll('.chips')) {
    const level = box.dataset.level;
    box.replaceChildren(...LANGS.map((l) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.lang = l;
      b.lang = l;
      b.addEventListener('click', () => toggle(l, level));
      return b;
    }));
  }
}

/** 같은 쪽을 다시 누르면 빼고, 다른 쪽에 있던 언어면 이쪽으로 옮깁니다. */
function toggle(l, level) {
  if (support.get(l) === level) support.delete(l);
  else support.set(l, level);
  changed();
  renderChips();
}

function renderChips() {
  for (const b of document.querySelectorAll('.chip')) {
    const l = b.dataset.lang;
    const on = support.get(l) === b.closest('.chips').dataset.level;
    b.setAttribute('aria-pressed', String(on));
    // 다른 쪽에서 고른 언어는 흐리게 (누르면 이쪽으로 옮겨집니다)
    b.classList.toggle('elsewhere', support.has(l) && !on);
    b.textContent = `${on ? '✓' : '+'} ${LANG_NAMES[l]}`;
  }
}

// ---- 2단계: 언어별 글 ----

/** 고른 언어만 입력칸을 만듭니다. 완전 번역 언어를 먼저 둡니다. */
function renderTexts() {
  const tpl = $('#text-block');
  const chosen = [...LANGS.filter((l) => support.get(l) === 'full'), ...LANGS.filter((l) => support.get(l) === 'rulebook')];
  $('#texts').replaceChildren(...chosen.map((l) => {
    const block = tpl.content.firstElementChild.cloneNode(true);
    block.dataset.lang = l;
    block.dataset.support = support.get(l);
    const name = block.querySelector('.lang-name');
    name.textContent = LANG_NAMES[l];
    name.lang = l;
    block.querySelector('.level-tag').textContent = t(`support.${support.get(l)}`);
    for (const el of block.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of block.querySelectorAll('[data-field]')) {
      const field = el.dataset.field;
      el.maxLength = LIMITS[field];
      el.lang = l; // 맞춤법 검사를 그 언어로
      if (isRtl(l)) el.dir = 'rtl';
      el.value = texts[field][l] ?? '';
      updateCounter(el);
      el.addEventListener('input', () => {
        texts[field][l] = el.value;
        updateCounter(el);
        changed();
      });
    }
    return block;
  }));
}

function updateCounter(el) {
  el.closest('label').querySelector('.counter').textContent = `${el.value.length} / ${LIMITS[el.dataset.field]}`;
}

function changed() {
  dirty = true;
  if (saveState?.kind === 'saved') {
    saveState = null;
    renderStatus();
  }
}

// ---- 타이머 ----

function fillTimer(timer) {
  const on = timer.minutes !== null;
  for (const r of document.querySelectorAll('input[name=timer]')) r.checked = r.value === (on ? 'on' : 'none');
  $('#timer-minutes').value = on ? timer.minutes : DEFAULT_TIMER.minutes;
  $('#timer-custom').checked = timer.custom;
}

function readTimer() {
  // turn()이 없는 게임은 타이머를 쓸 수 없습니다 (불러오는 중이면 고른 대로 둡니다. 서버가 다시 검사합니다)
  if (hasTurn === false) return { ...NO_TIMER };
  const on = document.querySelector('input[name=timer]:checked')?.value === 'on';
  const raw = $('#timer-minutes').value.trim();
  return {
    minutes: on ? (/^\d+$/.test(raw) ? Number(raw) : NaN) : null,
    custom: $('#timer-custom').checked,
  };
}

function renderTimer() {
  const blocked = hasTurn === false;
  const on = document.querySelector('input[name=timer]:checked')?.value === 'on';
  for (const el of document.querySelectorAll('#timer input')) el.disabled = blocked;
  $('#timer-minutes').disabled = blocked || !on;
  $('#timer-minutes').min = TIMER_MINUTES.min;
  $('#timer-minutes').max = TIMER_MINUTES.max;
  const line = $('#timer-status');
  line.className = 'status-line';
  line.textContent = blocked ? t('register.timer.noTurn') : '';
}

/**
 * 게임 코드에 turn()이 있는지 봅니다. 코드는 실행기(engine.js)의 샌드박스에서만 불러옵니다.
 * 그사이 다른 게임을 고르면 결과를 버립니다.
 */
async function checkTurn(entry) {
  hasTurn = null;
  let found = false;
  let runner = null;
  try {
    runner = await loadGame(entry);
    found = runner.info.turn;
  } catch {
    // 코드가 깨졌으면 npx boardmadang check가 알려 줍니다. 여기서는 타이머만 막습니다.
  } finally {
    runner?.close();
  }
  if (current !== entry) return;
  hasTurn = found;
  renderTimer();
}

// ---- 폼 ↔ 등록 정보 ----

function fill(listing) {
  for (const r of document.querySelectorAll('input[name=difficulty]')) r.checked = r.value === listing?.difficulty;
  fillTimer(listing?.timer ?? DEFAULT_TIMER);
  support = new Map(Object.entries(listing?.languages ?? {}).filter(([l]) => LANGS.includes(l)));
  texts = { name: {}, description: {}, rulebook: {} };
  for (const field of TEXT_FIELDS) Object.assign(texts[field], listing?.[field]);
  problems = [];
  saveState = null;
  dirty = false;
  step = 1;
}

/** 지원하는 언어의 글만 담습니다. */
function readForm() {
  const listing = {
    languages: {},
    difficulty: document.querySelector('input[name=difficulty]:checked')?.value ?? null,
    timer: readTimer(),
    name: {},
    description: {},
    rulebook: {},
  };
  for (const l of LANGS) {
    if (!support.has(l)) continue;
    listing.languages[l] = support.get(l);
    for (const field of TEXT_FIELDS) listing[field][l] = texts[field][l] ?? '';
  }
  return listing;
}

/** 1단계에서 고칠 문제인지 (난이도, 타이머, 지원 언어) */
const isStep1Problem = (p) => ['languages.', 'difficulty.', 'timer.'].some((s) => p.code.startsWith(s));

// ---- 화면 ----

function problemText(p) {
  return t(`problem.${p.code}`, {
    lang: LANG_NAMES[p.lang] ?? '',
    field: p.field ? t(`field.${p.field}`) : '',
    min: p.min,
    max: p.max,
  });
}

function renderProblems() {
  const box = $('#problems');
  box.hidden = !problems.length;
  box.querySelector('ul').replaceChildren(...problems.map((p) => {
    const li = document.createElement('li');
    li.textContent = problemText(p);
    return li;
  }));
  // 문제가 있는 칸 표시
  for (const el of document.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
  for (const p of problems) {
    if (p.code === 'difficulty.invalid') $('#difficulty').setAttribute('aria-invalid', 'true');
    if (p.code.startsWith('timer.')) $('#timer').setAttribute('aria-invalid', 'true');
    if (p.code.startsWith('languages.')) $('#langs').setAttribute('aria-invalid', 'true');
    if (p.field) {
      document.querySelector(`.text-block[data-lang="${p.lang}"] [data-field="${p.field}"]`)?.setAttribute('aria-invalid', 'true');
    }
  }
}

function renderStep() {
  $('#step-1').hidden = step !== 1;
  $('#step-2').hidden = step !== 2;
  for (const li of document.querySelectorAll('.steps li')) {
    const n = Number(li.dataset.step);
    li.classList.toggle('done', n < step);
    if (n === step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

function renderStatus() {
  const s = $('#save-status');
  s.replaceChildren();
  s.className = 'status-line';
  $('#save').disabled = saveState?.kind === 'saving';
  if (!saveState) return;
  if (saveState.kind === 'saving') {
    s.textContent = t('register.saving');
  } else if (saveState.kind === 'failed') {
    s.textContent = t('register.failed', { msg: saveState.msg });
    s.classList.add('bad');
  } else {
    s.classList.add('good');
    const a = document.createElement('a');
    a.href = '/web/';
    a.textContent = t('register.toLobby');
    s.append(`${t('register.saved')} `, a);
  }
}

function renderGame() {
  const select = $('#game');
  for (const o of select.options) {
    const g = games.find((x) => x.id === o.value);
    const name = localize(g.listing?.name, lang).text;
    o.textContent = name ? `${name} (${g.id})` : g.id;
  }
  const line = $('#game-status');
  line.className = 'status-line';
  if (!current) {
    line.textContent = t('register.noGames');
    return;
  }
  if (current.listingError) line.textContent = t('register.status.broken', { msg: current.listingError });
  else line.textContent = t(current.listing ? 'register.status.saved' : 'register.status.new');
}

function render() {
  applyStatic('register.title');
  renderMe(me);
  // 게스트는 업로드할 수 없습니다. 서버도 저장 요청을 403으로 막습니다.
  $('#need-account').hidden = !me || isMember(me);
  $('#member-only').hidden = !isMember(me);
  renderGame();
  renderTimer();
  renderChips();
  if (step === 2) renderTexts();
  renderStep();
  renderProblems();
  renderStatus();
}

// ---- 동작 ----

function choose(id) {
  current = games.find((g) => g.id === id) ?? games[0] ?? null;
  if (!current) return;
  $('#game').value = current.id;
  history.replaceState(null, '', `?game=${encodeURIComponent(current.id)}`);
  fill(current.listing);
  render();
  checkTurn(current);
}

function goStep(n) {
  step = n;
  problems = [];
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 1단계 문제만 검사하고 넘어갑니다. 글 칸은 2단계에서 검사합니다. */
function next() {
  if (!current) return;
  problems = validateListing(readForm()).filter(isStep1Problem);
  if (problems.length) {
    render();
    $('#problems').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  goStep(2);
}

async function save(e) {
  e.preventDefault();
  if (!current || step !== 2) return;
  const listing = readForm();
  problems = validateListing(listing);
  if (problems.length) {
    saveState = null;
    // 언어나 난이도가 문제면 1단계로 돌아갑니다
    if (problems.some(isStep1Problem)) step = 1;
    render();
    $('#problems').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  saveState = { kind: 'saving' };
  render();
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(current.id)}/listing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(listing),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 422) {
      problems = body.problems ?? [];
      if (problems.some(isStep1Problem)) step = 1;
      saveState = null;
    } else if (res.status === 403 && body.error === 'member only') {
      saveState = { kind: 'failed', msg: t('register.memberOnly') };
    } else if (!res.ok) {
      saveState = { kind: 'failed', msg: body.error ?? res.status };
    } else {
      current.listing = body.listing;
      delete current.listingError;
      saveState = { kind: 'saved' };
      dirty = false;
    }
  } catch (err) {
    saveState = { kind: 'failed', msg: err.message };
  }
  render();
}

async function main() {
  buildChips();
  setupLangButtons(render);
  setLang(await detectLang());
  me = await loadMe();
  render();
  if (!isMember(me)) return;

  games = await (await fetch('/api/games')).json();
  $('#game').replaceChildren(...games.map((g) => new Option(g.id, g.id)));
  $('#game').addEventListener('change', (e) => {
    if (dirty && !confirm(t('register.discard'))) {
      e.target.value = current.id;
      return;
    }
    choose(e.target.value);
  });
  $('#form').addEventListener('change', (e) => {
    if (e.target.name === 'difficulty' || e.target.closest('#timer')) changed();
    if (e.target.name === 'timer') renderTimer();
  });
  $('#timer-minutes').addEventListener('input', changed);
  $('#next').addEventListener('click', next);
  $('#back').addEventListener('click', () => goStep(1));
  $('#form').addEventListener('submit', save);
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  choose(new URLSearchParams(location.search).get('game'));
  if (!current) render();
}

main().catch((err) => {
  saveState = { kind: 'failed', msg: err.message };
  renderStatus();
});
