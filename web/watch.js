// 관전 화면: 진행 중인 대국을 실시간으로 봅니다 (watch.html?room=CODE, 방 목록의 관전 버튼).
// 서버에 watch를 보내면 시드와 지금까지의 행동 기록(watching)이 오고, 그 뒤로는 두 사람과 같은 relay, clock, ended를 받습니다.
// 플레이어처럼 게임 로직으로 판을 계산하지만, 해시나 결과는 보고하지 않습니다. 결과는 서버가 보낸 ended를 그대로 보여줍니다.
//
// 연결이 끊기면 다시 붙어 처음부터 받아 옵니다 (관전자 자리는 서버가 기다려 주지 않습니다).

import { BoardView, PLAYER_COLORS } from '/sdk/playground/board.js';
import { gameLang, localize } from '/sdk/playground/listing.js';
import { makeRng } from '/sdk/playground/platform.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { popEmote } from './emotes.js';
import { displayName, loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);
const roomId = new URLSearchParams(location.search).get('room') ?? '';
const RETRY_MS = 3_000;

let me = null;
let games = null; // /api/games
let entry = null;
let game = null;
let board = null;
let info = null; // 서버가 보낸 watching (players, minutes, version)
let state = null;
let applied = 0;
let viewAs = 0;
let clock = null; // { remaining: [ms, ms], running, at }
let drawBy = null;
let away = [null, null]; // 자리별로 연결이 끊겨 기다리는 마감 시각 (ms)
let ended = null;
let phase = 'loading'; // loading → connecting → watching → ended, 또는 error
let problem = '';
let ws = null;
let queue = Promise.resolve(); // 메시지를 받은 순서대로 하나씩 처리합니다 (게임 코드를 불러오는 동안 온 relay를 놓치지 않게)

const playLang = () => gameLang(entry?.listing, lang);
const nameOfGame = () => localize(entry?.listing?.name, lang).text || info?.game || '';
const flip = () => game.board.flipForPlayer === viewAs;
const secondsLeft = (until) => Math.max(0, Math.ceil((until - Date.now()) / 1000));

// ---- 서버 ----

function connect() {
  phase = 'connecting';
  render();
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = sock;
  sock.addEventListener('open', () => sock.send(JSON.stringify({ type: 'watch', room: roomId })));
  sock.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    queue = queue.then(() => onMessage(m)).catch((err) => fail(t('match.loadFailed', { msg: err.message })));
  });
  sock.addEventListener('close', () => {
    if (ws !== sock) return;
    ws = null;
    // 보는 중에 끊겼으면 다시 붙습니다. 그 사이에 끝났으면 "없는 대국"이 옵니다.
    if (phase === 'watching') setTimeout(connect, RETRY_MS);
    else if (phase === 'connecting') fail(t('match.noServer'));
  });
}

async function onMessage(m) {
  switch (m.type) {
    case 'watching':
      await begin(m);
      break;
    case 'relay':
      apply(m);
      break;
    case 'clock':
      clock = { remaining: m.remaining, running: m.running, at: Date.now() };
      break;
    case 'draw':
      drawBy = m.player;
      break;
    case 'drawOff':
      drawBy = null;
      break;
    case 'emote':
      if (m.player === 0 || m.player === 1) popEmote($(`#p${m.player}-emote`), m.emote);
      return;
    case 'away':
      away[m.player] = Date.now() + m.seconds * 1000;
      break;
    case 'back':
      away[m.player] = null;
      break;
    case 'ended':
      ended = m;
      phase = 'ended';
      drawBy = null;
      away = [null, null];
      ws?.close();
      break;
    case 'error':
      if (phase !== 'ended') fail(m.message === 'room not found' ? t('watch.gone') : t('match.serverError', { msg: m.message }));
      break;
  }
  render();
}

/** 관전 시작: 게임 코드를 불러와 시드로 시작하고 지금까지의 기록을 재생합니다. 다시 붙을 때도 처음부터 합니다. */
async function begin(m) {
  info = m;
  if (!game) {
    entry = games.find((g) => g.id === m.game) ?? null;
    if (!entry) return fail(t('replay.noGame', { id: m.game }));
    game = (await import(entry.module)).default;
    board = new BoardView($('#board'), game.board, game.pieces);
    fit();
  }
  state = game.setup(makeRng(m.seed));
  applied = 0;
  clock = m.clock ? { remaining: m.clock.remaining, running: m.clock.running, at: Date.now() } : null;
  drawBy = m.draw ?? null;
  away = [null, null];
  phase = 'watching';
  for (const r of m.log) apply(r);
}

function apply(m) {
  if (!game || m.seq !== applied) return;
  applied++;
  try {
    state = game.play(state, m.player, m.action);
  } catch (e) {
    // 플레이어 화면에서도 같은 오류가 났고 상태가 그대로입니다
    console.error('play()에서 오류:', e);
  }
}

function fail(msg) {
  problem = msg;
  phase = 'error';
  render();
}

// ---- 화면 ----

/** 결과 한 줄: [글, 색 class] */
function outcome() {
  const { winner, reason } = ended;
  if (['desync', 'disagree', 'limit'].includes(reason)) return [t('match.void'), 'even'];
  if (winner === null) return [t('match.draw'), 'even'];
  return [t('replay.won', { name: displayName(info.players[winner]) }), 'win'];
}

function reasonText() {
  const { winner, reason } = ended;
  const loser = winner === null ? null : info.players[1 - winner];
  switch (reason) {
    case 'result': {
      try {
        return game.result(state, playLang())?.reason ?? '';
      } catch {
        return '';
      }
    }
    case 'resign':
    case 'left':
    case 'timeout':
    case 'spam':
      return t(`replay.reason.${reason}`, { name: displayName(loser) });
    default:
      return t(`match.reason.${reason}`);
  }
}

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
  if (phase === 'error') {
    el.textContent = problem;
    return;
  }
  if (phase !== 'watching') {
    el.textContent = t(phase === 'loading' ? 'match.loading' : 'match.connecting');
    el.classList.add('waiting');
    return;
  }
  const gone = [0, 1].find((p) => away[p]);
  if (gone !== undefined) {
    el.textContent = t('watch.away', { name: displayName(info.players[gone]), s: secondsLeft(away[gone]) });
    el.classList.add('waiting');
  } else if (drawBy !== null) {
    el.textContent = t('watch.draw', { name: displayName(info.players[drawBy]) });
  } else {
    el.textContent = t('watch.live');
  }
}

function clockLeft(p) {
  if (!clock) return info.minutes * 60_000;
  const ms = clock.remaining[p] - (clock.running === p && phase === 'watching' ? Date.now() - clock.at : 0);
  return Math.max(0, ms);
}

function formatClock(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderPlayers() {
  $('#players').hidden = !info || !game;
  if ($('#players').hidden) return;
  for (const p of [0, 1]) {
    $(`#p${p}-dot`).style.background = PLAYER_COLORS[p];
    const name = $(`#p${p}-name`);
    name.textContent = displayName(info.players[p]);
    name.classList.toggle('winner', ended?.winner === p);
    $(`#p${p}-tag`).textContent = t(p === 0 ? 'match.first' : 'match.second');
    const c = $(`#p${p}-clock`);
    c.hidden = info.minutes === null;
    if (c.hidden) continue;
    const ms = clockLeft(p);
    c.textContent = formatClock(ms);
    c.classList.toggle('running', clock?.running === p && phase === 'watching');
    c.classList.toggle('low', ms < 30_000);
    c.setAttribute('aria-label', t('match.clock', { time: formatClock(ms) }));
  }
}

function renderBoard() {
  $('#board-wrap').hidden = !state;
  if (!state) return;
  let view = { pieces: [] };
  try {
    view = game.view(state, viewAs, playLang()) ?? view;
  } catch (e) {
    console.error('view()에서 오류:', e);
  }
  board.draw(view, { flip: flip() });
  // 게임이 쓴 안내("당신 차례" 등)는 진행 중에만 보여줍니다
  $('#message').textContent = phase === 'watching' ? view.message ?? '' : '';
}

function render() {
  applyStatic('watch.title');
  if (info && game) document.title = `${nameOfGame()} · ${t('watch.title')} · ${t('site.name')}`;
  renderMe(me);
  $('#title').textContent = game ? nameOfGame() : '';
  const timer = $('#timer-info');
  timer.hidden = !info;
  if (info) timer.textContent = info.minutes === null ? t('timer.none') : t('timer.each', { m: info.minutes });
  renderPlayers();
  renderStatus();
  // 내 브라우저의 게임 코드가 대국과 다르면 판이 다르게 보일 수 있습니다
  $('#version-note').hidden = !info || !entry?.version || info.version === entry.version;
  if (game) renderBoard();
  $('#controls').hidden = !state;
  $('#position').textContent = t('history.moves', { n: applied });
  $('#view-as').value = String(viewAs);
  $('#replay').hidden = !ended?.record;
  if (ended?.record) $('#replay').href = `/web/replay.html?id=${encodeURIComponent(ended.record)}`;
}

function fit() {
  board?.resize(Math.min(480, $('.match').clientWidth));
}

async function main() {
  setupLangButtons(render);
  setLang(await detectLang());
  render();
  // 웹소켓은 세션 쿠키가 있어야 붙습니다
  me = await loadMe();
  games = await (await fetch('/api/games')).json();
  $('#view-as').addEventListener('change', (e) => {
    viewAs = Number(e.target.value);
    render();
  });
  window.addEventListener('resize', () => {
    fit();
    render();
  });
  setInterval(() => {
    if (phase === 'watching' && (clock?.running != null || away.some(Boolean))) {
      renderPlayers();
      renderStatus();
    }
  }, 250);
  if (!roomId) return fail(t('watch.gone'));
  connect();
}

main().catch((err) => fail(t('match.loadFailed', { msg: err.message })));
