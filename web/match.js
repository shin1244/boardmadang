// 대전 화면: 매칭 → 대국 → 결과.
// 들어오는 길은 셋입니다.
//   ?game=x                       빠른 매칭. 등록 정보의 기본 타이머로 같은 타이머끼리 만납니다.
//   ?game=x&create=1&minutes=N    방 만들기. 방 목록에 올라가고 누가 들어오면 시작합니다. minutes=none이면 타이머 없음.
//   ?game=x&room=CODE             방 목록에서 그 방에 들어가기.
// 게임 코드의 버전(/api/games의 version)을 같이 보내서, 같은 코드를 불러온 사람끼리만 만납니다.
// 서버는 규칙을 모르고 행동에 순번만 붙여 양쪽에 보냅니다 (docs/protocol.md).
// 이 페이지가 게임 로직을 돌려 판을 계산하고, 행동마다 상태 해시를, 끝나면 결과를 서버에 보고합니다.
//
// 내 클릭도 바로 적용하지 않고 서버에서 relay로 돌아온 뒤에 적용합니다.
// 그래야 양쪽이 동시에 눌렀을 때도 같은 순서로 적용됩니다.
//
// 대국 중에 연결이 끊기면 15초 동안 다시 붙어 봅니다. 서버도 그동안 자리를 비워 두고,
// 돌아오면 시드와 행동 기록(resumed)을 보내 주므로 처음부터 재생해서 판을 복원합니다. 새로고침해도 같습니다.
//
// 대국 중에는 무승부를 제안할 수 있고(상대가 수락하면 무승부, 누가 두면 없어짐),
// 끝난 뒤에는 두 사람이 모두 재대결을 누르면 자리를 바꿔 다시 둡니다.
//
// 타이머가 있으면 서버가 대국 시계를 돌립니다. 누구 차례인지는 해시와 같이 보내는 게임의 turn()으로 알려 줍니다.
// 화면의 시계는 서버가 보낸 clock을 받아 이 페이지에서 줄여 보여주기만 합니다. 시간이 다 됐는지는 서버가 정합니다.
//
// TODO: 업로드된 게임 코드는 별도 출처 iframe 안의 Web Worker에서 돌리기 (docs/architecture.md의 보안).
//       지금은 플레이그라운드처럼 이 페이지에서 바로 import합니다.

import { BoardView, PLAYER_COLORS } from '/sdk/playground/board.js';
import { NO_TIMER, gameLang, localize, timerOf } from '/sdk/playground/listing.js';
import { hashOf, makeRng } from '/sdk/playground/platform.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { displayName, loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const gameId = params.get('game') ?? '';
/** quick = 빠른 매칭, create = 방 만들기, enter = 방 목록의 방에 들어가기 */
const mode = params.has('room') ? 'enter' : params.get('create') === '1' ? 'create' : 'quick';

// 끊긴 뒤 다시 붙어 볼 시간. 서버의 ReconnectGrace와 같습니다.
const RECONNECT_MS = 15_000;
const RETRY_MS = 1_500;

let me = null;
let entry = null; // /api/games의 항목 (등록 정보 포함)
let game = null;
let board = null;

/**
 * loading → connecting → waiting(빠른 매칭) 또는 hosting(방 만들기) → playing → ended.
 * 중간에 idle(취소), error로 빠질 수 있습니다.
 */
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
let ended = null; // 서버가 보낸 ended. record가 있으면 저장된 기보 id입니다
let hover = null;
let offlineUntil = null; // 내 연결이 끊겨 다시 붙는 중이면 마감 시각 (ms)
let oppAwayUntil = null; // 상대 연결이 끊겨 기다리는 중이면 마감 시각 (ms)
let retryTimer = null;
let minutes = null; // 이 대국의 타이머(분). null이면 없음
let clock = null; // 서버가 보낸 시계 { remaining: [ms, ms], running, at: 받은 시각 }
let hostedRoom = null; // 방을 만들었으면 방 코드
let bumpEvery = 60; // 초
let nextBumpAt = 0; // 이 시각(ms)부터 다시 올릴 수 있습니다
let drawBy = null; // 무승부를 제안해 둔 자리. 없으면 null
let rematch = { mine: false, theirs: false, off: false }; // 끝난 대국의 재대결: 내가 원함, 상대가 원함, 할 수 없음

const flip = () => game.board.flipForPlayer === seat;
const playLang = () => gameLang(entry?.listing, lang);
const nameOfGame = () => localize(entry?.listing?.name, lang).text || gameId;

/** 이 게임이 실제로 쓰는 타이머. turn()이 없으면 시계를 돌릴 수 없어 없음입니다. */
const timerOfGame = () => (game?.turn ? timerOf(entry?.listing) : NO_TIMER);

/** 찾거나 만들 대국의 타이머(분). 방을 만들 때도 제작자가 커스텀을 막았으면 기본 타이머입니다. */
function wantedMinutes() {
  const timer = timerOfGame();
  if (mode !== 'create' || !timer.custom || !game.turn) return timer.minutes;
  const raw = params.get('minutes') ?? '';
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/** 서버에 처음 보낼 메시지 */
function firstMessage() {
  const version = entry.version ?? '';
  // 대국 중에 끊겨 다시 붙을 때는 항상 join: 서버가 끊긴 대국으로 돌려보내고(resumed), 유예가 지났으면 대기열(waiting)로 넣습니다.
  if (offlineUntil) return { type: 'join', game: gameId, minutes, version };
  if (mode === 'create') return { type: 'create', game: gameId, minutes: wantedMinutes(), version };
  if (mode === 'enter') return { type: 'enter', room: params.get('room'), version };
  return { type: 'join', game: gameId, minutes: wantedMinutes(), version };
}

/** 지금 누구 차례인지 (게임의 turn()). 서버가 이걸로 시계를 넘깁니다. */
function turnNow() {
  if (!game.turn) return null;
  try {
    const p = game.turn(state);
    return p === 0 || p === 1 ? p : null;
  } catch (e) {
    console.error('turn()에서 오류:', e);
    return null;
  }
}

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
 * 웹소켓을 열고 join(또는 create, enter)을 보냅니다. 끊긴 대국이 있으면 서버가 그 대신 resumed로 답합니다.
 * 처음 붙을 때와 다시 붙을 때 모두 씁니다.
 */
function openSocket() {
  clearTimeout(retryTimer);
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = sock;
  sock.addEventListener('open', () => send(firstMessage()));
  sock.addEventListener('message', (e) => onMessage(JSON.parse(e.data)));
  sock.addEventListener('close', () => {
    if (ws !== sock) return;
    ws = null;
    if (phase === 'playing') {
      // 대국 중이면 바로 포기하지 않고 다시 붙어 봅니다.
      offlineUntil ??= Date.now() + RECONNECT_MS;
      retrySoon();
    } else if (phase === 'connecting' || phase === 'waiting' || phase === 'hosting') {
      // 방장의 연결이 끊기면 서버가 방을 바로 지웁니다.
      problem = t(phase === 'connecting' ? 'match.noServer' : 'match.disconnected');
      phase = 'error';
      hostedRoom = null;
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

/**
 * 대국이 끝나도 연결은 그대로 두고 같은 연결로 다시 찾습니다. 끊겼으면 다시 붙습니다.
 * 방 만들기로 왔으면 같은 타이머로 방을 다시 만들고, 남의 방에 들어왔으면 방 목록으로 갑니다.
 */
function findAgain() {
  if (mode === 'enter') {
    location.href = '/web/rooms.html';
    return;
  }
  seat = null;
  opponent = null;
  ended = null;
  if (ws?.readyState === WebSocket.OPEN) {
    phase = 'connecting';
    note = '';
    send(firstMessage());
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
    case 'created':
      phase = 'hosting';
      hostedRoom = m.room;
      minutes = m.minutes;
      bumpEvery = m.bumpEvery;
      nextBumpAt = Date.now() + bumpEvery * 1000;
      break;
    case 'bumped':
      nextBumpAt = Date.now() + bumpEvery * 1000;
      note = t('match.bumped');
      break;
    case 'clock':
      clock = { remaining: m.remaining, running: m.running, at: Date.now() };
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
      drawBy = null;
      break;
    case 'draw':
      drawBy = m.player;
      break;
    case 'drawOff':
      // 내 제안이 없어졌으면 (상대가 거절했거나 누가 뒀음) 알려 줍니다
      if (drawBy === seat && phase === 'playing') note = t('match.draw.gone');
      drawBy = null;
      break;
    case 'rematch':
      if (m.player === seat) rematch.mine = true;
      else rematch.theirs = true;
      break;
    case 'rematchOff':
      rematch.off = true;
      break;
    case 'error':
      if (phase === 'connecting') {
        // 시작하지 못했습니다 (없어진 방, 잘못된 타이머, 다른 버전의 코드 등)
        phase = 'error';
        problem = {
          'room not found': t('match.roomGone'),
          'version mismatch': t('match.versionMismatch'),
        }[m.message] ?? t('match.serverError', { msg: m.message });
        break;
      }
      if (m.message === 'no rematch') {
        rematch.off = true;
        break;
      }
      note = m.message === 'too soon' ? t('match.draw.tooSoon') : t('match.serverError', { msg: m.message });
      break;
  }
  render();
}

function start(m) {
  seat = m.player;
  opponent = m.opponent;
  minutes = m.minutes ?? null;
  clock = null;
  hostedRoom = null;
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
  drawBy = null;
  rematch = { mine: false, theirs: false, off: false };
  phase = 'playing';
  send({ type: 'hash', seq: -1, hash: stateHash, turn: turnNow() });
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
  if (m.clock) clock = { remaining: m.clock.remaining, running: m.clock.running, at: Date.now() };
  drawBy = m.draw ?? null;
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
  send({ type: 'hash', seq: m.seq, hash: h, turn: turnNow() });
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
    case 'agreed':
      return t('match.reason.agreed');
    case 'resign':
    case 'spam':
    case 'timeout':
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
    hosting: t('match.hosting'),
    playing: offlineUntil ? t('match.reconnecting', { s: secondsLeft(offlineUntil) })
      : oppAwayUntil ? t('match.oppAway', { s: secondsLeft(oppAwayUntil) })
        : reported ? t('match.reporting') : '',
    idle: t('match.cancelled'),
    error: problem,
  }[phase];
  el.textContent = text;
  if (['waiting', 'hosting', 'connecting'].includes(phase) || offlineUntil || oppAwayUntil) el.classList.add('waiting');
}

/** 타이머 안내 한 줄 ("각자 10분" / "타이머 없음"). 대국이 정해지기 전에는 찾는 타이머를 보여줍니다. */
function renderTimerInfo() {
  const el = $('#timer-info');
  const known = seat !== null || phase === 'hosting';
  el.hidden = !game || !(known || phase === 'waiting' || phase === 'connecting') || (mode === 'enter' && !known);
  if (el.hidden) return;
  const m = known ? minutes : wantedMinutes();
  el.textContent = m === null ? t('timer.none') : t('timer.each', { m });
}

/** 남은 시간(ms). 가는 쪽은 받은 뒤로 흐른 시간을 뺍니다. */
function clockLeft(p) {
  if (!clock) return minutes * 60_000;
  const ms = clock.remaining[p] - (clock.running === p ? Date.now() - clock.at : 0);
  return Math.max(0, ms);
}

/** 5:07처럼 분:초. 남은 시간을 올림해서 0:00은 정말 다 썼을 때만 보입니다. */
function formatClock(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderClocks() {
  for (const [id, p] of [['#my-clock', seat], ['#opp-clock', 1 - seat]]) {
    const el = $(id);
    el.hidden = minutes === null || seat === null;
    if (el.hidden) continue;
    const ms = clockLeft(p);
    el.textContent = formatClock(ms);
    el.classList.toggle('running', clock?.running === p && phase === 'playing');
    el.classList.toggle('low', ms < 30_000);
    el.setAttribute('aria-label', t('match.clock', { time: formatClock(ms) }));
  }
}

function renderHosting() {
  $('#hosting').hidden = phase !== 'hosting';
  if (phase !== 'hosting') return;
  $('#room-code').textContent = hostedRoom;
  const wait = Math.max(0, Math.ceil((nextBumpAt - Date.now()) / 1000));
  $('#bump').disabled = wait > 0;
  $('#bump-wait').textContent = wait > 0 ? t('match.bump.wait', { s: wait }) : '';
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
  renderClocks();
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

/** 무승부 제안 줄과 재대결 버튼 */
function renderOffers(playing) {
  const offer = playing && drawBy !== null;
  $('#draw').hidden = !playing || offer;
  $('#draw-offer').hidden = !offer;
  if (offer) {
    const mine = drawBy === seat;
    $('#draw-text').textContent = t(mine ? 'match.draw.mine' : 'match.draw.theirs');
    $('#draw-accept').hidden = mine;
    $('#draw-decline').hidden = mine;
    $('#draw-withdraw').hidden = !mine;
  }

  const canRematch = phase === 'ended' && seat !== null && !rematch.off;
  const b = $('#rematch');
  b.hidden = !canRematch;
  b.disabled = rematch.mine;
  b.textContent = t(rematch.mine ? 'match.rematch.waiting' : rematch.theirs ? 'match.rematch.accept' : 'match.rematch');
  const n = $('#rematch-note');
  const text = phase !== 'ended' || seat === null ? ''
    : rematch.off ? t('match.rematch.off')
      : rematch.theirs ? t('match.rematch.theirs')
        : rematch.mine ? t('match.rematch.mine') : '';
  n.hidden = !text;
  n.textContent = text;
}

function renderActions() {
  const playing = phase === 'playing' && !reported && !offlineUntil;
  renderOffers(playing);
  $('#resign').hidden = !playing;
  $('#cancel').hidden = !['waiting', 'hosting', 'connecting'].includes(phase);
  $('#again').hidden = !['ended', 'idle', 'error'].includes(phase) || !game;
  $('#again').textContent = t({ quick: 'match.again', create: 'match.againRoom', enter: 'match.toRooms' }[mode]);
  $('#replay').hidden = phase !== 'ended' || !ended?.record;
  if (ended?.record) $('#replay').href = `/web/replay.html?id=${encodeURIComponent(ended.record)}`;
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
  renderTimerInfo();
  renderStatus();
  renderHosting();
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
  $('#draw').addEventListener('click', () => send({ type: 'draw' }));
  $('#draw-accept').addEventListener('click', () => send({ type: 'draw' }));
  $('#draw-decline').addEventListener('click', () => send({ type: 'decline' }));
  $('#draw-withdraw').addEventListener('click', () => send({ type: 'decline' }));
  $('#rematch').addEventListener('click', () => send({ type: 'rematch' }));
  $('#cancel').addEventListener('click', cancel);
  $('#again').addEventListener('click', findAgain);
  $('#bump').addEventListener('click', () => send({ type: 'bump' }));
  window.addEventListener('resize', () => {
    fit();
    render();
  });
  document.addEventListener('visibilitychange', onVisible);
  // 남은 시간 표시
  setInterval(() => {
    if (offlineUntil || oppAwayUntil) renderStatus();
    if (phase === 'hosting') renderHosting();
  }, 1000);
  setInterval(() => {
    if (phase === 'playing' && clock?.running != null) renderClocks();
  }, 200);
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
