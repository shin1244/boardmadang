// 게임 검사. 플레이그라운드, 명령줄(npx boardmadang check), 앞으로의 업로드 검사가 같은 코드를 씁니다.
// 브라우저와 Node 양쪽에서 돌아가야 하므로 화면, 파일, 네트워크를 쓰지 않습니다.
// 제한값의 이유는 docs/abuse-and-limits.md에 있습니다.
//
// 썸네일도 여기서 검사합니다. 썸네일은 이미지가 아니라 혼자 두던 판을 그대로 찍은 데이터(thumbnail.json)이고,
// 사이트가 보드 렌더러로 다시 그립니다. 판 설정과 기물 세트까지 들어 있어서 게임 코드 없이도 그릴 수 있습니다.

import { hashOf, makeRng } from './playground/platform.js';

/** 업로드할 때 검사하는 상한 */
export const GAME_LIMITS = {
  boardSize: 32, // rows, cols
  pieceKinds: 32,
  maxActions: 2000,
  codeBytes: 256 * 1024, // 게임 폴더의 .js, .mjs를 합친 크기
  stateBytes: 64 * 1024, // 상태 JSON
  playAvgMs: 2,
  playMaxMs: 50,
  thumbnailBytes: 32 * 1024,
};

const PLACES = ['cells', 'points', 'both'];
const PIECE_SETS = ['chess', 'go-stones', 'xo'];
const MARK_TYPES = ['dot', 'ring', 'last-move', 'danger', 'ghost', 'blocked', 'frame'];

/** JSON으로 그대로 옮길 수 없는 값의 위치. 문제없으면 null */
export function findNonJson(v, where = 'state') {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : `${where} (${v})`;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const w = findNonJson(v[i], `${where}[${i}]`);
      if (w) return w;
    }
    return null;
  }
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return `${where} (${v.constructor?.name ?? '객체'})`;
    for (const [k, x] of Object.entries(v)) {
      const w = findNonJson(x, `${where}.${k}`);
      if (w) return w;
    }
    return null;
  }
  return `${where} (${typeof v})`;
}

/** board 설정의 문제. where는 글자에 붙일 이름 (board, thumbnail.board) */
function boardProblems(b, where) {
  if (!b || typeof b !== 'object') return [`${where}: 객체가 필요합니다`];
  const p = [];
  if (!PLACES.includes(b.places)) p.push(`${where}.places: 'cells', 'points', 'both' 중 하나여야 합니다`);
  for (const k of ['rows', 'cols']) {
    if (!Number.isInteger(b[k]) || b[k] < 1 || b[k] > GAME_LIMITS.boardSize) {
      p.push(`${where}.${k}: 1~${GAME_LIMITS.boardSize}의 정수여야 합니다`);
    }
  }
  return p;
}

const piecesOk = (pc) => PIECE_SETS.includes(pc)
  || (Array.isArray(pc) && pc.length <= GAME_LIMITS.pieceKinds && pc.every((x) => typeof x === 'string'));

/** 필수 멤버와 제한값 검사. 업로드 검사의 첫 단계와 같습니다. */
export function checkMembers(g) {
  const p = [];
  const fn = (k) => typeof g[k] === 'function';
  if (typeof g.id !== 'string' || !/^[a-z0-9-]+$/.test(g.id)) p.push('id: 영문 소문자, 숫자, -로 된 문자열이어야 합니다');
  p.push(...boardProblems(g.board, 'board'));
  if (!piecesOk(g.pieces)) p.push(`pieces: 'chess', 'go-stones', 'xo' 또는 문자열 배열(${GAME_LIMITS.pieceKinds}개 이하)이어야 합니다`);
  if (!Number.isInteger(g.maxActions) || g.maxActions < 1 || g.maxActions > GAME_LIMITS.maxActions) {
    p.push(`maxActions: 1~${GAME_LIMITS.maxActions.toLocaleString('en')}의 정수여야 합니다`);
  }
  for (const k of ['setup', 'play', 'result', 'view']) if (!fn(k)) p.push(`${k}(): 함수가 필요합니다`);
  for (const k of ['legal', 'observe', 'turn']) if (k in g && !fn(k)) p.push(`${k}: 있다면 함수여야 합니다`);
  if ('specialActions' in g
    && !(Array.isArray(g.specialActions) && g.specialActions.every((x) => typeof x === 'string' && x !== 'click'))) {
    p.push("specialActions: 'click'이 아닌 문자열 배열이어야 합니다");
  }
  return p;
}

export const sameAction = (a, b) => a.kind === b.kind && (a.kind !== 'click' || (a.row === b.row && a.col === b.col));

/** 게임 함수를 부르고, 오류가 나면 어느 함수인지 붙여 다시 던집니다. */
function call(name, f) {
  try {
    return f();
  } catch (e) {
    throw new Error(`${name}에서 오류: ${e?.message ?? e}`);
  }
}

/** 상태 하나의 문제 (JSON이 아닌 값, 크기) */
function stateProblems(s, from) {
  const bad = findNonJson(s);
  if (bad) return [`${from}가 돌려준 state에 JSON이 아닌 값이 있습니다: ${bad}`];
  if (JSON.stringify(s).length > GAME_LIMITS.stateBytes) return [`${from}가 돌려준 state가 ${GAME_LIMITS.stateBytes / 1024}KB를 넘습니다`];
  return [];
}

/** 지금 둘 수 있는 [플레이어, 행동]. legal()이 없으면 아무 칸 클릭과 특수 행동 */
function choicesOf(game, s, random) {
  const choices = [];
  for (const p of [0, 1]) {
    if (game.legal) {
      for (const a of call('legal()', () => game.legal(s, p))) choices.push([p, a]);
    } else {
      const { rows, cols } = game.board;
      choices.push([p, { kind: 'click', row: Math.floor(random() * rows), col: Math.floor(random() * cols) }]);
      for (const k of game.specialActions ?? []) choices.push([p, { kind: k }]);
    }
  }
  return choices;
}

/**
 * 랜덤 대국 한 판. 양쪽이 고를 수 있는 행동 중 하나를 무작위로 둡니다.
 * deep이면 한 수마다 state를 고쳤는지, JSON인지, turn()이 맞는지도 봅니다 (느려서 앞의 몇 판만).
 */
function playRandom(game, seed, { random, lang, deep }) {
  const out = { actions: [], effective: 0, end: null, result: null, sumMs: 0, maxMs: 0, legalIgnored: 0, problems: [] };
  let s = call('setup()', () => game.setup(makeRng(seed)));
  if (deep) out.problems.push(...stateProblems(s, 'setup()'));
  let h = hashOf(s);
  let raw = 0;
  let r = call('result()', () => game.result(s, lang));
  while (!r) {
    // 상태를 바꾼 행동이 maxActions에 이르면 플랫폼이 무승부로 끝냅니다
    if (out.effective >= game.maxActions) { out.end = 'maxActions'; break; }
    if (raw > game.maxActions * 20) { out.end = 'stuck'; break; }
    const choices = choicesOf(game, s, random);
    if (!choices.length) { out.end = 'noLegal'; break; }

    const [player, action] = choices[Math.floor(random() * choices.length)];
    const before = deep ? JSON.stringify(s) : null;
    const t = performance.now();
    const next = call('play()', () => game.play(s, player, action));
    const ms = performance.now() - t;
    out.sumMs += ms;
    out.maxMs = Math.max(out.maxMs, ms);
    raw++;
    if (deep) {
      if (JSON.stringify(s) !== before) out.problems.push('play()가 받은 state를 고쳤습니다. 복사해서 새 상태를 돌려주세요.');
      out.problems.push(...stateProblems(next, 'play()'));
    }
    out.actions.push({ player, action });
    const h2 = hashOf(next);
    if (h2 !== h) out.effective++;
    else if (game.legal) out.legalIgnored++;
    s = next;
    h = h2;
    r = call('result()', () => game.result(s, lang));
    if (deep && game.turn) {
      const t2 = call('turn()', () => game.turn(s));
      if (t2 !== 0 && t2 !== 1 && t2 !== null) out.problems.push(`turn()은 0, 1, null 중 하나여야 합니다 (받은 값: ${JSON.stringify(t2)})`);
      if (r && t2 !== null) out.problems.push('끝난 판에서는 turn()이 null이어야 시계가 멈춥니다.');
    }
  }
  if (r) {
    out.result = r;
    out.end = r.winner === null ? 'draw' : r.winner;
  }
  out.state = s;
  out.hash = h;
  out.raw = raw;
  return out;
}

/** 같은 시드와 같은 행동으로 처음부터 다시 둔 상태의 해시 */
function replayHash(game, seed, actions) {
  let s = game.setup(makeRng(seed));
  for (const { player, action } of actions) s = game.play(s, player, action);
  return hashOf(s);
}

/** 승자와 판 그림은 lang과 상관없이 같아야 합니다. 글자(message, reason)만 언어마다 다릅니다. */
function langProblems(game, s, langs) {
  if (langs.length < 2) return [];
  const p = [];
  const drawn = (pl, l) => JSON.stringify({ ...call('view()', () => game.view(s, pl, l)), message: undefined });
  const winner = (l) => { const r = call('result()', () => game.result(s, l)); return r ? String(r.winner) : '-'; };
  for (const pl of [0, 1]) {
    if (langs.some((l) => drawn(pl, l) !== drawn(pl, langs[0]))) {
      p.push('view()가 lang에 따라 message 말고 다른 것도 바꿉니다. 판 그림은 언어와 상관없이 같아야 합니다.');
    }
  }
  if (langs.some((l) => winner(l) !== winner(langs[0]))) p.push('result()가 lang에 따라 다른 승자를 돌려줍니다.');
  return p;
}

function observeProblems(game, s) {
  if (!game.observe) return [];
  const o = call('observe()', () => game.observe(s, 0));
  const { rows, cols } = game.board;
  const ok = Array.isArray(o) && o.every((ch) => Array.isArray(ch) && ch.length === rows
    && ch.every((row) => Array.isArray(row) && row.length === cols && row.every((x) => typeof x === 'number')));
  return ok ? [] : [`observe()는 [채널][${rows}][${cols}] 모양의 숫자 배열이어야 합니다.`];
}

/**
 * 게임 검사. 업로드 검사의 실행 단계를 그대로 합니다.
 *   - 필수 멤버와 제한값
 *   - 랜덤 대국 n판: 오류 없이 끝나는지, 진행이 막히지 않는지, play() 속도
 *   - 앞의 몇 판은 한 수마다: state를 고치지 않는지, JSON인지, 64KB 이하인지, turn()이 맞는지
 *   - 결정성: 같은 시드와 같은 행동으로 다시 두면 같은 상태인지
 *   - 언어: 판 그림과 승자가 lang과 상관없이 같은지 (langs가 둘 이상일 때)
 * problems는 고쳐야 올릴 수 있는 것, warnings는 알려만 주는 것입니다.
 * @param {object} game
 * @param {{ n?: number, langs?: string[], random?: () => number }} [opts] langs는 완전 번역 언어 (첫 번째로 둡니다)
 */
export function checkGame(game, { n = 200, langs = ['ko'], random = Math.random } = {}) {
  const problems = checkMembers(game ?? {});
  const warnings = [];
  if (problems.length) return { problems, warnings, stats: null };

  const lang = langs[0];
  const tally = { 0: 0, 1: 0, draw: 0, maxActions: 0, stuck: 0, noLegal: 0 };
  let played = 0;
  let totalMoves = 0;
  let sumMs = 0;
  let maxMs = 0;
  let calls = 0;
  let legalIgnored = 0;
  for (let i = 0; i < n; i++) {
    const seed = Math.floor(random() * 2 ** 32) >>> 0;
    const deep = i < 5;
    try {
      const g = playRandom(game, seed, { random, lang, deep });
      played++;
      tally[g.end]++;
      totalMoves += g.effective;
      sumMs += g.sumMs;
      maxMs = Math.max(maxMs, g.maxMs);
      calls += g.raw;
      legalIgnored += g.legalIgnored;
      problems.push(...g.problems);
      if (i < 20 && replayHash(game, seed, g.actions) !== g.hash) {
        problems.push('같은 시드·같은 행동으로 다시 뒀더니 상태가 다릅니다. Math.random()이나 Date.now()를 쓰고 있지 않은지 확인하세요.');
      }
      if (deep) problems.push(...langProblems(game, g.state, langs));
      if (i === 0) problems.push(...observeProblems(game, g.state));
    } catch (e) {
      problems.push(e.message);
      break;
    }
  }

  if (tally.noLegal) problems.push(`끝나지 않았는데 양쪽 모두 legal()이 비어 있는 판이 ${tally.noLegal}번 나왔습니다.`);
  if (tally.stuck) problems.push(`행동이 계속 무시되기만 해서 진행되지 않은 판이 ${tally.stuck}번 있습니다.`);
  const avgMs = calls ? sumMs / calls : 0;
  if (avgMs > GAME_LIMITS.playAvgMs || maxMs > GAME_LIMITS.playMaxMs) {
    problems.push(`play()가 느립니다. 평균 ${avgMs.toFixed(2)}ms, 최대 ${maxMs.toFixed(1)}ms (상한: 평균 ${GAME_LIMITS.playAvgMs}ms, 최대 ${GAME_LIMITS.playMaxMs}ms)`);
  }
  if (legalIgnored) warnings.push(`legal()이 돌려준 행동인데 play()가 무시한 경우가 ${legalIgnored}번 있습니다. 두 함수의 규칙이 서로 다릅니다.`);
  if (game.board.places === 'both') warnings.push("board.places 'both'는 아직 칸 모드로만 그립니다.");

  return {
    problems: [...new Set(problems)],
    warnings,
    stats: { n: played, tally, avgMoves: played ? totalMoves / played : 0, avgMs, maxMs },
  };
}

// ---- 썸네일 ----

const isCell = (c, b) => c && typeof c === 'object'
  && Number.isInteger(c.row) && Number.isInteger(c.col)
  && c.row >= 0 && c.col >= 0 && c.row < b.rows && c.col < b.cols;
const isColor = (c) => c === 0 || c === 1 || (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));

/**
 * 썸네일을 저장할 모양으로 만듭니다. 판 설정, 기물 세트, 찍은 플레이어, 그 순간의 화면입니다.
 * 화면의 message는 언어마다 다른 글자라 넣지 않습니다.
 */
export function makeThumbnail(game, player, view) {
  const { message, ...rest } = view ?? {};
  return normalizeThumbnail({ board: game.board, pieces: game.pieces, player, view: rest });
}

/** 알려진 칸만 남깁니다. validateThumbnail을 통과한 값에 씁니다. */
export function normalizeThumbnail(t) {
  const cell = ({ row, col }) => ({ row, col });
  const b = t.board;
  const board = { places: b.places, rows: b.rows, cols: b.cols };
  for (const k of ['look', 'starPoints', 'labels', 'flipForPlayer']) if (b[k] !== undefined) board[k] = b[k];
  const v = t.view;
  const view = { pieces: v.pieces.map((x) => ({ ...cell(x), piece: x.piece })) };
  if (v.marks) {
    view.marks = v.marks.map((m) => {
      const out = { ...cell(m), type: m.type };
      if (m.piece !== undefined) out.piece = m.piece;
      if (m.color !== undefined) out.color = m.color;
      return out;
    });
  }
  if (v.tint) view.tint = v.tint.map((x) => ({ ...cell(x), color: x.color }));
  if (v.text) view.text = v.text.map((x) => ({ ...cell(x), text: x.text }));
  return { board, pieces: Array.isArray(t.pieces) ? [...t.pieces] : t.pieces, player: t.player, view };
}

/** 썸네일 모양 검사. 게임 코드 없이 합니다 (개발 서버가 저장하기 전에). 문제 목록, 없으면 [] */
export function validateThumbnail(t) {
  if (!t || typeof t !== 'object') return ['썸네일: 객체가 필요합니다'];
  const p = boardProblems(t.board, 'thumbnail.board');
  if (!piecesOk(t.pieces)) p.push('thumbnail.pieces: 게임의 pieces와 같은 모양이어야 합니다');
  if (t.player !== 0 && t.player !== 1) p.push('thumbnail.player: 0 또는 1이어야 합니다');
  const v = t.view;
  if (!v || typeof v !== 'object' || !Array.isArray(v.pieces)) p.push('thumbnail.view.pieces: 배열이 필요합니다');
  if (p.length) return p;

  const b = t.board;
  const list = (k) => v[k] === undefined || Array.isArray(v[k]);
  for (const k of ['marks', 'tint', 'text']) if (!list(k)) p.push(`thumbnail.view.${k}: 있다면 배열이어야 합니다`);
  if (p.length) return p;
  if (!v.pieces.every((x) => isCell(x, b) && typeof x.piece === 'string' && x.piece.length <= 32)) {
    p.push('thumbnail.view.pieces: 판 안의 자리와 기물 이름이어야 합니다');
  }
  if (!(v.marks ?? []).every((m) => isCell(m, b) && MARK_TYPES.includes(m.type)
    && (m.piece === undefined || typeof m.piece === 'string') && (m.color === undefined || isColor(m.color)))) {
    p.push('thumbnail.view.marks: 판 안의 자리와 알려진 표시 종류여야 합니다');
  }
  if (!(v.tint ?? []).every((x) => isCell(x, b) && isColor(x.color))) p.push('thumbnail.view.tint: 판 안의 자리와 색이어야 합니다');
  if (!(v.text ?? []).every((x) => isCell(x, b) && typeof x.text === 'string' && x.text.length <= 8)) {
    p.push('thumbnail.view.text: 판 안의 자리와 8자 이하의 글자여야 합니다');
  }
  if (!p.length && new TextEncoder().encode(JSON.stringify(normalizeThumbnail(t))).length > GAME_LIMITS.thumbnailBytes) {
    p.push(`썸네일이 ${GAME_LIMITS.thumbnailBytes / 1024}KB를 넘습니다`);
  }
  return p;
}

/** 키 순서와 상관없이 같은 JSON인지 */
function sameJson(a, b) {
  const norm = (v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
    : Array.isArray(v) ? v.map(norm) : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** 썸네일이 지금 게임 코드와 맞는지. 코드에서 판이나 기물을 바꿨으면 다시 찍어야 합니다. */
export function checkThumbnail(game, t) {
  const p = validateThumbnail(t);
  if (p.length) return p;
  if (!sameJson(normalizeThumbnail(t).board, normalizeThumbnail({ ...t, board: game.board }).board)) {
    p.push('썸네일을 찍은 뒤 board 설정이 바뀌었습니다. 다시 찍으세요.');
  }
  if (!sameJson(t.pieces, game.pieces)) p.push('썸네일을 찍은 뒤 pieces가 바뀌었습니다. 다시 찍으세요.');
  if (Array.isArray(game.pieces)) {
    const known = new Set(game.pieces);
    const used = [...t.view.pieces.map((x) => x.piece), ...(t.view.marks ?? []).filter((m) => m.piece).map((m) => m.piece)];
    if (used.some((x) => !known.has(x))) p.push('썸네일에 게임의 pieces에 없는 기물이 있습니다.');
  }
  return p;
}
