// AI와 두기: 학습한 AI와 혼자 둡니다 (?game=<id>). 서버와 웹소켓 없이 이 브라우저 안에서만 돌고, 기보와 랭킹에는 남기지 않습니다.
//
// 게임 코드와 AI의 탐색(trainer/mcts.js)은 게임 실행기(engine.js)의 샌드박스 Worker에서, 신경망은 사이트 쪽 Worker(ai-net.js)에서 돕니다.
// AI 차례가 되면 실행기에 think를 부르고, 실행기가 신경망 계산을 부탁할 때마다(need) 관측을 ai-net.js에 넣어 결과를 answer로 돌려줍니다.
// 탐색이 고른 행동(done)은 사람의 클릭처럼 play로 둡니다.
//
// 모델은 운영자가 학습해 올린 것입니다 (/api/games의 ai, server/internal/ai). 관측과 행동의 모양이 지금 게임 코드와 같아야 씁니다.
// 난이도는 한 수마다의 탐색 횟수만 다릅니다 (LEVELS). 보통이 모델에 적힌 sims이고, 시험할 때는 주소에 ?sims=을 붙여 바꿀 수 있습니다.

import { BoardView, PLAYER_COLORS, attachInput } from '/sdk/playground/board.js';
import { gameLang, localize } from '/sdk/playground/listing.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { loadGame, modelFits } from './engine.js';
import { displayName, loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const gameId = params.get('game') ?? '';
const NET_MS = 120_000; // 신경망 불러오기 (처음에는 onnxruntime-web의 WebAssembly 15MB를 받습니다. Caddy가 압축해서 4MB쯤)
const RUN_MS = 10_000; // 신경망 한 번
const MIN_THINK_MS = 400; // AI가 너무 빨리 두면 무엇을 뒀는지 놓치므로 이만큼은 기다립니다

// 난이도 → 한 행동마다의 탐색 횟수. n은 모델에 적힌 sims (운영자가 내보낼 때 정함, 기본 100).
// 쉬움은 탐색 없이 신경망의 첫 느낌대로, 어려움은 보통의 두 배라 그만큼 오래 생각합니다.
const LEVELS = {
  easy: () => 1,
  normal: (n) => n,
  hard: (n) => Math.min(2000, n * 2),
};
const LEVEL_KEY = 'boardmadang.aiLevel'; // 고른 난이도는 이 브라우저에 기억합니다
// 주소의 ?sims=N (1~2000). 있으면 난이도 대신 이 횟수로 두고 난이도 칸을 숨깁니다
const testSims = (() => {
  const n = Number(params.get('sims'));
  return Number.isInteger(n) && n >= 1 && n <= 2000 ? n : null;
})();

let me = null;
let entry = null; // /api/games의 항목. entry.ai가 모델
let runner = null; // 게임 실행기
let net = null; // 신경망 Worker
let board = null;
let phase = 'loading'; // loading | choose | playing | ended | error
let problem = '';
let seat = null; // 내 자리 (0 선공, 1 후공)
let snap = null; // 지금 판 { result, views, legal }
let turn = null; // 둘 차례 (turn())
let moves = 0; // 둔 수: 차례가 넘어간 행동 수 (maxActions 무승부)
let ended = null; // { winner, why: 'result' | 'maxActions' | 'noTurn' | 'resign' | 'aiStuck' }
let hover = null;
let round = 0; // 새 판마다 늘립니다. 앞 판의 AI가 늦게 돌아오면 버립니다
let queue = Promise.resolve(); // 실행기 호출은 하나씩
let level = savedLevel(); // easy | normal | hard. 판을 고르는 화면에서만 바꿀 수 있어 한 판 동안은 그대로입니다

const aiSeat = () => 1 - seat;
const playLang = () => gameLang(entry?.listing, lang);
const nameOfGame = () => localize(entry?.listing?.name, lang).text || entry?.id || gameId;
const flip = () => runner.info.board.flipForPlayer === seat;
const lookOpts = () => ({ players: [seat], lang: playLang(), legalFor: seat });
const sims = () => testSims ?? LEVELS[level](entry.ai.sims);
const levelName = () => (testSims === null ? t(`ai.level.${level}`) : `sims ${testSims}`);

function savedLevel() {
  try {
    const l = localStorage.getItem(LEVEL_KEY);
    return Object.hasOwn(LEVELS, l ?? '') ? l : 'normal';
  } catch {
    return 'normal'; // 저장소를 못 쓰는 브라우저
  }
}

function fail(text) {
  phase = 'error';
  problem = text;
  render();
}

// ---- 신경망 Worker ----

let nextRun = 0;
const runs = new Map(); // id → { resolve, reject, timer }

function startNet() {
  return new Promise((resolve, reject) => {
    net = new Worker('/web/ai-net.js', { type: 'module' });
    const timer = setTimeout(() => reject(new Error('timeout')), NET_MS);
    net.addEventListener('message', (e) => {
      const m = e.data;
      if (m?.type === 'ready') {
        clearTimeout(timer);
        resolve();
      } else if (m?.type === 'error') {
        clearTimeout(timer);
        reject(new Error(m.error));
      } else if (runs.has(m?.id)) {
        const r = runs.get(m.id);
        runs.delete(m.id);
        clearTimeout(r.timer);
        if (m.error) r.reject(new Error(m.error));
        else r.resolve(m);
      }
    });
    net.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.message || 'AI worker error'));
    });
    net.postMessage({ type: 'load', model: entry.ai.model, shape: [runner.shape.channels, runner.shape.rows, runner.shape.cols] });
  });
}

function infer(planes) {
  const id = ++nextRun;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runs.delete(id);
      reject(new Error('timeout'));
    }, RUN_MS);
    runs.set(id, { resolve, reject, timer });
    net.postMessage({ type: 'run', id, planes }, [planes.buffer]);
  });
}

/** AI가 둘 행동. 둘 수 있는 수가 없으면 null */
async function think() {
  let r = await runner.think(sims());
  while (r.need) {
    const { logits, value } = await infer(r.need.planes);
    r = await runner.answer(logits, value);
  }
  return r.done;
}

// ---- 판 진행 ----

/** 새 판. 시드는 판마다 새로 뽑습니다 */
async function newGame(side) {
  const my = ++round;
  seat = side;
  ended = null;
  moves = 0;
  hover = null;
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const s = await runner.start(seed, lookOpts());
  if (my !== round) return;
  snap = s.look;
  turn = s.turn;
  phase = 'playing';
  fit();
  checkEnd();
  render();
  await aiTurns(my);
}

/** player가 행동 하나를 둡니다 */
async function act(player, action) {
  const r = await runner.play([{ player, action }], lookOpts());
  const step = r.steps[0];
  if (step.changed && step.turn !== player) moves++;
  turn = step.turn;
  snap = r.look;
  checkEnd();
}

/** 끝났는지: 게임의 result(), 수 상한, 아무도 차례가 아님 (trainer/env.js의 outcome과 같음) */
function checkEnd() {
  if (ended) return;
  if (snap?.result) ended = { winner: snap.result.winner, why: 'result' };
  else if (moves >= runner.info.maxActions) ended = { winner: null, why: 'maxActions' };
  else if (turn === null) ended = { winner: null, why: 'noTurn' };
  if (ended) phase = 'ended';
}

/** AI 차례가 끝날 때까지 둡니다 (선택 → 이동처럼 한 차례에 여러 행동일 수 있음) */
async function aiTurns(my) {
  while (my === round && phase === 'playing' && turn === aiSeat()) {
    render();
    const started = performance.now();
    const action = await think();
    if (my !== round) return;
    const wait = MIN_THINK_MS - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (my !== round) return;
    if (!action) {
      ended = { winner: null, why: 'aiStuck' };
      phase = 'ended';
      break;
    }
    await act(aiSeat(), action);
  }
  render();
}

/** 화면에서 한 일 (클릭, 특수 행동, 기권, 새 판)을 차례로 처리합니다. 게임 코드가 멈추면 더 둘 수 없습니다 */
function enqueue(job) {
  queue = queue.then(job).catch((err) => {
    if (phase === 'error') return;
    fail(t('match.codeFailed', { msg: err.message }));
  });
  return queue;
}

function humanAct(action) {
  if (phase !== 'playing' || turn !== seat) return;
  const my = round;
  enqueue(async () => {
    if (my !== round || phase !== 'playing' || turn !== seat) return;
    await act(seat, action);
    render();
    await aiTurns(my);
  });
}

// ---- 화면 ----

const sameClick = (a, cell) => a.kind === 'click' && a.row === cell.row && a.col === cell.col;

function legalNow() {
  if (!runner.info.legal || phase !== 'playing' || turn !== seat) return null;
  return snap?.legal ?? null;
}

function statusLine() {
  if (phase === 'error') return [problem, ''];
  if (phase === 'loading') return [problem || t('match.loading'), ''];
  if (phase === 'choose') return [t('ai.choose'), ''];
  if (phase === 'playing') return [turn === seat ? t('ai.yourTurn') : t('ai.thinking'), ''];
  const { winner } = ended;
  if (winner === null) return [t('match.draw'), 'even'];
  return winner === seat ? [t('match.win'), 'win'] : [t('match.lose'), 'lose'];
}

function reasonText() {
  if (phase !== 'ended') return '';
  switch (ended.why) {
    case 'result':
      return snap?.result?.reason ?? ''; // 게임이 쓴 이유
    case 'maxActions':
      return t('match.reason.maxActions');
    case 'resign':
      return t('match.reason.resign.me');
    case 'aiStuck':
      return t('ai.noMoves');
    default:
      return '';
  }
}

function renderStatus() {
  const el = $('#status');
  const [text, cls] = statusLine();
  el.className = `match-status ${cls}`.trim();
  el.textContent = text;
  const why = reasonText();
  if (why) {
    const small = document.createElement('small');
    small.className = 'reason';
    small.textContent = why;
    el.append(document.createElement('br'), small);
  }
}

function renderPlayers() {
  const show = seat !== null && (phase === 'playing' || phase === 'ended');
  $('#players').hidden = !show;
  if (!show) return;
  $('#my-dot').style.background = PLAYER_COLORS[seat];
  $('#ai-dot').style.background = PLAYER_COLORS[aiSeat()];
  $('#my-name').textContent = `${displayName(me)} (${t('match.you')})`;
  $('#my-seat').textContent = t(seat === 0 ? 'match.first' : 'match.second');
  $('#ai-seat').textContent = `${t(seat === 0 ? 'match.second' : 'match.first')} · ${levelName()}`;
}

function renderLevel() {
  const box = $('#level-box');
  box.hidden = phase !== 'choose' || testSims !== null;
  if (box.hidden) return;
  for (const b of box.querySelectorAll('[data-level]')) b.setAttribute('aria-pressed', String(b.dataset.level === level));
  const key = { easy: 'ai.level.hint.easy', normal: 'ai.level.hint', hard: 'ai.level.hint.hard' }[level];
  $('#level-hint').textContent = t(key, { n: sims() });
}

function renderBoard() {
  const show = !!snap && (phase === 'playing' || phase === 'ended');
  $('#board-wrap').hidden = !show;
  if (!show) return;
  const view = snap.views[seat] ?? { pieces: [] };
  const mine = phase === 'playing' && turn === seat;
  board.draw(view, { flip: flip(), hover: mine ? hover : null });
  $('#message').textContent = phase === 'playing' ? view.message ?? '' : '';
}

function renderActions() {
  $('#choose').hidden = phase !== 'choose';
  const playing = phase === 'playing';
  $('#resign').hidden = !playing;
  $('#again').hidden = phase !== 'ended' && !playing;
  const specials = $('#specials');
  specials.replaceChildren();
  if (!playing || turn !== seat) return;
  for (const kind of runner.info.specialActions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost';
    b.textContent = kind;
    b.addEventListener('click', () => humanAct({ kind }));
    specials.append(b);
  }
}

function render() {
  applyStatic('ai.title');
  document.title = `${nameOfGame()} · ${t('ai.title')} · ${t('site.name')}`;
  renderMe(me);
  $('#title').textContent = entry ? `${nameOfGame()} · ${t('ai.title')}` : t('ai.title');
  renderLevel();
  renderStatus();
  renderPlayers();
  renderBoard();
  renderActions();
}

function fit() {
  if (!board) return;
  board.resize(Math.min(480, $('.match').clientWidth));
}

function setupBoard() {
  const canvas = $('#board');
  board = new BoardView(canvas, runner.info.board, runner.info.pieces);
  attachInput(board, canvas, {
    flip,
    // legal()이 있으면 둘 수 있는 곳에만 호버를 보여줍니다
    canHover: (cell) => {
      if (phase !== 'playing' || turn !== seat) return false;
      const legal = legalNow();
      return legal ? legal.some((a) => sameClick(a, cell)) : true;
    },
    click: (cell) => humanAct({ kind: 'click', ...cell }),
    hover: (cell) => {
      hover = cell;
      renderBoard();
    },
  });
  addEventListener('resize', () => {
    fit();
    renderBoard();
  });
}

function setupButtons() {
  for (const b of document.querySelectorAll('#level-box [data-level]')) {
    b.addEventListener('click', () => {
      if (phase !== 'choose') return;
      level = b.dataset.level;
      try {
        localStorage.setItem(LEVEL_KEY, level);
      } catch {
        // 기억하지 못해도 이번 화면에는 적용됩니다
      }
      render();
    });
  }
  for (const side of [0, 1]) $(`#as-${side}`).addEventListener('click', () => enqueue(() => newGame(side)));
  $('#resign').addEventListener('click', () => {
    if (phase !== 'playing' || !confirm(t('match.resign.confirm'))) return;
    round++; // 생각 중이던 AI는 버립니다
    ended = { winner: aiSeat(), why: 'resign' };
    phase = 'ended';
    render();
  });
  $('#again').addEventListener('click', () => {
    round++;
    phase = 'choose';
    render();
  });
}

async function main() {
  // 언어를 바꾸면 게임 안 글자(message, 결과 이유)를 그 언어로 다시 받아 옵니다
  setupLangButtons(() => {
    render();
    if (!snap || seat === null) return;
    enqueue(async () => {
      snap = await runner.look(lookOpts());
      render();
    });
  });
  setLang(await detectLang());
  setupButtons();
  render();

  me = await loadMe();
  try {
    entry = (await (await fetch('/api/games')).json()).find((g) => g.id === gameId) ?? null;
  } catch {
    entry = null;
  }
  if (!entry) return fail(t('match.noGame', { id: gameId }));
  if (!entry.ai) return fail(t('ai.none'));
  render();
  try {
    runner = await loadGame(entry);
  } catch (err) {
    return fail(t('match.loadFailed', { msg: err.message }));
  }
  try {
    // 관측은 학습할 때의 언어로 만듭니다 (view()가 언어마다 다를 수 있음)
    if (!modelFits(entry.ai, await runner.ai(entry.ai.lang))) return fail(t('ai.mismatch'));
    problem = t('ai.loading');
    render();
    await startNet();
  } catch (err) {
    return fail(t('ai.failed', { msg: err.message }));
  }
  problem = '';
  setupBoard();
  phase = 'choose';
  render();
}

main();
