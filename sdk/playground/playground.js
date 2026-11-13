// 보드마당 플레이그라운드: 사이트에 올리기 전에 게임을 내 컴퓨터에서 돌려봅니다.
// 실제 플랫폼이 하는 일(시드, 행동 기록, 상태 해시, maxActions)을 서버 없이 흉내 냅니다.
// 두 플레이어의 화면을 나란히 보여주므로 혼자서 양쪽을 둘 수 있습니다.
//
// 판 아래 "Use as thumbnail"을 누르면 그 화면을 그대로 찍어 게임 폴더의 thumbnail.json에 저장합니다.
// 화면의 글은 영어가 기본입니다 (npm 패키지로 여러 나라 제작자가 씁니다).
// 사이트의 게임 목록은 이미지 대신 이 데이터를 보드 렌더러로 다시 그립니다.
//
// 실제 플랫폼과 다른 점: 게임 코드를 Web Worker가 아니라 이 페이지에서 바로 실행합니다.

// 한 수마다의 검사(상태, 차례, 언어, 다시 두기)는 명령줄의 검사(../check.js)와 같은 함수를 씁니다. 여기에 다시 적지 않습니다.
import {
  callGame, checkGame, checkMembers, checkThumbnail, langProblems, makeThumbnail, mutationProblems, observeProblems, replayProblems,
  sameAction, stateProblems, turnProblems,
} from '../check.js';
import { BoardView, GAME_ID, SHAPE_LIMITS, attachInput, buttonsOf, paintPlayerDot } from './board.js';
import { LANGS, LANG_NAMES, fullLangs, localize } from './listing.js';
import { hashOf, makeRng } from './platform.js';

const $ = (sel) => document.querySelector(sel);
const gameId = new URLSearchParams(location.search).get('game') || 'tictactoe';

// ---- 대국 ----

let game;
let listing = null; // 등록 정보. 없으면 null
let langs = LANGS; // 게임에 넘길 수 있는 언어 = 완전 번역 언어
let lang = 'ko'; // 지금 게임에 넘기는 언어
let boards = [];
const hover = [null, null];
const warnings = new Set();

let seed;
let state;
let stateHash;
let log; // [{ player, action, changed, back }]
let moves; // 둔 수: 차례가 넘어간 행동 수 (maxActions 기준)
let turnHashes; // 이번 차례에 나온 판의 해시들. 이미 나온 판으로 돌아가면 대전 서버처럼 무시된 행동으로 셉니다
let ignored; // 플레이어별 무시된 행동 수
let ended; // Result | null

function warn(msg) {
  warnings.add(msg);
}

/** 게임 함수 하나를 부릅니다. 오류가 나면 Checks에 알리고(어느 함수인지 붙여서) fallback을 돌려줍니다 */
function attempt(name, f, fallback) {
  try {
    return callGame(name, f);
  } catch (e) {
    warn(e.message);
    return fallback;
  }
}

function newGame(s) {
  seed = s >>> 0;
  $('#seed').value = seed;
  warnings.clear();
  state = attempt('setup()', () => game.setup(makeRng(seed)), null);
  for (const p of stateProblems(state, 'setup()')) warn(p);
  stateHash = hashOf(state);
  log = [];
  moves = 0;
  turnHashes = [stateHash];
  ignored = [0, 0];
  ended = null;
  checkResult();
  render();
}

/** 서버에서 relay가 온 것처럼 행동 하나를 적용합니다. */
function dispatch(player, action) {
  if (ended) return;

  const before = JSON.stringify(state);
  const failed = {};
  const next = attempt('play()', () => game.play(state, player, action), failed);
  if (next === failed) return render();
  for (const p of [...mutationProblems(state, before), ...stateProblems(next, 'play()')]) warn(p);

  const h = hashOf(next);
  const changed = h !== stateHash;
  // 차례가 넘어가면(판이 끝나도) 한 수입니다. 차례가 그대로인데 이번 차례에 나온 판으로 돌아가면(기물을 골랐다 바꾸기)
  // 아무것도 안 한 것과 같아서 무시된 행동으로 셉니다. 판은 그대로 바뀝니다
  const passed = changed && turnOf(next) !== player;
  const back = changed && !passed && turnHashes.includes(h);
  log.push({ player, action, changed, back });
  if (passed) {
    moves++;
    turnHashes = [h];
  } else if (!changed || back) ignored[player]++;
  else turnHashes.push(h);
  state = next;
  stateHash = h;

  checkReplay();
  checkResult();
  checkTurn();
  checkLangs();
  render();
}

/** 그 판에서 둘 차례인 플레이어. 오류면 null (그러면 상태를 바꾼 행동마다 한 수). 오류는 checkTurn이 알립니다 */
function turnOf(s) {
  try {
    return game.turn(s);
  } catch {
    return null;
  }
}

/** turn()은 0, 1, null만 돌려줘야 합니다. 플랫폼이 대국 시계를 이걸로 돌립니다. */
function checkTurn() {
  const failed = {};
  const t = attempt('turn()', () => game.turn(state), failed);
  if (t !== failed) for (const p of turnProblems(t, !!ended)) warn(p);
}

/** 끝났는지 확인합니다. maxActions에 이르면 플랫폼이 무승부로 끝냅니다. */
function checkResult() {
  let r = attempt('result()', () => game.result(state, lang), null);
  if (!r && moves >= game.maxActions) r = { winner: null, reason: 'maxActions' };
  if (r) ended = r;
}

/** 승자와 판 그림은 lang과 상관없이 같아야 합니다. 글자(message, reason)만 언어마다 다릅니다. */
function checkLangs() {
  try {
    for (const p of langProblems(game, state, langs)) warn(p);
  } catch {
    // 오류는 render와 checkResult에서 이미 알렸습니다.
  }
}

/** 같은 시드와 같은 행동으로 처음부터 다시 둬서 같은 상태가 나오는지 봅니다. */
function checkReplay() {
  if (log.length > 500) return;
  try {
    for (const p of replayProblems(game, seed, log, stateHash)) warn(p);
  } catch {
    // 오류는 dispatch에서 이미 알렸습니다.
  }
}

function undo() {
  if (!log.length) return;
  const keep = log.slice(0, -1);
  newGame(seed);
  for (const { player, action } of keep) dispatch(player, action);
}

function resign(player) {
  if (ended) return;
  ended = { winner: 1 - player, reason: 'resign' };
  render();
}

function legalOf(player) {
  if (!game.legal || ended) return null;
  return attempt('legal()', () => game.legal(state, player), null);
}

// ---- 랜덤 대국: 업로드 검사의 실행 단계를 그대로 해봅니다 (npx boardmadang check와 같음) ----

function randomGames(n) {
  // 지금 고른 언어를 먼저 두고, 나머지 완전 번역 언어로 판 그림과 승자가 같은지도 봅니다
  const { problems, warnings: more, stats } = checkGame(game, { n, langs: [lang, ...langs.filter((l) => l !== lang)] });
  for (const w of [...problems, ...more]) warn(w);
  if (!stats) return render();

  const { tally } = stats;
  const pct = (x) => `${Math.round((x / stats.n) * 100)}%`;
  $('#random-result').innerHTML = `
    <table>
      <tr><th>Games</th><td>${stats.n}</td></tr>
      <tr><th>Player 0 won</th><td>${tally[0]} (${pct(tally[0])})</td></tr>
      <tr><th>Player 1 won</th><td>${tally[1]} (${pct(tally[1])})</td></tr>
      <tr><th>Draws</th><td>${tally.draw} (${pct(tally.draw)})</td></tr>
      <tr><th>Hit maxActions</th><td>${tally.maxActions}</td></tr>
      <tr><th>Got stuck</th><td>${tally.stuck + tally.noLegal}</td></tr>
      <tr><th>Average length</th><td>${stats.avgMoves.toFixed(1)} moves</td></tr>
      <tr><th>play() time</th><td>${stats.avgMs.toFixed(3)}ms average · ${stats.maxMs.toFixed(2)}ms max</td></tr>
    </table>`;
  render();
}

// ---- 썸네일: 지금 화면을 그대로 찍어 thumbnail.json에 저장합니다 ----

/** 썸네일 미리보기. 게임 목록과 같은 방법으로 thumbnail.json만 보고 그립니다. */
function showThumbnail(thumb, note) {
  const canvas = $('#thumb');
  canvas.hidden = !thumb;
  if (thumb) {
    const board = new BoardView(canvas, thumb.board, thumb.pieces);
    board.resize(220);
    board.draw(thumb.view, { flip: thumb.board.flipForPlayer === thumb.player });
  }
  $('#thumb-status').textContent = note;
}

async function snapshot(player) {
  const failed = {};
  const view = attempt('view()', () => game.view(state, player, lang), failed);
  if (view === failed) return render();
  const thumb = makeThumbnail(game, player, view);
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(gameId)}/thumbnail`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(thumb),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.problems?.join(' / ') ?? body.error ?? `HTTP ${res.status}`);
    showThumbnail(thumb, `Saved player ${player}'s board as the thumbnail (thumbnail.json, after ${log.length} moves).`);
  } catch (e) {
    $('#thumb-status').textContent = `Couldn't save the thumbnail: ${e.message}`;
  }
}

// ---- 화면 ----

function fmtAction(a) {
  return a.kind === 'click' ? `click (${a.row}, ${a.col})` : a.kind;
}

function render() {
  for (const p of [0, 1]) {
    const panel = $(`#player-${p}`);
    const view = attempt('view()', () => game.view(state, p, lang), null) ?? { pieces: [] };
    boards[p].draw(view, { flip: game.board.flipForPlayer === p, hover: hover[p], myTurn: !ended && turnOf(state) === p });
    panel.querySelector('.message').textContent = view.message ?? '';
    for (const b of panel.querySelectorAll('button:not(.snapshot)')) b.disabled = !!ended;
    renderSpecials(p, panel.querySelector('.specials'), view);
  }

  const status = $('#status');
  if (ended) {
    const who = ended.winner === null ? 'draw' : `player ${ended.winner} won`;
    status.textContent = `Game over: ${who}${ended.reason ? ` (${ended.reason})` : ''}`;
    status.className = 'status ended';
  } else {
    status.textContent = 'Playing';
    status.className = 'status';
  }
  $('#counts').textContent = `Moves (the turn passed): ${moves} / ${game.maxActions} · ignored: P0 ${ignored[0]}, P1 ${ignored[1]} · hash ${stateHash}`;

  const logEl = $('#log');
  logEl.innerHTML = '';
  log.forEach((e, i) => {
    const li = document.createElement('li');
    const note = !e.changed ? ' (ignored)' : e.back ? ' (back to a position from this turn: counted as ignored)' : '';
    li.textContent = `#${i} P${e.player} ${fmtAction(e.action)}${note}`;
    if (note) li.className = 'ignored';
    logEl.prepend(li);
  });

  $('#state').textContent = JSON.stringify(state, null, 1);

  try {
    for (const p of observeProblems(game, state)) warn(p);
  } catch (e) {
    warn(e.message); // observe()가 던진 오류
  }

  const checks = $('#checks');
  checks.innerHTML = '';
  if (!warnings.size) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = 'No problems so far';
    checks.append(li);
  }
  for (const w of warnings) {
    const li = document.createElement('li');
    li.className = 'bad';
    li.textContent = w;
    checks.append(li);
  }
}

/**
 * 한 플레이어의 특수 행동 버튼. 사이트와 같은 규칙입니다 (board.js의 buttonsOf):
 * view()의 buttons가 있으면 그 글자와 순서로, legal()에 없는 버튼은 흐리게. 없으면 특수 행동 이름 그대로.
 * 버튼 목록(행동과 글자)이 바뀔 때만 다시 만듭니다 (호버마다 다시 그려도 누르던 버튼이 그대로 있게).
 */
function renderSpecials(p, box, view) {
  const buttons = buttonsOf(game.specialActions ?? [], view, ended ? null : legalOf(p));
  const key = JSON.stringify(buttons.map((b) => [b.kind, b.label]));
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.replaceChildren(...buttons.map(({ kind, label }) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => dispatch(p, { kind }));
      return b;
    }));
  }
  buttons.forEach((x, i) => {
    box.children[i].disabled = !!ended || x.disabled;
  });
}

function buildPanels() {
  const wrap = $('#boards');
  for (const p of [0, 1]) {
    const panel = document.createElement('section');
    panel.className = 'player';
    panel.id = `player-${p}`;
    panel.innerHTML = `
      <h2><span class="dot p${p}"></span>Player ${p} <small>${p === 0 ? 'moves first' : 'moves second'}</small></h2>
      <canvas></canvas>
      <p class="message"></p>
      <div class="actions"></div>`;
    paintPlayerDot(panel.querySelector('.dot'), game.pieces, game.playerPieces, p);
    const actions = panel.querySelector('.actions');
    // 특수 행동 버튼 자리. 버튼은 화면(view)의 buttons에 따라 renderSpecials가 채웁니다
    const specials = document.createElement('span');
    specials.className = 'specials';
    actions.append(specials);
    const r = document.createElement('button');
    r.textContent = 'Resign';
    r.className = 'secondary';
    r.addEventListener('click', () => resign(p));
    actions.append(r);
    const shot = document.createElement('button');
    shot.textContent = 'Use as thumbnail';
    shot.className = 'secondary snapshot';
    shot.title = "Save this player's board as the picture in the game list";
    shot.addEventListener('click', () => snapshot(p));
    actions.append(shot);
    wrap.append(panel);

    const canvas = panel.querySelector(':scope > canvas'); // 제목의 플레이어 기물 그림(캔버스)이 아니라 판
    const board = new BoardView(canvas, game.board, game.pieces);
    const flip = game.board.flipForPlayer === p;
    attachInput(board, canvas, {
      flip: () => flip,
      // legal()이 있으면 둘 수 있는 곳에만 호버를 보여줍니다.
      canHover: (cell) => {
        const legal = legalOf(p);
        return legal ? legal.some((a) => sameAction(a, { kind: 'click', ...cell })) : !ended;
      },
      click: (cell) => dispatch(p, { kind: 'click', ...cell }),
      hover: (cell) => {
        hover[p] = cell;
        render();
      },
    });
    boards.push(board);
  }
}

function fit() {
  const panel = $('#player-0');
  const max = Math.min(420, panel.clientWidth - 24);
  for (const b of boards) b.resize(max);
  if (log) render();
}

/** 게임 안 글자 언어 고르기. 등록창에서 완전 번역으로 고른 언어만 고를 수 있습니다. */
function setupLang(wanted) {
  if (listing) langs = fullLangs(listing);
  lang = [wanted, navigator.language?.slice(0, 2), 'en'].find((l) => langs.includes(l)) ?? langs[0];
  const select = $('#lang');
  select.replaceChildren(...langs.map((l) => new Option(LANG_NAMES[l], l, false, l === lang)));
  select.disabled = langs.length < 2;
  select.addEventListener('change', () => {
    lang = select.value;
    const q = new URLSearchParams(location.search);
    q.set('lang', lang);
    history.replaceState(null, '', `?${q}`);
    showTitle();
    checkResult();
    render();
  });
  showTitle();
}

function showTitle() {
  const name = localize(listing?.name, lang).text || game.id;
  document.title = `${name} · boardmadang playground`;
  $('#title').textContent = name;
  const leftover = ['name', 'description', 'difficulty'].filter((k) => k in game);
  $('#meta').textContent = [
    `${game.id} · ${game.board.rows}×${game.board.cols} ${game.board.places === 'points' ? 'points' : 'cells'} · maxActions ${game.maxActions}`,
    listing ? null : 'No listing.json yet: add a name, rules, and languages (for now, every language is tried)',
    leftover.length ? `${leftover.join(', ')} now belong in listing.json, not in the game code` : null,
  ].filter(Boolean).join(' · ');
}

async function main() {
  if (!GAME_ID.test(gameId)) throw new Error(`game may use only lowercase letters, numbers, and - (up to ${SHAPE_LIMITS.idChars} characters)`);
  // 개발 서버가 games/<id>와 깃허브에 올리지 않는 games/private/<id>를 찾아 등록 정보와 같이 알려줍니다.
  const entry = (await (await fetch('/api/games')).json()).find((g) => g.id === gameId);
  if (!entry) throw new Error("the dev server couldn't find this game");
  listing = entry.listing;
  game = (await import(entry.module)).default;
  const problems = checkMembers(game ?? {});
  if (problems.length) {
    $('#fatal').hidden = false;
    $('#fatal').innerHTML = `<b>Can't start: the game module has problems.</b><ul>${problems.map((x) => `<li>${x}</li>`).join('')}</ul>`;
    return;
  }

  setupLang(new URLSearchParams(location.search).get('lang'));
  if (entry.thumbnail) {
    showThumbnail(entry.thumbnail, 'This is the current thumbnail. To change it, press "Use as thumbnail" under a board.');
    for (const p of checkThumbnail(game, entry.thumbnail)) warn(p);
  }

  buildPanels();

  $('#restart').addEventListener('click', () => newGame(Number($('#seed').value) || 0));
  $('#newseed').addEventListener('click', () => newGame((Math.random() * 2 ** 32) >>> 0));
  $('#undo').addEventListener('click', undo);
  $('#random').addEventListener('click', () => randomGames(200));
  window.addEventListener('resize', fit);

  fit();
  newGame((Math.random() * 2 ** 32) >>> 0);
}

main().catch((e) => {
  $('#fatal').hidden = false;
  $('#fatal').textContent = `Couldn't load the game (${gameId}/index.js): ${e.message}`;
});
