// 대전 화면: 매칭 → 대국 → 결과.
// 서버는 규칙을 모르고 행동에 순번만 붙여 양쪽에 보냅니다 (docs/protocol.md).
// 이 페이지가 게임 로직을 돌려 판을 계산하고, 행동마다 상태 해시를, 끝나면 결과를 서버에 보고합니다.
//
// 내 클릭도 바로 적용하지 않고 서버에서 relay로 돌아온 뒤에 적용합니다.
// 그래야 양쪽이 동시에 눌렀을 때도 같은 순서로 적용됩니다.
//
// 대국 중에 연결이 끊기면 15초 동안 다시 붙어 봅니다. 서버도 그동안 자리를 비워 두고,
// 돌아오면 시드와 행동 기록(resumed)을 보내 주므로 처음부터 재생해서 판을 복원합니다. 새로고침해도 같습니다.
//
// TODO: 업로드된 게임 코드는 별도 출처 iframe 안의 Web Worker에서 돌리기 (docs/architecture.md의 보안).
//       지금은 플레이그라운드처럼 이 페이지에서 바로 import합니다.

import { BoardView, PLAYER_COLORS } from '/sdk/playground/board.js';
import { gameLang, localize } from '/sdk/playground/listing.js';
import { hashOf, makeRng } from '/sdk/playground/platform.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { displayName, loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);
const gameId = new URLSearchParams(location.search).get('game') ?? '';

// 끊긴 뒤 다시 붙어 볼 시간. 서버의 ReconnectGrace와 같습니다.
const RECONNECT_MS = 15_000;
const RETRY_MS = 1_500;

let me = null;
let entry = null; // /api/games의 항목 (등록 정보 포함)
let game = null;
let board = null;

/** loading → connecting → waiting → playing → ended. 중간에 idle(취소), error로 빠질 수 있습니다. */
let phase = 'loading';
let problem = ''; // phase가 error일 때 보여줄 글
let note = ''; // 서버가 보낸 error처럼 잠깐 알려줄 글

let ws = null;
let seat = null; // 내 자리 (0 = 선공, 1 = 후공)
let opponent = null;
let state = null;
let stateHash = '';
let applied = 0; // 적용한 relay 수 = 다음 순번
let effective = 0; // 상태를 바꾼 행동 수 (maxActions 기준)
let reported = null; // 내가 서버에 보고한 결과. 서버의 ended를 기다리는 중
let ended = null; // 서버가 보낸 ended
let hover = null;
let offlineUntil = null; // 내 연결이 끊겨 다시 붙는 중이면 마감 시각 (ms)
let oppAwayUntil = null; // 상대 연결이 끊겨 기다리는 중이면 마감 시각 (ms)
let retryTimer = null;

const flip = () => game.board.flipForPlayer === seat;
const playLang = () => gameLang(entry?.listing, lang);
const nameOfGame = () => localize(entry?.listing?.name, lang).text || gameId;

// ---- 서버와 주고받기 ----

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  phase = 'connecting';
  note = '';
  render();
  openSocket();
}

/**
 * 웹소켓을 열고 join을 보냅니다. 끊긴 대국이 있으면 서버가 대기열 대신 resumed로 답합니다.
 * 처음 붙을 때와 다시 붙을 때 모두 씁니다.
 */
function openSocket() {
  clearTimeout(retryTimer);
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = sock;
  sock.addEventListener('open', () => send({ type: 'join', game: gameId }));
  sock.addEventListener('message', (e) => onMessage(JSON.parse(e.data)));
  sock.addEventListener('close', () => {
    if (ws !== sock) return;
    ws = null;
    if (phase === 'playing') {
      // 대국 중이면 바로 포기하지 않고 다시 붙어 봅니다.
      offlineUntil ??= Date.now() + RECONNECT_MS;
      retrySoon();
    } else if (phase === 'connecting' || phase === 'waiting') {
      problem = t(phase === 'connecting' ? 'match.noServer' : 'match.disconnected');
      phase = 'error';
    }
    render();
  });
}

function retrySoon() {
  if (Date.now() >= offlineUntil) {
    offlineUntil = null;
    problem = t('match.lostConnection');
    phase = 'error';
    render();
    return;
  }
  retryTimer = setTimeout(openSocket, RETRY_MS);
}

/** 휴대폰 화면을 다시 켰을 때 다음 시도를 기다리지 않고 바로 붙어 봅니다. */
function onVisible() {
  if (document.visibilityState === 'visible' && offlineUntil && !ws) openSocket();
}

/** 대국이 끝나도 연결은 그대로 두고 같은 연결로 다시 찾습니다. 끊겼으면 다시 붙습니다. */
function findAgain() {
  seat = null;
  opponent = null;
  ended = null;
  if (ws?.readyState === WebSocket.OPEN) {
    phase = 'connecting';
    note = '';
    send({ type: 'join', game: gameId });
    render();
  } else {
    connect();
  }
}

function cancel() {
  phase = 'idle';
  ws?.close();
  render();
}

function onMessage(m) {
  switch (m.type) {
    case 'waiting':
      if (offlineUntil) {
        // 다시 붙었는데 대기열로 들어갔다: 유예 시간이 지나 대국이 이미 끝났습니다. 새 대전은 찾지 않습니다.
        offlineUntil = null;
        problem = t('match.lostConnection');
        phase = 'error';
        const sock = ws;
        ws = null;
        sock?.close();
        break;
      }
      phase = 'waiting';
      break;
    case 'matched':
      start(m);
      break;
    case 'resumed':
      resume(m);
      break;
    case 'away':
      if (m.player !== seat) oppAwayUntil = Date.now() + m.seconds * 1000;
      break;
    case 'back':
      oppAwayUntil = null;
      break;
    case 'relay':
      apply(m);
      break;
    case 'desync':
      // 곧 ended(desync)가 따라옵니다.
      console.warn(`상태 해시가 ${m.seq}번째 행동에서 달라졌습니다`);
      break;
    case 'ended':
      ended = m;
      phase = 'ended';
      oppAwayUntil = null;
      break;
    case 'error':
      note = t('match.serverError', { msg: m.message });
      break;
  }
  render();
}

function start(m) {
  seat = m.player;
  opponent = m.opponent;
  state = game.setup(makeRng(m.seed));
  stateHash = hashOf(state);
  applied = 0;
  effective = 0;
  reported = null;
  ended = null;
  hover = null;
  note = '';
  offlineUntil = null;
  oppAwayUntil = null;
  phase = 'playing';
  send({ type: 'hash', seq: -1, hash: stateHash });
  fit();
  checkResult();
}

/**
 * 끊겼다가 돌아왔을 때: 시드로 다시 시작해서 기록을 처음부터 재생합니다.
 * 재생하면서 해시와 결과를 다시 보내는데, 이미 보고한 것은 서버가 무시합니다.
 * 기다리는 동안 대국이 끝났으면 바로 뒤에 ended가 옵니다.
 */
function resume(m) {
  if (m.game !== gameId) {
    // 다른 게임 화면에서 들어왔으면 그 게임의 대전 화면으로 갑니다. 거기서 다시 붙으면 또 resumed가 옵니다.
    location.replace(`/web/match.html?game=${encodeURIComponent(m.game)}`);
    return;
  }
  start(m);
  for (const r of m.log) apply(r);
}

/** 순번이 붙은 행동을 게임 로직에 넣습니다. 양쪽이 같은 순서로 넣으므로 같은 판이 됩니다. */
function apply(m) {
  if (phase !== 'playing' || m.seq !== applied) return;
  applied++;
  let next = state;
  try {
    next = game.play(state, m.player, m.action);
  } catch (e) {
    // 상대 화면에서도 같은 오류가 납니다 (결정적). 상태를 그대로 두면 무시된 행동으로 셉니다.
    console.error('play()에서 오류:', e);
  }
  const h = hashOf(next);
  if (h !== stateHash) effective++;
  state = next;
  stateHash = h;
  send({ type: 'hash', seq: m.seq, hash: h });
  checkResult();
}

/** 게임 로직이 끝났다고 하거나 maxActions에 이르면 결과를 한 번 보고합니다. */
function checkResult() {
  if (reported) return;
  let r = null;
  try {
    r = game.result(state, playLang());
  } catch (e) {
    console.error('result()에서 오류:', e);
  }
  if (!r && effective >= game.maxActions) r = { winner: null, reason: 'maxActions' };
  if (!r) return;
  reported = r;
  send({ type: 'result', winner: r.winner ?? null, reason: r.reason });
}

// ---- 화면 ----

function legalNow() {
  if (!game.legal || phase !== 'playing' || reported) return null;
  try {
    return game.legal(state, seat);
  } catch {
    return null;
  }
}

const sameClick = (a, cell) => a.kind === 'click' && a.row === cell.row && a.col === cell.col;

/** 결과 한 줄: [글, 색 class] */
function outcome() {
  const { winner, reason } = ended;
  if (['desync', 'disagree', 'limit'].includes(reason)) return [t('match.void'), 'even'];
  if (winner === null) return [t('match.draw'), 'even'];
  return winner === seat ? [t('match.win'), 'win'] : [t('match.lose'), 'lose'];
}

/** 왜 끝났는지. 게임 로직이 끝냈으면 게임이 쓴 이유를 보여줍니다. */
function reasonText() {
  const { winner, reason } = ended;
  const mine = winner === seat;
  switch (reason) {
    case 'result':
      if (reported?.reason === 'maxActions') return t('match.reason.maxActions');
      return reported?.reason ?? '';
    case 'resign':
    case 'spam':
      return t(`match.reason.${reason}.${mine ? 'opp' : 'me'}`);
    default:
      return t(`match.reason.${reason}`);
  }
}

/** 마감까지 남은 초 */
const secondsLeft = (until) => Math.max(0, Math.ceil((until - Date.now()) / 1000));

function renderStatus() {
  const el = $('#status');
  el.className = 'match-status';
  el.textContent = '';
  if (phase === 'ended') {
    const [text, cls] = outcome();
    el.classList.add(cls);
    el.textContent = text;
    const why = reasonText();
    if (why) {
      const small = document.createElement('small');
      small.className = 'reason';
      small.textContent = why;
      el.append(document.createElement('br'), small);
    }
    return;
  }
  const text = {
    loading: t('match.loading'),
    connecting: t('match.connecting'),
    waiting: t('match.waiting'),
    playing: offlineUntil ? t('match.reconnecting', { s: secondsLeft(offlineUntil) })
      : oppAwayUntil ? t('match.oppAway', { s: secondsLeft(oppAwayUntil) })
        : reported ? t('match.reporting') : '',
    idle: t('match.cancelled'),
    error: problem,
  }[phase];
  el.textContent = text;
  if (phase === 'waiting' || phase === 'connecting' || offlineUntil || oppAwayUntil) el.classList.add('waiting');
}

function renderPlayers() {
  const show = seat !== null && (phase === 'playing' || phase === 'ended');
  $('#players').hidden = !show;
  if (!show) return;
  $('#my-dot').style.background = PLAYER_COLORS[seat];
  $('#opp-dot').style.background = PLAYER_COLORS[1 - seat];
  $('#my-name').textContent = `${displayName(me)} (${t('match.you')})`;
  $('#opp-name').textContent = displayName(opponent);
  $('#my-seat').textContent = t(seat === 0 ? 'match.first' : 'match.second');
  $('#opp-seat').textContent = t(seat === 0 ? 'match.second' : 'match.first');
}

function renderBoard() {
  const show = state !== null && seat !== null && (phase === 'playing' || phase === 'ended');
  $('#board-wrap').hidden = !show;
  if (!show) return;
  let view = { pieces: [] };
  try {
    view = game.view(state, seat, playLang()) ?? view;
  } catch (e) {
    console.error('view()에서 오류:', e);
  }
  board.draw(view, { flip: flip(), hover: phase === 'playing' ? hover : null });
  $('#message').textContent = phase === 'playing' ? view.message ?? '' : '';
}

function renderActions() {
  const playing = phase === 'playing' && !reported && !offlineUntil;
  $('#resign').hidden = !playing;
  $('#cancel').hidden = !(phase === 'waiting' || phase === 'connecting');
  $('#again').hidden = !['ended', 'idle', 'error'].includes(phase) || !game;
  const specials = $('#specials');
  specials.replaceChildren();
  if (!playing) return;
  for (const kind of game.specialActions ?? []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost';
    b.textContent = kind;
    b.addEventListener('click', () => send({ type: 'action', action: { kind } }));
    specials.append(b);
  }
}

function render() {
  applyStatic();
  document.title = `${nameOfGame()} · ${t('match.title')} · ${t('site.name')}`;
  renderMe(me);
  $('#title').textContent = game ? nameOfGame() : '';
  renderStatus();
  renderPlayers();
  if (board) renderBoard();
  renderActions();
  $('#note').hidden = !note;
  $('#note').textContent = note;
}

function fit() {
  if (!board) return;
  board.resize(Math.min(480, $('.match').clientWidth));
}

function setupBoard() {
  const canvas = $('#board');
  board = new BoardView(canvas, game.board, game.pieces);
  canvas.addEventListener('click', (e) => {
    if (phase !== 'playing' || reported || offlineUntil) return;
    const cell = board.cellAt(e, flip());
    if (cell) send({ type: 'action', action: { kind: 'click', ...cell } });
  });
  canvas.addEventListener('mousemove', (e) => {
    if (phase !== 'playing') return;
    const cell = board.cellAt(e, flip());
    const legal = cell && legalNow();
    // legal()이 있으면 둘 수 있는 곳에만 호버를 보여줍니다.
    const ok = cell && !reported && (legal ? legal.some((a) => sameClick(a, cell)) : true);
    canvas.style.cursor = ok ? 'pointer' : 'default';
    const next = ok ? cell : null;
    if (next?.row !== hover?.row || next?.col !== hover?.col) {
      hover = next;
      renderBoard();
    }
  });
  canvas.addEventListener('mouseleave', () => {
    hover = null;
    renderBoard();
  });
}

async function main() {
  setupLangButtons(render);
  setLang(await detectLang());
  render();

  // 웹소켓은 세션 쿠키가 있어야 붙습니다. /api/me가 쿠키를 주거나 새 게스트를 발급합니다.
  me = await loadMe();
  entry = (await (await fetch('/api/games')).json()).find((g) => g.id === gameId) ?? null;
  if (!entry) {
    phase = 'error';
    problem = t('match.noGame', { id: gameId });
    render();
    return;
  }
  game = (await import(entry.module)).default;
  setupBoard();

  $('#resign').addEventListener('click', () => {
    if (confirm(t('match.resign.confirm'))) send({ type: 'resign' });
  });
  $('#cancel').addEventListener('click', cancel);
  $('#again').addEventListener('click', findAgain);
  window.addEventListener('resize', () => {
    fit();
    render();
  });
  document.addEventListener('visibilitychange', onVisible);
  // 남은 시간 표시
  setInterval(() => {
    if (offlineUntil || oppAwayUntil) renderStatus();
  }, 1000);
  window.addEventListener('beforeunload', (e) => {
    if (phase === 'playing' && !reported) e.preventDefault();
  });

  connect();
}

main().catch((err) => {
  phase = 'error';
  problem = t('match.loadFailed', { msg: err.message });
  render();
});
