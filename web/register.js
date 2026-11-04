// 게임 등록창: 네 단계로 나눕니다.
//   1단계: 게임 코드. 사이트에서는 npx boardmadang pack이 만든 zip을 초안으로 올리고(POST /api/drafts),
//          게임 실행기(engine.js)의 샌드박스 안에서 자동 검사(sdk/check.js)를 돌립니다.
//          개발 서버에서는 games/ 폴더의 게임을 고릅니다.
//   2단계: 직접 깨기 (사이트만). 혼자 양쪽을 둬서 result()가 승자를 정해야 넘어갑니다 (슈퍼 마리오 메이커 2의 클리어 체크).
//          이긴 판(시드, 상태를 바꾼 행동, 코드 버전)은 제작자 클리어 기보로 남습니다 (server/internal/upload/clear.go).
//          같은 판에서 로비 썸네일도 찍습니다.
//   3단계: 난이도, 타이머, 지원 언어 (일부 번역 / 완전 번역으로 나눠 언어를 고릅니다)
//   4단계: 고른 언어마다 이름, 소개, 룰북
// 사이트에서는 등록(POST /api/drafts/<초안>/publish)하면 바로 로비에 나옵니다 (server/internal/upload).
// 이미 올린 게임은 내 프로필(history.html)의 "내가 올린 게임"에서 고치거나 내립니다.
// 등록 정보 고치기는 이 화면을 ?edit=<id>로 열어 3, 4단계만 거칩니다 (PATCH /api/uploads/<id>).
// 개발 서버에서는 PUT /api/games/<id>/listing 으로 games/<id>/listing.json 에 저장합니다.
// 어느 쪽인지는 GET /api/uploads로 압니다. 개발 서버에는 없어서 404입니다.
//
// 자동 검사와 직접 깨기는 이 브라우저에서 돌기 때문에 서버는 결과를 믿지 않습니다 (모양만 봅니다).
// 검사는 올리는 사람이 문제를 미리 알게 하려는 것이고, 클리어는 적어도 한 번은 끝까지 둘 수 있는 게임이라는 표시입니다.

import { BoardView, PLAYER_COLORS } from '/sdk/playground/board.js';
import { LANGS, LANG_NAMES, LIMITS, NO_TIMER, TIMER_MINUTES, fullLangs, gameLang, isRtl, localize, validateListing } from '/sdk/playground/listing.js';
import { makeThumbnail, sameAction, validateThumbnail } from '/sdk/check.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { loadGame } from './engine.js';
import { isMember, loadMe, renderMe, suspendedText } from './me.js';

const $ = (sel) => document.querySelector(sel);
const TEXT_FIELDS = ['name', 'description', 'rulebook'];
/** 타이머를 정한 적 없는 게임에 처음 보여주는 값 */
const DEFAULT_TIMER = { minutes: 10, custom: true };
/** 자동 검사에서 두는 랜덤 대국 수 (npx boardmadang check는 200판) */
const CHECK_GAMES = 100;
/** 게임 id 길이. 대전 서버가 받는 길이입니다 */
const MAX_ID = 40;
/** 단계 번호. 직접 깨기는 사이트에서만 합니다 (stepsOf) */
const STEP = { file: 1, clear: 2, langs: 3, texts: 4 };
const BOARD_PX = 420;
const THUMB_PX = 180;

let me = null;
/** 'site'면 zip을 올려 등록, 'dev'면 개발 서버에서 games/의 게임 등록 정보를 고칩니다. 알기 전에는 null */
let mode = null;
/** /api/games */
let games = [];
/** 사이트: GET /api/uploads. 내가 올린 게임(로비 항목 + published, hidden)과 오늘 남은 등록 횟수 */
let mine = null;
/** 사이트: ?edit=<id>로 열었는데 내 게임에 그 id가 없음 */
let editMissing = false;
/**
 * 사이트: 올린 zip과 검사.
 * @type {{ state: 'uploading' | 'failed' | 'checking' | 'done', draft?: object, info?: object, check?: object,
 *          problems?: object[], msg?: string } | null}
 */
let upload = null;
/**
 * 등록할 게임 { id, listing, ... }. 사이트에서는 검사를 마친 초안이고 개발 서버에서는 games의 항목입니다.
 * 사이트에서 내 게임의 등록 정보만 고칠 때는 mine의 항목에 edit: true를 붙인 것입니다 (직접 깨기 없이 3, 4단계만)
 */
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
/** 게임 코드에 turn()이 있는지. 불러오는 중이면 null */
let hasTurn = null;
/**
 * 2단계: 혼자 두는 판. 초안을 실행기에 불러 두고 양쪽을 번갈아 둡니다.
 * moves에는 상태를 바꾼 행동만 남깁니다. 무시된 행동은 판에 영향이 없어서 다시 둘 때도, 클리어 기보에도 넣지 않습니다.
 * trail은 moves마다 그 뒤 판의 해시와 차례가 넘어갔는지(한 수인지), startHash는 시작 판의 해시입니다.
 * @type {{ draft: object, runner: object | null, seed: number, moves: { player: 0 | 1, action: object }[], seat: 0 | 1,
 *          trail: { hash: string, passed: boolean }[], startHash: string,
 *          look: object | null, ended: { winner: 0 | 1 | null, reason?: string, maxActions?: boolean } | null,
 *          busy: boolean, note: string, error: string } | null}
 */
let play = null;
/** 이긴 판 { version, seed, moves, winner, turns }. turns(둔 수)는 화면에만 쓰고 나머지를 등록할 때 보냅니다. 다른 zip을 올리면 버립니다 */
let cleared = null;
/** 등록할 썸네일 { data, from: 'zip' | 'kept' | 'shot', moves? }. null이면 썸네일 없이 (로비는 시작 판을 그립니다) */
let thumb = null;
/** 썸네일로 찍지 못한 이유 */
let thumbProblem = '';
let board = null; // 2단계 판 (BoardView)
let boardPx = 0;
let hover = null;

// ---- 1단계 (사이트): zip 올리기와 자동 검사 ----

async function uploadZip(file) {
  // 내 게임을 고치다가 zip을 올리면 고치던 글을 버리고 새 zip의 등록 정보로 채웁니다
  if (current?.edit) {
    if (dirty && !confirm(t('register.discard'))) {
      $('#zip').value = '';
      return;
    }
    dirty = false;
  }
  // 새로 고쳐도 고치기로 돌아가지 않게 주소의 ?edit=를 뗍니다
  if (new URLSearchParams(location.search).has('edit')) history.replaceState(null, '', location.pathname);
  editMissing = false;
  const u = { state: 'uploading' };
  upload = u;
  current = null;
  saveState = null;
  closePlay();
  render();
  try {
    const res = await fetch('/api/drafts', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file });
    const body = await res.json().catch(() => ({}));
    if (upload !== u) return;
    if (!res.ok) {
      Object.assign(u, { state: 'failed', problems: body.problems ?? [], msg: uploadError(res.status, body) });
      return render();
    }
    Object.assign(u, { state: 'checking', draft: body });
  } catch (err) {
    if (upload !== u) return;
    Object.assign(u, { state: 'failed', problems: [], msg: err.message });
    return render();
  }
  render();
  await checkDraft(u);
}

function uploadError(status, body) {
  if (status === 403 && body.error === 'member only') return t('register.memberOnly');
  if (status === 403 && body.error === 'suspended') return t('suspended');
  if (status === 429) return t('register.upload.tooMany');
  if (body.error === 'problems') return t('register.upload.problems');
  return body.error ?? String(status);
}

/** 초안을 실행기에 불러와 검사합니다. 그사이 다른 zip을 올리면 결과를 버립니다. */
async function checkDraft(u) {
  const { draft } = u;
  let runner = null;
  try {
    runner = await loadGame({ module: draft.module });
    u.info = runner.info;
    // zip에 썸네일이 없으면 지금 등록된 내 게임(내린 게임도)의 썸네일이 새 코드와도 맞는지 봅니다. 맞으면 그대로 씁니다
    u.prior = draft.thumbnail ? null : myGame(u.info.id)?.thumbnail ?? null;
    const langs = fullLangs(draft.listing);
    u.check = await runner.check({ n: CHECK_GAMES, langs: langs.length ? langs : [lang], thumbnail: draft.thumbnail ?? u.prior });
  } catch (err) {
    u.check = { problems: [err.message], warnings: [], stats: null, thumbnail: null };
  } finally {
    runner?.close();
  }
  if (upload !== u) return;
  u.state = 'done';
  if (u.info && !siteProblems(u).length) {
    const id = u.info.id;
    current = { id, draft, listing: draft.listing ?? myGame(id)?.listing ?? null };
    // zip의 썸네일(서버 검사를 통과한 것)이나 지금 등록된 썸네일은 게임 코드와 맞을 때만 씁니다. 2단계에서 바꿀 수 있습니다
    const fits = Array.isArray(u.check.thumbnail) && !u.check.thumbnail.length;
    thumb = !fits ? null : draft.thumbnail ? { data: draft.thumbnail, from: 'zip' } : u.prior ? { data: u.prior, from: 'kept' } : null;
    // 이미 쓰던 글이 있으면 그대로 둡니다 (코드만 고쳐서 다시 올린 경우)
    if (!dirty) fill(current.listing);
    hasTurn = u.info.turn;
  }
  render();
}

/** 내가 올린 게임 (내린 게임도). 없으면 null */
const myGame = (id) => mine?.games.find((g) => g.id === id) ?? null;

/** 이 게임이 사이트에서 어떤 것인지: 'new' 새 게임, 'update' 내 게임의 새 버전, 'same' 이미 등록한 버전, 'taken' 남의 id */
function kindOf(u) {
  const id = u.info?.id;
  const my = myGame(id);
  if (my) return my.version === u.draft.version ? 'same' : 'update';
  return games.some((g) => g.id === id) ? 'taken' : 'new';
}

/** 고쳐야 다음 단계로 갈 수 있는 것. 검사(check.js)의 글은 영어 그대로입니다 (npx boardmadang check와 같은 글). */
function siteProblems(u) {
  if (u.state === 'failed') return u.problems.map(uploadProblemText);
  if (u.state !== 'done') return [];
  const list = [...u.check.problems];
  const id = u.info?.id ?? '';
  if (id.length > MAX_ID) list.push(t('register.check.longId', { max: MAX_ID }));
  if (u.info && kindOf(u) === 'taken') list.push(t('register.check.taken', { id }));
  if (u.info && kindOf(u) === 'new' && mine?.newLeft === 0) list.push(t('register.check.newLimit'));
  return list;
}

function uploadProblemText(p) {
  return t(`upload.${p.code}`, { file: p.file ?? '', max: p.max, kb: Math.round((p.max ?? 0) / 1024) });
}

const size = (bytes) => (bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`);

function thumbText(u) {
  const { draft } = u;
  const p = u.check?.thumbnail ?? [];
  if (draft.thumbnail) return p.length ? t('register.thumb.bad', { msg: p[0] }) : t('register.thumb.ok');
  if (draft.thumbnailProblems?.length) return t('register.thumb.bad', { msg: draft.thumbnailProblems[0] });
  if (u.prior) return p.length ? t('register.thumb.keptBad', { msg: p[0] }) : t('register.thumb.kept');
  return t('register.thumb.none');
}

/** 오늘 남은 등록 횟수. 새 게임은 하루에 하나라 다 쓰면 따로 알립니다 (server/internal/upload의 NewGamesPerDay) */
function leftText(m) {
  if (m.left > 0 && m.newLeft === 0) return t('register.leftNoNew', { n: m.left });
  return t('register.left', { n: m.left });
}

function renderUpload() {
  const u = upload;
  const line = $('#upload-status');
  line.className = 'status-line';
  if (u?.state === 'uploading') line.textContent = t('register.uploading');
  else if (u?.state === 'checking') line.textContent = t('register.checking', { n: CHECK_GAMES });
  else if (u?.state === 'failed') {
    line.textContent = t('register.uploadFailed', { msg: u.msg });
    line.classList.add('bad');
  } else {
    line.textContent = mine ? leftText(mine) : '';
    if (mine?.left === 0) line.classList.add('bad');
  }

  const box = $('#check');
  box.hidden = !u?.draft && !u?.problems?.length;
  if (box.hidden) return;

  const facts = [];
  if (u.draft) {
    if (u.info) facts.push([t('register.fact.id'), `${u.info.id} · ${t(`register.kind.${kindOf(u)}`)}`]);
    facts.push([t('register.fact.version'), u.draft.version]);
    facts.push([t('register.fact.files'), u.draft.files.map((f) => `${f.path} (${size(f.bytes)})`).join(', ')]);
    if (u.state === 'done') facts.push([t('register.fact.thumbnail'), thumbText(u)]);
  }
  $('#facts').replaceChildren(...facts.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    return [dt, dd];
  }));

  const found = siteProblems(u);
  const status = $('#check-status');
  status.className = 'status-line';
  status.textContent = '';
  if (u.state === 'done') {
    status.textContent = t(found.length ? 'register.check.failed' : 'register.check.passed');
    status.classList.add(found.length ? 'bad' : 'good');
  }
  const s = u.check?.stats;
  $('#check-stats').textContent = s ? t('register.check.stats', {
    n: s.n,
    p0: s.tally['0'],
    p1: s.tally['1'],
    draw: s.tally.draw,
    max: s.tally.maxActions,
    moves: s.avgMoves.toFixed(1),
    avg: s.avgMs.toFixed(2),
  }) : '';
  fillList($('#check-problems'), found);
  const warnings = u.check?.warnings ?? [];
  $('#check-warnings').hidden = !warnings.length;
  fillList($('#check-warnings ul'), warnings);
}

function fillList(ul, items) {
  ul.replaceChildren(...items.map((x) => {
    const li = document.createElement('li');
    li.textContent = x;
    return li;
  }));
}

/** 1단계를 마쳤는지 */
function fileReady() {
  if (mode === 'dev' || current?.edit) return !!current;
  return upload?.state === 'done' && !!current && !siteProblems(upload).length;
}

// ---- 1단계 (사이트): 내 게임의 등록 정보만 고치기 (?edit=<id>) ----

/** 내 게임의 등록 정보만 고칩니다. 코드는 그대로라 직접 깨기 없이 3단계로 갑니다 */
function startEdit(id) {
  const g = myGame(id);
  if (!g) {
    editMissing = true;
    return render();
  }
  current = { ...g, edit: true };
  fill(g.listing);
  checkTurn(current);
  goStep(STEP.langs);
}

/** 고치는 게임 (1단계로 돌아왔을 때). 코드를 바꾸려면 그 아래에서 zip을 새로 올립니다 */
function renderEditing() {
  $('#editing').hidden = !current?.edit && !editMissing;
  const name = $('#editing-name');
  name.replaceChildren();
  $('#editing-status').textContent = editMissing ? t('mine.gone') : '';
  $('#editing-hint').hidden = !current?.edit;
  if (!current?.edit) return;
  const meta = document.createElement('small');
  meta.textContent = t('mine.meta', { id: current.id, version: current.version.slice(0, 8), date: new Date(current.published).toLocaleDateString(lang) });
  name.append(localize(current.listing?.name, lang).text || current.id, meta);
}

/** PATCH /api/uploads/<id>의 실패 이유 (내 프로필과 같음) */
function editError(status, body) {
  if (status === 429) return t('mine.tooMany');
  if (status === 404) return t('mine.gone');
  return body.error ?? String(status);
}

// ---- 2단계 (사이트): 직접 깨기와 썸네일 ----

const seatName = (p) => t(p === 0 ? 'match.first' : 'match.second');
const playLang = () => gameLang(current?.listing, lang);
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const canPlay = () => !!play?.runner && !play.busy && !play.ended && !play.error;
const flipped = () => play.runner.info.board.flipForPlayer === play.seat;

/** 같은 버전을 이미 깨서 등록했는지 (등록 정보만 고치려고 같은 코드를 다시 올린 경우). 서버가 전에 깬 판을 그대로 씁니다 */
const priorClear = () => upload?.state === 'done' && !!current && kindOf(upload) === 'same' && !!myGame(current.id)?.clear;

/** 2단계를 마쳤는지 */
const clearReady = () => !!cleared || priorClear();

/** 다른 zip을 올리면 판과 클리어, 썸네일을 버립니다 */
function closePlay() {
  play?.runner?.close();
  play = null;
  board = null;
  cleared = null;
  thumb = null;
  thumbProblem = '';
}

/** 판을 바꾸는 일 하나. 그동안 다른 조작을 막고, 그사이 다른 zip을 올렸으면 결과를 버립니다 */
async function busy(p, work) {
  p.busy = true;
  p.note = '';
  hover = null;
  render();
  try {
    await work();
  } catch (err) {
    if (play === p) p.error = err.message;
  }
  if (play !== p) return;
  p.busy = false;
  render();
}

/** 2단계에 들어오면 초안을 실행기에 불러 새 판을 둡니다. 이미 불러 둔 초안이면 그대로 둡니다 */
function openPlay() {
  if (!current || play?.draft === current.draft) return;
  play?.runner?.close();
  const p = { draft: current.draft, runner: null, seed: randomSeed(), moves: [], trail: [], startHash: '', seat: 0, look: null, ended: null, busy: false, note: '', error: '' };
  play = p;
  board = null;
  busy(p, async () => {
    p.runner = await loadGame({ module: p.draft.module });
    if (play !== p) return p.runner.close();
    board = new BoardView($('#play-board'), p.runner.info.board, p.runner.info.pieces);
    boardPx = 0;
    await rebuild(p);
  });
}

/** 시드와 지금까지의 행동으로 판을 처음부터 다시 둡니다 (새 판, 무르기) */
async function rebuild(p) {
  const start = await p.runner.start(p.seed, { players: [] });
  let { turn } = start;
  p.startHash = start.hash;
  p.trail = [];
  if (p.moves.length) {
    const { steps } = await p.runner.play(p.moves, { players: [] });
    p.trail = steps.map((s, i) => ({ hash: s.hash, passed: s.turn !== p.moves[i].player }));
    turn = steps.at(-1).turn;
  }
  if (turn !== null) p.seat = turn;
  await refresh(p);
}

/** 둔 수: 차례가 넘어간 행동 수. 기물 고르기처럼 차례가 그대로인 행동은 세지 않습니다 (대전과 같은 규칙) */
const turnsOf = (p) => p.trail.filter((s) => s.passed).length;

/** 이번 차례에 나온 판들 [그 판까지의 moves 길이, 해시]. 차례가 시작된 판부터입니다 */
function turnPositions(p) {
  let i = p.trail.length;
  while (i > 0 && !p.trail[i - 1].passed) i--;
  const out = [[i, i ? p.trail[i - 1].hash : p.startHash]];
  for (let j = i; j < p.trail.length; j++) out.push([j + 1, p.trail[j].hash]);
  return out;
}

/** 두는 쪽의 판을 받아 오고 끝났는지 봅니다. 이겼으면 그 판이 클리어 기보가 됩니다 */
async function refresh(p) {
  const look = await p.runner.look({ players: [p.seat], lang: playLang(), legalFor: p.seat });
  if (play !== p) return;
  p.look = look;
  const r = look.result;
  if (r) p.ended = { winner: r.winner, reason: r.reason };
  // 플랫폼처럼 둔 수가 maxActions에 닿으면 무승부입니다
  else if (turnsOf(p) >= p.runner.info.maxActions) p.ended = { winner: null, maxActions: true };
  else p.ended = null;
  if (p.ended && p.ended.winner !== null && p.moves.length) {
    cleared = { version: p.draft.version, seed: p.seed, moves: p.moves.map((m) => ({ ...m })), winner: p.ended.winner, turns: turnsOf(p) };
  }
}

/** 두는 쪽으로 행동 하나. turn()이 있으면 다음 차례로 두는 쪽을 바꿉니다 */
function act(action) {
  const p = play;
  if (!canPlay()) return;
  busy(p, async () => {
    const player = p.seat;
    const [step1] = (await p.runner.play([{ player, action }], { players: [] })).steps;
    if (step1.changed) {
      const passed = step1.turn !== player;
      // 이번 차례에 이미 나온 판으로 돌아갔으면(기물을 골랐다 바꾸기) 같은 판이므로 그 사이 행동을 기보에서 뺍니다
      const seen = passed ? null : turnPositions(p).find(([, h]) => h === step1.hash);
      if (seen) p.moves.length = p.trail.length = seen[0];
      else {
        p.moves.push({ player, action });
        p.trail.push({ hash: step1.hash, passed });
      }
      if (step1.turn !== null) p.seat = step1.turn;
    }
    await refresh(p);
    if (!step1.changed) p.note = t('register.play.ignored');
  });
}

function chooseSeat(seat) {
  const p = play;
  if (!canPlay() || p.seat === seat) return;
  p.seat = seat;
  busy(p, () => refresh(p));
}

function undo() {
  const p = play;
  if (!p?.runner || p.busy || p.error || !p.moves.length) return;
  p.moves.pop();
  busy(p, () => rebuild(p));
}

/** 새 시드로 처음부터. 게임 코드가 멈췄으면 실행기를 다시 불러옵니다 */
function restart() {
  const p = play;
  if (!p || p.busy) return;
  if (p.error || !p.runner) {
    p.runner?.close();
    play = null;
    openPlay();
    return;
  }
  p.seed = randomSeed();
  p.moves = [];
  busy(p, () => rebuild(p));
}

/** 화면 언어를 바꾸면 게임 안 글자를 그 언어로 다시 받아 옵니다 */
function relook() {
  const p = play;
  if (p?.look && !p.busy && !p.error) busy(p, () => refresh(p));
}

/** 지금 두는 쪽의 화면을 그대로 썸네일로 (npx boardmadang dev의 Use as thumbnail과 같습니다) */
function shoot() {
  const p = play;
  const view = p?.look?.views[p.seat];
  if (!view || p.busy) return;
  const { board: b, pieces } = p.runner.info;
  const data = makeThumbnail({ board: b, pieces }, p.seat, view);
  const bad = validateThumbnail(data);
  thumbProblem = bad.length ? t('register.thumb.cannot', { msg: bad[0] }) : '';
  if (!bad.length) thumb = { data, from: 'shot', moves: turnsOf(p) };
  render();
}

function drawBoard() {
  const canvas = $('#play-board');
  canvas.hidden = !board;
  if (!board) return;
  const px = Math.min(BOARD_PX, $('.play').clientWidth || BOARD_PX);
  if (px !== boardPx) {
    board.resize(px);
    boardPx = px;
  }
  const view = play.look?.views[play.seat] ?? { pieces: [] };
  board.draw(view, { flip: flipped(), hover: canPlay() ? hover : null });
  canvas.classList.toggle('ended', !!play.ended);
  $('#play-message').textContent = view.message ?? '';
}

function renderPlay() {
  const p = play;
  const info = p?.runner?.info;
  const status = $('#play-status');
  status.className = 'play-status';
  status.replaceChildren();
  if (p?.error) status.textContent = t('register.play.failed', { msg: p.error });
  else if (!p?.look) status.textContent = t('register.play.loading');
  else if (p.ended) {
    const won = p.ended.winner !== null;
    status.classList.toggle('win', won);
    status.textContent = won ? t('register.play.won', { who: seatName(p.ended.winner) }) : t('register.play.draw');
    const why = p.ended.maxActions ? t('register.play.maxActions', { n: info.maxActions }) : p.ended.reason ?? '';
    if (why) {
      const small = document.createElement('small');
      small.textContent = why;
      status.append(small);
    }
  } else {
    status.textContent = t('register.play.turn', { who: seatName(p.seat), n: turnsOf(p) });
  }
  drawBoard();

  for (const b of document.querySelectorAll('.seat')) {
    const seat = Number(b.dataset.seat);
    b.setAttribute('aria-pressed', String(p?.seat === seat));
    b.disabled = !canPlay();
    b.querySelector('.dot').style.background = PLAYER_COLORS[seat];
  }
  // 특수 행동 버튼은 게임이 바뀔 때만 다시 만듭니다 (누른 버튼의 포커스가 남게)
  const specials = $('#play-specials');
  const kinds = info?.specialActions ?? [];
  if (specials.dataset.kinds !== kinds.join(' ')) {
    specials.dataset.kinds = kinds.join(' ');
    specials.replaceChildren(...kinds.map((kind) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost';
      b.textContent = kind;
      b.addEventListener('click', () => act({ kind }));
      return b;
    }));
  }
  for (const b of specials.children) b.disabled = !canPlay();
  $('#play-undo').disabled = !p?.runner || p.busy || !!p.error || !p.moves.length;
  $('#play-restart').disabled = !p || p.busy;
  $('#play-note').textContent = p?.note ?? '';

  const done = $('#clear-status');
  done.className = 'status-line';
  if (cleared) done.textContent = t('register.clear.done', { who: seatName(cleared.winner), n: cleared.turns });
  else if (priorClear()) done.textContent = t('register.clear.prior');
  else done.textContent = t('register.clear.todo');
  done.classList.toggle('good', clearReady());

  const canvas = $('#thumb-board');
  canvas.hidden = !thumb;
  if (thumb) {
    const { data } = thumb;
    const view = new BoardView(canvas, data.board, data.pieces);
    view.resize(THUMB_PX);
    view.draw(data.view, { flip: data.board.flipForPlayer === data.player });
  }
  const note = $('#thumb-status');
  note.className = 'status-line';
  note.classList.toggle('bad', !!thumbProblem);
  note.textContent = thumbProblem || (!thumb ? t('register.thumb.empty')
    : thumb.from === 'shot' ? t('register.thumb.taken', { who: seatName(thumb.data.player), n: thumb.moves })
      : t(`register.thumb.from.${thumb.from}`));
  $('#thumb-shot').disabled = !p?.look || p.busy || !!p.error;
  $('#thumb-drop').disabled = !thumb;
}

// ---- 1단계 (개발 서버): games/의 게임 고르기 ----

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

function choose(id) {
  current = games.find((g) => g.id === id) ?? games[0] ?? null;
  if (!current) return;
  $('#game').value = current.id;
  history.replaceState(null, '', `?game=${encodeURIComponent(current.id)}`);
  fill(current.listing);
  render();
  checkTurn(current);
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
    // 사이트에 등록된 게임은 검사를 통과한 코드라, 실행기를 못 띄운 것뿐이면 모르는 채로(null) 두어 타이머를 지우지 않습니다
    if (entry.edit) found = null;
  } finally {
    runner?.close();
  }
  if (current !== entry) return;
  hasTurn = found;
  renderTimer();
}

// ---- 3단계: 언어 고르기 ----

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
  for (const b of document.querySelectorAll('.chips .chip')) {
    const l = b.dataset.lang;
    const on = support.get(l) === b.closest('.chips').dataset.level;
    b.setAttribute('aria-pressed', String(on));
    // 다른 쪽에서 고른 언어는 흐리게 (누르면 이쪽으로 옮겨집니다)
    b.classList.toggle('elsewhere', support.has(l) && !on);
    b.textContent = `${on ? '✓' : '+'} ${LANG_NAMES[l]}`;
  }
}

// ---- 4단계: 언어별 글 ----

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
  // turn()이 없는 게임은 타이머를 쓸 수 없습니다 (불러오는 중이면 고른 대로 둡니다. 개발 서버는 다시 검사합니다)
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

// ---- 폼 ↔ 등록 정보 ----

function fill(listing) {
  for (const r of document.querySelectorAll('input[name=difficulty]')) r.checked = r.value === listing?.difficulty;
  fillTimer(listing?.timer ?? DEFAULT_TIMER);
  support = new Map(Object.entries(listing?.languages ?? {}).filter(([l]) => LANGS.includes(l)));
  texts = { name: {}, description: {}, rulebook: {} };
  for (const field of TEXT_FIELDS) {
    for (const [l, v] of Object.entries(listing?.[field] ?? {})) if (typeof v === 'string') texts[field][l] = v;
  }
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

/** 3단계에서 고칠 문제인지 (난이도, 타이머, 지원 언어) */
const isLangsProblem = (p) => ['languages.', 'difficulty.', 'timer.'].some((s) => p.code.startsWith(s));
/** 2단계에서 고칠 문제인지 (클리어 기보, 썸네일). 서버만 알려 줍니다 */
const isClearProblem = (p) => p.code.startsWith('clear.') || p.code.startsWith('thumbnail.');
/** 문제가 있으면 가장 앞의 단계로 돌아갑니다 */
const stepOf = (list) => (list.some(isClearProblem) ? STEP.clear : list.some(isLangsProblem) ? STEP.langs : STEP.texts);
/** 보이는 단계. 개발 서버와, 사이트에서 내 게임의 등록 정보만 고칠 때는 직접 깨기가 없습니다 */
const stepsOf = () => (mode === 'dev' || current?.edit ? [STEP.file, STEP.langs, STEP.texts] : [STEP.file, STEP.clear, STEP.langs, STEP.texts]);

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
  fillList(box.querySelector('ul'), problems.map(problemText));
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
  const shown = stepsOf();
  for (const n of Object.values(STEP)) $(`#step-${n}`).hidden = step !== n;
  for (const li of document.querySelectorAll('.steps li')) {
    const n = Number(li.dataset.step);
    li.hidden = !shown.includes(n);
    li.querySelector('b').textContent = String(shown.indexOf(n) + 1);
    li.classList.toggle('done', n < step);
    if (n === step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
  $('.steps li[data-step="1"] span').textContent = t(current?.edit ? 'register.stepEdit' : 'register.step0');
  $('#next-1').disabled = !fileReady();
  $('#next-2').disabled = !clearReady();
}

function renderStatus() {
  // 사이트에서 zip을 올려 등록하는 중인지. 내 게임의 등록 정보만 고칠 때는 개발 서버처럼 저장입니다
  const site = mode === 'site' && !current?.edit;
  const s = $('#save-status');
  s.replaceChildren();
  s.className = 'status-line';
  $('#save').textContent = t(site ? 'register.publish' : current?.edit ? 'register.saveEdit' : 'register.save');
  // 사이트에서는 등록하면 초안이 없어집니다. 다시 고치려면 내 게임에서 고치거나 zip을 다시 올립니다
  $('#save').disabled = saveState?.kind === 'saving' || (site && saveState?.kind === 'saved');
  if (!saveState) return;
  if (saveState.kind === 'saving') {
    s.textContent = t(site ? 'register.publishing' : 'register.saving');
  } else if (saveState.kind === 'failed') {
    s.textContent = t(site ? 'register.publishFailed' : 'register.failed', { msg: saveState.msg });
    s.classList.add('bad');
  } else {
    s.classList.add('good');
    s.append(t(site ? 'register.published' : 'register.saved'));
    const link = (key, href) => {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = t(key);
      s.append(' ', a);
    };
    // 내린 게임은 로비에 없습니다
    if (!current?.hidden) link('register.toLobby', mode === 'site' ? `/web/?game=${encodeURIComponent(current.id)}` : '/web/');
    if (mode === 'site') link('register.toProfile', '/web/history.html');
  }
}

function render() {
  applyStatic('register.title');
  renderMe(me);
  // 게스트는 업로드할 수 없습니다. 서버도 올리기와 저장을 403으로 막습니다.
  $('#need-account').hidden = !me || isMember(me);
  const suspended = mode === 'site' ? suspendedText(me) : '';
  $('#suspended-note').textContent = suspended;
  $('#suspended-note').hidden = !suspended;
  $('#member-only').hidden = !isMember(me) || !!suspended;
  $('#upload').hidden = mode !== 'site';
  $('#pick').hidden = mode !== 'dev';
  if (mode === 'site') {
    renderUpload();
  } else {
    $('#check').hidden = true;
  }
  renderEditing();
  if (mode === 'dev') renderGame();
  if (mode === 'site' && step === STEP.clear) renderPlay();
  renderTimer();
  renderChips();
  if (step === STEP.texts) renderTexts();
  renderStep();
  renderProblems();
  renderStatus();
}

// ---- 동작 ----

function goStep(n) {
  step = n;
  problems = [];
  if (n === STEP.clear) openPlay();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** 다음(d = 1)이나 이전(d = -1) 단계로 */
function moveStep(d) {
  const list = stepsOf();
  goStep(list[list.indexOf(step) + d]);
}

function showProblems() {
  render();
  $('#problems').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** 2단계 문제만 검사하고 넘어갑니다. 글 칸은 3단계에서 검사합니다. */
function next() {
  if (!current) return;
  problems = validateListing(readForm()).filter(isLangsProblem);
  if (problems.length) return showProblems();
  goStep(STEP.texts);
}

async function save(e) {
  e.preventDefault();
  if (!current || step !== STEP.texts) return;
  const listing = readForm();
  problems = validateListing(listing);
  if (problems.length) {
    saveState = null;
    // 언어나 난이도가 문제면 3단계로 돌아갑니다
    step = stepOf(problems);
    return showProblems();
  }
  saveState = { kind: 'saving' };
  render();
  try {
    const res = await saveRequest(listing);
    const body = await res.json().catch(() => ({}));
    if (res.status === 422) {
      problems = body.problems ?? [];
      step = stepOf(problems);
      saveState = null;
    } else if (!res.ok) {
      saveState = { kind: 'failed', msg: saveError(res.status, body) };
    } else {
      current.listing = body.listing ?? body.game?.listing;
      delete current.listingError;
      saveState = { kind: 'saved' };
      dirty = false;
      if (mode === 'site') refreshLists();
    }
  } catch (err) {
    saveState = { kind: 'failed', msg: err.message };
  }
  render();
}

/** 내 게임 고치기(사이트), zip 등록(사이트), games/에 저장(개발 서버) 가운데 하나 */
function saveRequest(listing) {
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (current.edit) return fetch(`/api/uploads/${encodeURIComponent(current.id)}`, json('PATCH', { listing }));
  if (mode === 'site') {
    // 클리어가 null이면 서버가 같은 버전에서 전에 깬 판을 씁니다 (priorClear)
    const clear = cleared && { ...cleared, turns: undefined };
    return fetch(`/api/drafts/${encodeURIComponent(current.draft.id)}/publish`, json('POST', { id: current.id, listing, thumbnail: thumb?.data ?? null, clear }));
  }
  return fetch(`/api/games/${encodeURIComponent(current.id)}/listing`, json('PUT', listing));
}

function saveError(status, body) {
  if (status === 403 && body.error === 'member only') return t('register.memberOnly');
  if (status === 403 && body.error === 'suspended') return t('suspended');
  if (current?.edit) return editError(status, body);
  if (mode !== 'site') return body.error ?? status;
  if (status === 409) return t('register.check.taken', { id: current.id });
  if (status === 429) return t(body.error === 'too many new games' ? 'register.check.newLimit' : 'register.publish.tooMany');
  if (status === 404) return t('register.publish.expired');
  if (status === 400 && body.error === 'bad id') return t('register.check.longId', { max: MAX_ID });
  return body.error ?? status;
}

/** 등록하거나 고친 뒤 목록을 다시 받습니다. 같은 게임을 다시 올리면 '새 버전'으로 보이게 */
async function refreshLists() {
  try {
    const [g, m] = await Promise.all([fetch('/api/games'), fetch('/api/uploads')]);
    if (g.ok) games = await g.json();
    if (m.ok) mine = await m.json();
  } catch {
    // 다음에 새로 열면 됩니다
  }
  render();
}

function setupPlay() {
  const canvas = $('#play-board');
  canvas.addEventListener('click', (e) => {
    const cell = board && canPlay() ? board.cellAt(e, flipped()) : null;
    if (cell) act({ kind: 'click', ...cell });
  });
  canvas.addEventListener('mousemove', (e) => {
    const cell = board && canPlay() ? board.cellAt(e, flipped()) : null;
    const legal = play?.look?.legal;
    // legal()이 있으면 둘 수 있는 곳에만 호버를 보여줍니다
    const ok = cell && (!legal || legal.some((a) => sameAction(a, { kind: 'click', ...cell })));
    canvas.style.cursor = ok ? 'pointer' : 'default';
    const next = ok ? cell : null;
    if (next?.row !== hover?.row || next?.col !== hover?.col) {
      hover = next;
      drawBoard();
    }
  });
  canvas.addEventListener('mouseleave', () => {
    hover = null;
    if (play) drawBoard();
  });
  for (const b of document.querySelectorAll('.seat')) b.addEventListener('click', () => chooseSeat(Number(b.dataset.seat)));
  $('#play-undo').addEventListener('click', undo);
  $('#play-restart').addEventListener('click', restart);
  $('#thumb-shot').addEventListener('click', shoot);
  $('#thumb-drop').addEventListener('click', () => {
    thumb = null;
    thumbProblem = '';
    render();
  });
  window.addEventListener('resize', () => {
    if (play && step === STEP.clear) drawBoard();
  });
}

async function main() {
  buildChips();
  setupLangButtons(() => {
    render();
    relook();
  });
  setLang(await detectLang());
  me = await loadMe();
  render();
  if (!isMember(me)) return;

  const [gamesRes, upRes] = await Promise.all([fetch('/api/games'), fetch('/api/uploads')]);
  games = await gamesRes.json();
  if (upRes.ok) {
    mode = 'site';
    mine = await upRes.json();
  } else if (upRes.status === 404) {
    mode = 'dev';
  } else {
    throw new Error(`/api/uploads ${upRes.status}`);
  }

  $('#zip').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) uploadZip(file);
  });
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
  $('#next-1').addEventListener('click', () => fileReady() && moveStep(1));
  $('#back-2').addEventListener('click', () => moveStep(-1));
  $('#next-2').addEventListener('click', () => clearReady() && moveStep(1));
  $('#back-3').addEventListener('click', () => moveStep(-1));
  $('#next-3').addEventListener('click', next);
  $('#back-4').addEventListener('click', () => moveStep(-1));
  setupPlay();
  $('#form').addEventListener('submit', save);
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });

  const params = new URLSearchParams(location.search);
  if (mode === 'dev') choose(params.get('game'));
  if (mode === 'site' && params.has('edit')) startEdit(params.get('edit'));
  render();
}

main().catch((err) => {
  saveState = { kind: 'failed', msg: err.message };
  renderStatus();
});
