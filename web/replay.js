// 기보 다시보기: 서버에 저장된 시드와 행동 기록을 받아, 게임 로직으로 처음부터 한 수씩 다시 둡니다 (락스텝과 같은 방식).
// 기보 id를 아는 사람은 누구나 볼 수 있습니다. 내가 둔 판이면 내 자리 시점으로 엽니다.
// ?clear=<게임>이면 대국 기보 대신 제작자 클리어 기보(GET /api/games/<게임>/clear)를 봅니다.
// 등록할 때 제작자가 혼자 양쪽을 둬서 이긴 판이라 두 자리 모두 "제작자"입니다 (server/internal/upload/clear.go).
// ?training=<게임>&snap=<i>&n=<j>이면 AI 학습 기록(GET /api/ai/<게임>/training)의 i번째 스냅샷에서 AI끼리 둔 j번째 판을 봅니다.
// 게임 제작자와 운영자만 받을 수 있습니다. 두 자리 모두 그때의 AI입니다 (trainer/train.py의 Snapshots, web/training.js).
//
// 제작자가 게임 코드를 고쳤으면 예전 기보가 다르게 재생될 수 있습니다.
// 올린 게임은 옛 버전 코드도 남아 있어서(/uploads/<게임>/<버전>/) 기보를 둔 버전의 코드로 재생합니다. 내린 게임도 마찬가지입니다.
// 레포 게임처럼 옛 코드가 없으면 지금 코드로 재생하고, 기보의 버전이 지금 코드(/api/games의 version)와 다르면 알려 줍니다.
//
// 게임 코드는 이 페이지가 아니라 게임 실행기(engine.js)의 샌드박스 Worker에서 돌립니다.
// 모든 수의 상태는 Worker에 남기고, 이 페이지는 보고 있는 수의 판만 받아 와 그립니다.

import { BoardView, PLAYER_COLORS } from '/sdk/playground/board.js';
import { gameLang, localize } from '/sdk/playground/listing.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { loadGame } from './engine.js';
import { displayName, loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const recordId = params.get('id') ?? '';
/** 제작자 클리어 기보를 볼 게임 id. 대국 기보면 null */
const clearOf = params.get('clear');
/** AI 학습 기록을 볼 게임 id와 스냅샷, 판 번호 */
const trainingOf = params.get('training');
const snapAt = Number(params.get('snap') ?? 0);
const gameAt = Number(params.get('n') ?? 0);
/** 'match' | 'clear' | 'training' */
const mode = trainingOf !== null ? 'training' : clearOf !== null ? 'clear' : 'match';
const titleKey = { match: 'replay.title', clear: 'replay.clearTitle', training: 'replay.trainingTitle' }[mode];
const STEP_MS = 700;

let me = null;
let rec = null; // GET /api/matches/{id}
let entry = null; // /api/games의 항목
let runner = null; // 게임 실행기 (engine.js). 모든 수의 상태를 Worker에 남겨 둡니다
let board = null;
let shown = null; // 그리고 있는 판 { pos, lang, look }. look.views는 두 자리 모두
let loading = null; // 받아 오는 중인 판 { pos, lang }
let final = null; // 마지막 수 뒤의 판 (끝난 이유를 쓰려고)
let moves = 0; // 둔 수: 차례가 넘어간 행동 수 (maxActions 무승부를 알아보려고)
let pos = 0;
let viewAs = 0;
let timer = null;
let problem = '';
let snapshot = null; // 학습 기록의 스냅샷 (mode가 'training'일 때)

const playLang = () => gameLang(entry?.listing, lang);
const nameOfGame = () => localize(entry?.listing?.name, lang).text || rec?.game || '';
const flip = () => runner.info.board.flipForPlayer === viewAs;
/** 학습 몇 분째인지. 0분은 "학습 전" (web/training.js와 같은 글) */
const minuteText = (m) => (m === 0 ? t('training.before') : t('training.minute', { m: m < 10 ? Math.round(m * 10) / 10 : Math.round(m) }));

function playerName(p) {
  if (mode === 'clear') return t('replay.creator');
  if (mode === 'training') return t('replay.aiAt', { at: minuteText(snapshot.minute) });
  return displayName(rec.players[p]);
}

/** 학습 기록의 판을 대국 기보 모양으로 맞춥니다. 없는 판이면 null */
function fromTraining(data) {
  snapshot = data.snapshots?.[snapAt] ?? null;
  const g = snapshot?.games?.[gameAt];
  if (!g) return null;
  return {
    game: data.game,
    version: data.version,
    seed: g.seed,
    moves: g.moves,
    winner: g.winner,
    reason: g.reason, // 'result' | 'maxActions' | 'cut'
    minutes: null,
    started: data.updated,
    players: [null, null],
    you: [],
  };
}

/** 클리어 기보를 대국 기보 모양으로 맞춥니다. 시계도 기권도 없고, 게임 로직(result())이 끝낸 판입니다 */
function fromClear(c) {
  return {
    game: c.game,
    version: c.version,
    seed: c.seed,
    moves: c.moves,
    winner: c.winner,
    reason: 'result',
    minutes: null,
    started: c.at,
    players: [null, null],
    you: [],
  };
}

/**
 * 시작부터 끝까지 Worker에서 모두 둬 두고(keep), 둔 수를 셉니다. 기록은 최대 5,000개라 금방입니다.
 * play()가 오류를 던진 수는 대국 때처럼 상태가 그대로입니다.
 */
async function replayAll() {
  await runner.start(rec.seed, { players: [] }, true);
  const { steps } = await runner.play(rec.moves.map((m) => ({ player: m.player, action: m.action })), { players: [] });
  moves = steps.filter((s, i) => s.changed && s.turn !== rec.moves[i].player).length;
  await loadFinal();
}

async function loadFinal() {
  final = await runner.look({ players: [], lang: playLang() }, rec.moves.length);
}

/** pos번째 수 뒤의 판을 받아 옵니다. 그사이 다른 수로 옮겼으면 받은 것을 버립니다. */
function loadView(at) {
  const want = playLang();
  if (loading?.pos === at && loading.lang === want) return;
  loading = { pos: at, lang: want };
  runner.look({ players: [0, 1], lang: want }, at).then((look) => {
    if (loading?.pos !== at || loading.lang !== want) return;
    shown = { pos: at, lang: want, look };
    loading = null;
    renderBoard();
  }).catch((err) => fail(t('match.codeFailed', { msg: err.message })));
}

// ---- 화면 ----

/** 결과 한 줄: [글, 색 class] */
function outcome() {
  const { winner, reason } = rec;
  if (['desync', 'disagree', 'limit'].includes(reason)) return [t('match.void'), 'even'];
  if (winner === null) return [t('match.draw'), 'even'];
  const side = t(winner === 0 ? 'match.first' : 'match.second');
  if (mode === 'clear') return [t('replay.clearWon', { side }), 'win'];
  if (mode === 'training') return [t('replay.sideWon', { side }), 'win'];
  return [t('replay.won', { name: playerName(winner) }), 'win'];
}

/** 왜 끝났는지. 게임 로직이 끝냈으면 마지막 상태의 result()가 쓴 이유를 보여줍니다. */
function reasonText() {
  const { winner, reason } = rec;
  const loser = winner === null ? null : 1 - winner;
  switch (reason) {
    case 'result': {
      const r = final?.result;
      if (r) return r.reason ?? '';
      return moves >= runner.info.maxActions ? t('match.reason.maxActions') : '';
    }
    case 'resign':
    case 'left':
    case 'timeout':
    case 'spam':
      return t(`replay.reason.${reason}`, { name: playerName(loser) });
    case 'cut': // 학습에서 같은 판이 되풀이되어 끊은 판
      return t('replay.reason.cut');
    default:
      return t(`match.reason.${reason}`);
  }
}

function renderStatus() {
  const el = $('#status');
  el.className = 'match-status';
  el.textContent = '';
  if (problem) {
    el.textContent = problem;
    return;
  }
  if (!runner || !final) {
    el.textContent = t('match.loading');
    return;
  }
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
}

function renderHead() {
  $('#title').textContent = rec ? nameOfGame() : '';
  const when = $('#when');
  when.hidden = !rec;
  const back = $('#back');
  back.hidden = mode !== 'training';
  back.href = `/web/training.html?game=${encodeURIComponent(trainingOf ?? '')}`;
  back.textContent = t('replay.backToTraining');
  if (!rec) return;
  const date = rec.started ? new Date(rec.started).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  if (mode === 'training') {
    when.textContent = t('replay.trainingNote', { at: minuteText(snapshot.minute), n: gameAt + 1, total: snapshot.games.length });
    return;
  }
  const timerText = rec.minutes === null ? t('timer.none') : t('timer.each', { m: rec.minutes });
  when.textContent = `${date} · ${mode === 'clear' ? t('replay.clearNote') : timerText}`;
}

function renderPlayers() {
  $('#players').hidden = !rec || !runner;
  if ($('#players').hidden) return;
  for (const p of [0, 1]) {
    $(`#p${p}-dot`).style.background = PLAYER_COLORS[p];
    const name = $(`#p${p}-name`);
    name.textContent = playerName(p) + (rec.you.includes(p) ? ` (${t('match.you')})` : '');
    name.classList.toggle('winner', rec.winner === p);
    $(`#p${p}-tag`).textContent = t(p === 0 ? 'match.first' : 'match.second');
  }
}

function renderBoard() {
  $('#board-wrap').hidden = !runner || !final;
  if ($('#board-wrap').hidden) return;
  // 받아 오는 동안은 앞서 그리던 판을 그대로 둡니다
  if (shown?.pos !== pos || shown.lang !== playLang()) loadView(pos);
  const view = shown?.look.views[viewAs] ?? { pieces: [] };
  board.draw(view, { flip: flip() });
  $('#message').textContent = view.message ?? '';
}

function renderControls() {
  $('#controls').hidden = !runner || !final;
  if ($('#controls').hidden) return;
  const n = rec.moves.length;
  $('#seek').max = String(n);
  $('#seek').value = String(pos);
  $('#position').textContent = t('replay.position', { n: pos, total: n });
  $('#first').disabled = $('#prev').disabled = pos === 0;
  $('#next').disabled = $('#last').disabled = pos === n;
  $('#play').disabled = n === 0;
  $('#play').textContent = timer ? `⏸ ${t('replay.pause')}` : `▶ ${t('replay.play')}`;
  $('#view-as').value = String(viewAs);
}

function render() {
  applyStatic(titleKey);
  if (rec) document.title = `${nameOfGame()} · ${t(titleKey)} · ${t('site.name')}`;
  renderMe(me);
  renderHead();
  renderPlayers();
  renderStatus();
  // 버전을 모르던 때의 기보(version 없음)는 비교하지 않습니다
  $('#version-note').hidden = !runner || !rec.version || rec.version === entry.version;
  renderBoard();
  renderControls();
}

// ---- 동작 ----

function go(n) {
  pos = Math.max(0, Math.min(rec.moves.length, n));
  if (pos === rec.moves.length) stop();
  render();
}

function stop() {
  clearInterval(timer);
  timer = null;
}

function togglePlay() {
  if (timer) {
    stop();
    render();
    return;
  }
  if (pos === rec.moves.length) pos = 0; // 끝에서 누르면 처음부터
  timer = setInterval(() => go(pos + 1), STEP_MS);
  render();
}

function setupControls() {
  $('#first').addEventListener('click', () => go(0));
  $('#prev').addEventListener('click', () => go(pos - 1));
  $('#next').addEventListener('click', () => go(pos + 1));
  $('#last').addEventListener('click', () => go(rec.moves.length));
  $('#play').addEventListener('click', togglePlay);
  $('#seek').addEventListener('input', (e) => {
    stop();
    go(Number(e.target.value));
  });
  $('#view-as').addEventListener('change', (e) => {
    viewAs = Number(e.target.value);
    render();
  });
  document.addEventListener('keydown', (e) => {
    if (!final || e.target.closest('input, select, button') || e.altKey || e.ctrlKey || e.metaKey) return;
    const keys = { ArrowLeft: () => go(pos - 1), ArrowRight: () => go(pos + 1), Home: () => go(0), End: () => go(rec.moves.length), ' ': togglePlay };
    if (!keys[e.key]) return;
    e.preventDefault();
    if (e.key !== ' ') stop();
    keys[e.key]();
  });
}

function fit() {
  board?.resize(Math.min(480, $('.match').clientWidth));
}

/** 기보를 둔 버전의 올린 게임 코드 주소. 지금 버전이거나 옛 코드가 없으면(레포 게임, 버전을 모르던 때의 기보) null */
async function oldModule() {
  if (!rec.version || rec.version === entry?.version) return null;
  const module = `/uploads/${encodeURIComponent(rec.game)}/${encodeURIComponent(rec.version)}/index.js`;
  const res = await fetch(module, { method: 'HEAD' }).catch(() => null);
  return res?.ok ? module : null;
}

function fail(msg) {
  problem = msg;
  render();
}

async function main() {
  // 언어를 바꾸면 게임 안 글자(message, 끝난 이유)를 그 언어로 다시 받아 옵니다
  setupLangButtons(() => {
    render();
    if (final) loadFinal().then(render).catch((err) => fail(t('match.codeFailed', { msg: err.message })));
  });
  setLang(await detectLang());
  render();
  me = await loadMe();

  const url = {
    match: `/api/matches/${encodeURIComponent(recordId)}`,
    clear: `/api/games/${encodeURIComponent(clearOf)}/clear`,
    training: `/api/ai/${encodeURIComponent(trainingOf)}/training`,
  }[mode];
  const missing = { match: 'replay.notFound', clear: 'replay.noClear', training: 'replay.noTraining' }[mode];
  const res = await fetch(url, { cache: mode === 'training' ? 'no-store' : 'default' });
  if (res.status === 401 && mode === 'training') return fail(t('training.login'));
  if (res.status === 404 || !(trainingOf ?? clearOf ?? recordId)) return fail(t(missing));
  if (!res.ok) return fail(t('replay.loadFailed', { msg: res.status }));
  rec = await res.json();
  if (mode === 'clear') rec = fromClear(rec);
  if (mode === 'training') rec = fromTraining(rec);
  if (!rec) return fail(t(missing));
  viewAs = rec.you[0] ?? 0;

  entry = (await (await fetch('/api/games')).json()).find((g) => g.id === rec.game) ?? null;
  const old = await oldModule();
  if (old) entry = { ...(entry ?? { id: rec.game, listing: null }), module: old, version: rec.version };
  if (!entry) return fail(t('replay.noGame', { id: rec.game }));
  runner = await loadGame(entry);
  board = new BoardView($('#board'), runner.info.board, runner.info.pieces);
  await replayAll();
  setupControls();
  fit();
  window.addEventListener('resize', () => {
    fit();
    render();
  });
  render();
}

main().catch((err) => fail(t('replay.loadFailed', { msg: err.message })));
