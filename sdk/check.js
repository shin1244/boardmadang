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
    if (proto !== Object.prototype && proto !== null) return `${where} (${v.constructor?.name ?? 'object'})`;
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
  if (!b || typeof b !== 'object') return [`${where}: must be an object`];
  const p = [];
  if (!PLACES.includes(b.places)) p.push(`${where}.places: must be 'cells', 'points', or 'both'`);
  for (const k of ['rows', 'cols']) {
    if (!Number.isInteger(b[k]) || b[k] < 1 || b[k] > GAME_LIMITS.boardSize) {
      p.push(`${where}.${k}: must be a whole number from 1 to ${GAME_LIMITS.boardSize}`);
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
  if (typeof g.id !== 'string' || !/^[a-z0-9-]+$/.test(g.id)) p.push('id: must use only lowercase letters, numbers, and -');
  p.push(...boardProblems(g.board, 'board'));
  if (!piecesOk(g.pieces)) p.push(`pieces: must be 'chess', 'go-stones', 'xo', or a list of up to ${GAME_LIMITS.pieceKinds} names`);
  if (!Number.isInteger(g.maxActions) || g.maxActions < 1 || g.maxActions > GAME_LIMITS.maxActions) {
    p.push(`maxActions: must be a whole number from 1 to ${GAME_LIMITS.maxActions.toLocaleString('en')}`);
  }
  for (const k of ['setup', 'play', 'result', 'view']) if (!fn(k)) p.push(`${k}(): missing (must be a function)`);
  for (const k of ['legal', 'observe', 'turn']) if (k in g && !fn(k)) p.push(`${k}: must be a function if present`);
  if ('specialActions' in g
    && !(Array.isArray(g.specialActions) && g.specialActions.every((x) => typeof x === 'string' && x !== 'click'))) {
    p.push("specialActions: must be a list of names other than 'click'");
  }
  return p;
}

export const sameAction = (a, b) => a.kind === b.kind && (a.kind !== 'click' || (a.row === b.row && a.col === b.col));

/** 게임 함수를 부르고, 오류가 나면 어느 함수인지 붙여 다시 던집니다. */
function call(name, f) {
  try {
    return f();
  } catch (e) {
    throw new Error(`${name} threw an error: ${e?.message ?? e}`);
  }
}

/** 상태 하나의 문제 (JSON이 아닌 값, 크기) */
function stateProblems(s, from) {
  const bad = findNonJson(s);
  if (bad) return [`${from} returned a state with a non-JSON value: ${bad}`];
  if (JSON.stringify(s).length > GAME_LIMITS.stateBytes) return [`${from} returned a state larger than ${GAME_LIMITS.stateBytes / 1024}KB`];
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
      if (JSON.stringify(s) !== before) out.problems.push('play() changed the state it received. Copy it and return a new state.');
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
      if (t2 !== 0 && t2 !== 1 && t2 !== null) out.problems.push(`turn() must return 0, 1, or null (got ${JSON.stringify(t2)})`);
      if (r && t2 !== null) out.problems.push('turn() must return null once the game is over, so the clock stops.');
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
      p.push('view() changes more than the message depending on lang. The board must look the same in every language.');
    }
  }
  if (langs.some((l) => winner(l) !== winner(langs[0]))) p.push('result() returns a different winner depending on lang.');
  return p;
}

function observeProblems(game, s) {
  if (!game.observe) return [];
  const o = call('observe()', () => game.observe(s, 0));
  const { rows, cols } = game.board;
  const ok = Array.isArray(o) && o.every((ch) => Array.isArray(ch) && ch.length === rows
    && ch.every((row) => Array.isArray(row) && row.length === cols && row.every((x) => typeof x === 'number')));
  return ok ? [] : [`observe() must return numbers shaped [channel][${rows}][${cols}].`];
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
        problems.push('Replaying the same seed and moves gave a different state. Check for Math.random() or Date.now().');
      }
      if (deep) problems.push(...langProblems(game, g.state, langs));
      if (i === 0) problems.push(...observeProblems(game, g.state));
    } catch (e) {
      problems.push(e.message);
      break;
    }
  }

  if (tally.noLegal) problems.push(`In ${tally.noLegal} games, legal() was empty for both players before the game ended.`);
  if (tally.stuck) problems.push(`${tally.stuck} games got stuck: every move was ignored.`);
  const avgMs = calls ? sumMs / calls : 0;
  if (avgMs > GAME_LIMITS.playAvgMs || maxMs > GAME_LIMITS.playMaxMs) {
    problems.push(`play() is too slow: ${avgMs.toFixed(2)}ms on average, ${maxMs.toFixed(1)}ms at most (limits: ${GAME_LIMITS.playAvgMs}ms average, ${GAME_LIMITS.playMaxMs}ms max)`);
  }
  if (legalIgnored) warnings.push(`play() ignored a move from legal() ${legalIgnored} times. The two functions disagree about the rules.`);
  if (game.board.places === 'both') warnings.push("board.places 'both' is drawn like 'cells' for now.");

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
  if (!t || typeof t !== 'object') return ['thumbnail: must be an object'];
  const p = boardProblems(t.board, 'thumbnail.board');
  if (!piecesOk(t.pieces)) p.push("thumbnail.pieces: must look like the game's pieces");
  if (t.player !== 0 && t.player !== 1) p.push('thumbnail.player: must be 0 or 1');
  const v = t.view;
  if (!v || typeof v !== 'object' || !Array.isArray(v.pieces)) p.push('thumbnail.view.pieces: must be a list');
  if (p.length) return p;

  const b = t.board;
  const list = (k) => v[k] === undefined || Array.isArray(v[k]);
  for (const k of ['marks', 'tint', 'text']) if (!list(k)) p.push(`thumbnail.view.${k}: must be a list if present`);
  if (p.length) return p;
  if (!v.pieces.every((x) => isCell(x, b) && typeof x.piece === 'string' && x.piece.length <= 32)) {
    p.push('thumbnail.view.pieces: each needs a place on the board and a piece name');
  }
  if (!(v.marks ?? []).every((m) => isCell(m, b) && MARK_TYPES.includes(m.type)
    && (m.piece === undefined || typeof m.piece === 'string') && (m.color === undefined || isColor(m.color)))) {
    p.push('thumbnail.view.marks: each needs a place on the board and a known mark type');
  }
  if (!(v.tint ?? []).every((x) => isCell(x, b) && isColor(x.color))) p.push('thumbnail.view.tint: each needs a place on the board and a color');
  if (!(v.text ?? []).every((x) => isCell(x, b) && typeof x.text === 'string' && x.text.length <= 8)) {
    p.push('thumbnail.view.text: each needs a place on the board and up to 8 characters');
  }
  if (!p.length && new TextEncoder().encode(JSON.stringify(normalizeThumbnail(t))).length > GAME_LIMITS.thumbnailBytes) {
    p.push(`thumbnail is larger than ${GAME_LIMITS.thumbnailBytes / 1024}KB`);
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
    p.push('board settings changed after the thumbnail was taken. Take it again.');
  }
  if (!sameJson(t.pieces, game.pieces)) p.push('pieces changed after the thumbnail was taken. Take it again.');
  if (Array.isArray(game.pieces)) {
    const known = new Set(game.pieces);
    const used = [...t.view.pieces.map((x) => x.piece), ...(t.view.marks ?? []).filter((m) => m.piece).map((m) => m.piece)];
    if (used.some((x) => !known.has(x))) p.push("The thumbnail has a piece that isn't in the game's pieces.");
  }
  return p;
}
