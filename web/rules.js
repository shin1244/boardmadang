// 대국 화면의 규칙 카드 (AI와 두기, 온라인 대전).
// 규칙 버튼을 누르면 뜨고, 빠른 규칙(등록 정보의 quickRules)이 있는 게임은 이 브라우저에서 처음 들어올 때 한 번 저절로 뜹니다.
//   - 빠른 규칙이 없으면 룰북을 바로 보여줍니다.
//   - 빠른 규칙만 있으면 번호 붙은 목록으로, 그 아래에 "룰북 전체 보기"를 접어 둡니다.
//   - 시연(demos)이 하나라도 있으면 한 장에 규칙 하나씩 넘겨 보고, 시연이 있는 장은 실제 판이 그 수순을 되풀이합니다.
// 시연은 대국과 다른 실행기(Worker)에서 한 번 둬서 화면만 받아 둡니다 (demo.js). 두고 있는 판에는 손대지 않습니다.

import { LANG_NAMES, gameLang, isRtl, localize, quickRuleLines } from '/sdk/playground/listing.js';
import { DemoLoop, demoFrames } from './demo.js';
import { loadGame } from './engine.js';
import { lang, t } from './i18n.js';

const SEEN_KEY = 'boardmadang.rulesSeen.'; // + 게임 id
const DEMO_PX = 300;

function seen(id) {
  try {
    return localStorage.getItem(SEEN_KEY + id) === '1';
  } catch {
    return true; // 저장소를 못 쓰는 브라우저에서는 들어올 때마다 뜨지 않게 합니다
  }
}

function markSeen(id) {
  try {
    localStorage.setItem(SEEN_KEY + id, '1');
  } catch { /* 저장 못 하면 다음에 한 번 더 뜹니다 */ }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** 룰북 문단들. 로비의 룰북처럼 빈 줄로 나눕니다 */
function paragraphs(book) {
  const box = el('div', 'rulebook-text');
  if (book.lang) {
    box.lang = book.lang;
    if (isRtl(book.lang)) box.dir = 'rtl';
  }
  for (const p of book.text.split(/\n\s*\n/)) if (p.trim()) box.append(el('p', '', p.trim()));
  return box;
}

/**
 * 규칙 버튼과 카드를 붙입니다. 등록 정보가 없는 게임(룰북 없음)이면 버튼을 숨겨 둡니다.
 * @param {{ id: string, module: string, listing?: object }} entry /api/games의 항목
 * @param {HTMLButtonElement} opener
 */
export function setupRules(entry, opener) {
  const listing = entry?.listing;
  if (!listing || !localize(listing.rulebook, lang).text) return;

  const dialog = el('dialog', 'rules-card');
  document.body.append(dialog);
  const demos = Array.isArray(listing.demos) ? listing.demos : [];
  const hasDemos = demos.some(Boolean);

  // 시연의 화면들: 처음 열 때 한 번, 그 뒤로는 게임 언어가 바뀌었을 때만 다시 받습니다
  let shots = null; // { lang, info, frames: (object[] | null)[] }
  let loading = null;
  let loop = null; // 지금 장에서 돌고 있는 시연
  let page = 0;

  function loadShots() {
    const want = gameLang(listing, lang);
    if (shots?.lang === want || loading?.lang === want) return;
    const job = { lang: want };
    loading = job;
    (async () => {
      const runner = await loadGame(entry);
      try {
        const frames = [];
        for (const d of demos) frames.push(d ? await demoFrames(runner, d, want).catch(() => null) : null);
        if (loading === job) shots = { lang: want, info: runner.info, frames };
      } finally {
        runner.close();
      }
    })().catch(() => {
      // 시연을 못 받아도 글은 그대로 보입니다
      if (loading === job) shots = { lang: want, info: null, frames: [] };
    }).finally(() => {
      if (loading !== job) return;
      loading = null;
      if (dialog.open) fill();
    });
  }

  function stopLoop() {
    loop?.stop();
    loop = null;
  }

  function head(name) {
    const h = el('header', '');
    const close = button('close', '×', () => dialog.close());
    close.setAttribute('aria-label', t('rules.close'));
    h.append(el('h2', '', t('rules.title', { name })), close);
    return h;
  }

  function more(book) {
    const d = el('details', 'rules-more');
    d.append(el('summary', '', t('rules.full')), paragraphs(book));
    return d;
  }

  // 열 때마다, 장을 넘길 때마다 지금 화면 언어로 다시 채웁니다
  function fill() {
    stopLoop();
    const quick = localize(listing.quickRules, lang);
    const book = localize(listing.rulebook, lang);
    const lines = quickRuleLines(quick.text);
    const name = localize(listing.name, lang).text || entry.id;
    const body = el('div', 'rules-body');
    const foot = el('footer', '');
    const done = () => button('btn', t('rules.ok'), () => dialog.close());

    if (lines.length && hasDemos) {
      // 한 장에 규칙 하나
      page = Math.min(page, lines.length - 1);
      const frames = shots?.lang === gameLang(listing, lang) ? shots.frames[page] : null;
      if (demos[page] && (frames || !shots || loading)) {
        const stage = el('div', 'rules-demo');
        if (frames && shots.info) {
          const canvas = el('canvas', '');
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', t('rules.demo'));
          stage.append(canvas);
          loop = new DemoLoop(canvas, shots.info, frames, demos[page], Math.min(DEMO_PX, (dialog.clientWidth || 520) - 44));
          loop.start();
        } else {
          stage.classList.add('loading');
          stage.textContent = t('rules.demo.loading');
        }
        body.append(stage);
      }
      const rule = el('p', 'rules-line');
      rule.lang = quick.lang;
      if (isRtl(quick.lang)) rule.dir = 'rtl';
      rule.append(el('b', '', String(page + 1)), el('span', '', lines[page]));
      body.append(rule);
      if (page === lines.length - 1) body.append(more(book));

      const dots = el('span', 'rules-dots', `${page + 1} / ${lines.length}`);
      const go = (d) => () => {
        page += d;
        fill();
        dialog.querySelector('footer .btn:last-child').focus();
      };
      const prev = button('btn ghost', t('rules.prev'), go(-1));
      prev.disabled = page === 0;
      foot.append(dots, prev, page === lines.length - 1 ? done() : button('btn', t('rules.next'), go(1)));
    } else if (lines.length) {
      const list = el('ol', 'quick-rules');
      list.lang = quick.lang;
      if (isRtl(quick.lang)) list.dir = 'rtl';
      for (const line of lines) list.append(el('li', '', line));
      body.append(list, more(book));
      foot.append(done());
    } else {
      if (book.lang !== lang) body.append(el('p', 'rulebook-notes', t('rulebook.fallback', { ui: LANG_NAMES[lang], lang: LANG_NAMES[book.lang] })));
      body.append(paragraphs(book));
      foot.append(done());
    }

    dialog.replaceChildren(head(name), body, foot);
    dialog.setAttribute('aria-label', t('rules.title', { name }));
  }

  function open() {
    if (dialog.open) return;
    page = 0;
    if (hasDemos) loadShots();
    fill();
    dialog.showModal();
    dialog.querySelector('footer .btn:last-child').focus();
  }

  dialog.addEventListener('close', () => {
    stopLoop();
    markSeen(entry.id);
  });
  // 바깥(어두운 곳)을 누르면 닫습니다
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  opener.addEventListener('click', open);
  opener.hidden = false;

  if (quickRuleLines(localize(listing.quickRules, lang).text).length && !seen(entry.id)) open();
}
