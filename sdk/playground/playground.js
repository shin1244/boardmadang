// 보드마당 플레이그라운드: 사이트에 올리기 전에 게임을 내 컴퓨터에서 돌려봅니다.
// 실제 플랫폼이 하는 일(시드, 행동 기록, 상태 해시, maxActions)을 서버 없이 흉내 냅니다.
// 두 플레이어의 화면을 나란히 보여주므로 혼자서 양쪽을 둘 수 있습니다.
//
// 판 아래 「썸네일로」를 누르면 그 화면을 그대로 찍어 게임 폴더의 thumbnail.json에 저장합니다.
// 사이트의 게임 목록은 이미지 대신 이 데이터를 보드 렌더러로 다시 그립니다.
//
// 실제 플랫폼과 다른 점: 게임 코드를 Web Worker가 아니라 이 페이지에서 바로 실행합니다.

import { checkGame, checkMembers, checkThumbnail, findNonJson, makeThumbnail, sameAction } from '../check.js';
import { BoardView } from './board.js';
import { LANGS, LANG_NAMES, fullLangs, localize } from './listing.js';
import { hashOf, makeRng } from './platform.js';

const $ = (sel) => document.querySelector(sel);
const gameId = new URLSearchParams(location.search).get('game') || 'tictactoe';

// ---- 플랫폼 도구 (검사는 ../check.js에 있고 명령줄과 같이 씁니다) ----

function fmtAction(a) {
  return a.kind === 'click' ? `클릭 (${a.row}, ${a.col})` : a.kind;
}

// ---- 대국 ----

let game;
let listing = null; // 등록 정보. 없으면 null
let langs = LANGS; // 게임에 넘길 수 있는 언어 = 완전 번역 언어
let lang = 'ko'; // 지금 게임에 넘기는 언어
let boards = [];
const hover = [null, null];
const warnings = new Set();
const playMs = [];

let seed;
let state;
let stateHash;
let log; // [{ player, action, changed }]
let effective; // 상태를 바꾼 행동 수 (maxActions 기준)
let ignored; // 플레이어별 무시된 행동 수
let ended; // Result | null

function warn(msg) {
  warnings.add(msg);
}

function newGame(s) {
  seed = s >>> 0;
  $('#seed').value = seed;
  warnings.clear();
  playMs.length = 0;
  try {
    state = game.setup(makeRng(seed));
  } catch (e) {
    warn(`setup()에서 오류: ${e.message}`);
    state = null;
  }
  const bad = findNonJson(state);
  if (bad) warn(`setup()이 돌려준 state에 JSON이 아닌 값이 있습니다: ${bad}`);
  stateHash = hashOf(state);
  log = [];
  effective = 0;
  ignored = [0, 0];
  ended = null;
  checkResult();
  render();
}

/** 서버에서 relay가 온 것처럼 행동 하나를 적용합니다. */
function dispatch(player, action) {
  if (ended) return;

  const before = JSON.stringify(state);
  let next;
  try {
    const t = performance.now();
    next = game.play(state, player, action);
    playMs.push(performance.now() - t);
  } catch (e) {
    warn(`play()에서 오류: ${e.message}`);
    render();
    return;
  }
  if (JSON.stringify(state) !== before) warn('play()가 받은 state를 고쳤습니다. 복사해서 새 상태를 돌려주세요.');
  const bad = findNonJson(next);
  if (bad) warn(`play()가 돌려준 state에 JSON이 아닌 값이 있습니다: ${bad}`);

  const h = hashOf(next);
  const changed = h !== stateHash;
  log.push({ player, action, changed });
  if (changed) effective++;
  else ignored[player]++;
  state = next;
  stateHash = h;

  checkReplay();
  checkResult();
  checkTurn();
  checkLangs();
  render();
}

/** turn()은 0, 1, null만 돌려줘야 합니다. 플랫폼이 대국 시계를 이걸로 돌립니다. */
function checkTurn() {
  if (!game.turn) return;
  let t;
  try {
    t = game.turn(state);
  } catch (e) {
    warn(`turn()에서 오류: ${e.message}`);
    return;
  }
  if (t !== 0 && t !== 1 && t !== null) warn(`turn()은 0, 1, null 중 하나여야 합니다 (받은 값: ${JSON.stringify(t)})`);
  if (ended && t !== null) warn('끝난 판에서는 turn()이 null이어야 시계가 멈춥니다.');
}

/** 끝났는지 확인합니다. maxActions에 이르면 플랫폼이 무승부로 끝냅니다. */
function checkResult() {
  let r = null;
  try {
    r = game.result(state, lang);
  } catch (e) {
    warn(`result()에서 오류: ${e.message}`);
  }
  if (!r && effective >= game.maxActions) r = { winner: null, reason: 'maxActions' };
  if (r) ended = r;
}

/** 승자와 판 그림은 lang과 상관없이 같아야 합니다. 글자(message, reason)만 언어마다 다릅니다. */
function checkLangs() {
  if (langs.length < 2) return;
  try {
    const drawn = (p, l) => JSON.stringify({ ...game.view(state, p, l), message: undefined });
    const winner = (l) => { const r = game.result(state, l); return r ? String(r.winner) : '-'; };
    for (const p of [0, 1]) {
      if (langs.some((l) => drawn(p, l) !== drawn(p, langs[0]))) {
        warn('view()가 lang에 따라 message 말고 다른 것도 바꿉니다. 판 그림은 언어와 상관없이 같아야 합니다.');
      }
    }
    if (langs.some((l) => winner(l) !== winner(langs[0]))) warn('result()가 lang에 따라 다른 승자를 돌려줍니다.');
  } catch {
    // 오류는 render와 checkResult에서 이미 알렸습니다.
  }
}

/** 같은 시드와 같은 행동으로 처음부터 다시 둬서 같은 상태가 나오는지 봅니다. */
function checkReplay() {
  if (log.length > 500) return;
  try {
    let s = game.setup(makeRng(seed));
    for (const { player, action } of log) s = game.play(s, player, action);
    if (hashOf(s) !== stateHash) {
      warn('같은 시드·같은 행동으로 다시 뒀더니 상태가 다릅니다. Math.random()이나 Date.now()를 쓰고 있지 않은지 확인하세요.');
    }
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
  try {
    return game.legal(state, player);
  } catch (e) {
    warn(`legal()에서 오류: ${e.message}`);
    return null;
  }
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
      <tr><th>판 수</th><td>${stats.n}</td></tr>
      <tr><th>플레이어 0 승</th><td>${tally[0]} (${pct(tally[0])})</td></tr>
      <tr><th>플레이어 1 승</th><td>${tally[1]} (${pct(tally[1])})</td></tr>
      <tr><th>무승부</th><td>${tally.draw} (${pct(tally.draw)})</td></tr>
      <tr><th>maxActions 도달</th><td>${tally.maxActions}</td></tr>
      <tr><th>진행 불가</th><td>${tally.stuck + tally.noLegal}</td></tr>
      <tr><th>평균 길이</th><td>${stats.avgMoves.toFixed(1)}수</td></tr>
      <tr><th>play() 시간</th><td>평균 ${stats.avgMs.toFixed(3)}ms · 최대 ${stats.maxMs.toFixed(2)}ms</td></tr>
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
  let view;
  try {
    view = game.view(state, player, lang);
  } catch (e) {
    warn(`view()에서 오류: ${e.message}`);
    return render();
  }
  const thumb = makeThumbnail(game, player, view);
  try {
    const res = await fetch(`/api/games/${encodeURIComponent(gameId)}/thumbnail`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(thumb),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.problems?.join(' / ') ?? body.error ?? `HTTP ${res.status}`);
    showThumbnail(thumb, `플레이어 ${player} 화면을 썸네일로 저장했습니다 (thumbnail.json, 행동 ${log.length}개 둔 판).`);
  } catch (e) {
    $('#thumb-status').textContent = `썸네일을 저장하지 못했습니다: ${e.message}`;
  }
}

// ---- 화면 ----

function render() {
  for (const p of [0, 1]) {
    const panel = $(`#player-${p}`);
    let view = { pieces: [] };
    try {
      view = game.view(state, p, lang) ?? view;
    } catch (e) {
      warn(`view()에서 오류: ${e.message}`);
    }
    boards[p].draw(view, { flip: game.board.flipForPlayer === p, hover: hover[p] });
    panel.querySelector('.message').textContent = view.message ?? '';
    for (const b of panel.querySelectorAll('button:not(.snapshot)')) b.disabled = !!ended;
  }

  const status = $('#status');
  if (ended) {
    const who = ended.winner === null ? '무승부' : `플레이어 ${ended.winner} 승`;
    status.textContent = `끝: ${who}${ended.reason ? ` (${ended.reason})` : ''}`;
    status.className = 'status ended';
  } else {
    status.textContent = '진행 중';
    status.className = 'status';
  }
  $('#counts').textContent = `상태를 바꾼 행동 ${effective} / ${game.maxActions} · 무시된 행동 P0 ${ignored[0]} · P1 ${ignored[1]} · 해시 ${stateHash}`;

  const logEl = $('#log');
  logEl.innerHTML = '';
  log.forEach((e, i) => {
    const li = document.createElement('li');
    li.textContent = `#${i} P${e.player} ${fmtAction(e.action)}${e.changed ? '' : ' — 무시됨'}`;
    if (!e.changed) li.className = 'ignored';
    logEl.prepend(li);
  });

  $('#state').textContent = JSON.stringify(state, null, 1);

  if (game.observe) {
    try {
      const o = game.observe(state, 0);
      const { rows, cols } = game.board;
      const ok = Array.isArray(o) && o.every((ch) => Array.isArray(ch) && ch.length === rows
        && ch.every((row) => Array.isArray(row) && row.length === cols && row.every((x) => typeof x === 'number')));
      if (!ok) warn(`observe()는 [채널][${rows}][${cols}] 모양의 숫자 배열이어야 합니다.`);
    } catch (e) {
      warn(`observe()에서 오류: ${e.message}`);
    }
  }

  const checks = $('#checks');
  checks.innerHTML = '';
  if (!warnings.size) {
    const li = document.createElement('li');
    li.className = 'ok';
    li.textContent = '지금까지 문제 없음';
    checks.append(li);
  }
  for (const w of warnings) {
    const li = document.createElement('li');
    li.className = 'bad';
    li.textContent = w;
    checks.append(li);
  }
}

function buildPanels() {
  const wrap = $('#boards');
  for (const p of [0, 1]) {
    const panel = document.createElement('section');
    panel.className = 'player';
    panel.id = `player-${p}`;
    panel.innerHTML = `
      <h2><span class="dot p${p}"></span>플레이어 ${p} 화면 <small>${p === 0 ? '선공' : '후공'}</small></h2>
      <canvas></canvas>
      <p class="message"></p>
      <div class="actions"></div>`;
    const actions = panel.querySelector('.actions');
    for (const kind of game.specialActions ?? []) {
      const b = document.createElement('button');
      b.textContent = kind;
      b.addEventListener('click', () => dispatch(p, { kind }));
      actions.append(b);
    }
    const r = document.createElement('button');
    r.textContent = '기권';
    r.className = 'secondary';
    r.addEventListener('click', () => resign(p));
    actions.append(r);
    const shot = document.createElement('button');
    shot.textContent = '썸네일로';
    shot.className = 'secondary snapshot';
    shot.title = '이 플레이어 화면을 그대로 찍어 게임 목록의 썸네일로 씁니다';
    shot.addEventListener('click', () => snapshot(p));
    actions.append(shot);
    wrap.append(panel);

    const canvas = panel.querySelector('canvas');
    const board = new BoardView(canvas, game.board, game.pieces);
    const flip = game.board.flipForPlayer === p;
    canvas.addEventListener('click', (e) => {
      const cell = board.cellAt(e, flip);
      if (cell) dispatch(p, { kind: 'click', ...cell });
    });
    canvas.addEventListener('mousemove', (e) => {
      const cell = board.cellAt(e, flip);
      const legal = cell && legalOf(p);
      // legal()이 있으면 둘 수 있는 곳에만 호버를 보여줍니다.
      const ok = cell && (legal ? legal.some((a) => sameAction(a, { kind: 'click', ...cell })) : !ended);
      const next = ok ? cell : null;
      canvas.style.cursor = ok ? 'pointer' : 'default';
      if (next?.row !== hover[p]?.row || next?.col !== hover[p]?.col) {
        hover[p] = next;
        render();
      }
    });
    canvas.addEventListener('mouseleave', () => {
      hover[p] = null;
      render();
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
  lang = langs.includes(wanted) ? wanted : langs[0];
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
  document.title = `${name} · 보드마당 플레이그라운드`;
  $('#title').textContent = name;
  const leftover = ['name', 'description', 'difficulty'].filter((k) => k in game);
  $('#meta').textContent = [
    `${game.id} · ${game.board.rows}×${game.board.cols} ${game.board.places === 'points' ? '교차점' : '칸'} · maxActions ${game.maxActions}`,
    listing ? null : '등록 정보 없음: 게임 등록 화면에서 이름, 룰북, 지원 언어를 입력하세요 (지금은 모든 언어로 둬봅니다)',
    leftover.length ? `${leftover.join(', ')}은(는) 이제 게임 코드가 아니라 등록 정보에 씁니다` : null,
  ].filter(Boolean).join(' · ');
}

async function main() {
  if (!/^[a-z0-9-]+$/.test(gameId)) throw new Error('game 이름은 영문 소문자, 숫자, -만 됩니다');
  // 개발 서버가 games/<id>와 깃허브에 올리지 않는 games/private/<id>를 찾아 등록 정보와 같이 알려줍니다.
  const entry = (await (await fetch('/api/games')).json()).find((g) => g.id === gameId);
  if (!entry) throw new Error('개발 서버가 이 게임을 찾지 못했습니다');
  listing = entry.listing;
  game = (await import(entry.module)).default;
  const problems = checkMembers(game ?? {});
  if (problems.length) {
    $('#fatal').hidden = false;
    $('#fatal').innerHTML = `<b>게임 모듈에 문제가 있어 시작할 수 없습니다.</b><ul>${problems.map((x) => `<li>${x}</li>`).join('')}</ul>`;
    return;
  }

  setupLang(new URLSearchParams(location.search).get('lang'));
  if (entry.thumbnail) {
    showThumbnail(entry.thumbnail, '지금 썸네일입니다. 다른 화면으로 바꾸려면 판 아래 「썸네일로」를 누르세요.');
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
  $('#fatal').textContent = `게임을 불러오지 못했습니다 (${gameId}/index.js): ${e.message}`;
});
