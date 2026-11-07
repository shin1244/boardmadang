// 게임 실행기: 사이트 화면은 게임 코드를 직접 불러오지 않고 이걸 거칩니다 (docs/architecture.md의 보안).
//
// 게임 코드는 남이 쓴 코드입니다. 이 페이지에서 바로 import하면 사이트와 같은 권한으로 돌아서,
// 악성 게임 하나가 보는 사람의 계정으로 의견을 쓰거나, 웹소켓으로 수를 두거나, 가짜 로그인 화면을 띄울 수 있습니다.
// 그래서 sandbox="allow-scripts" iframe(web/runner/frame.html) 안의 Worker(worker.js → host.js)에서만 돌리고,
// 메시지로만 주고받습니다.
//   - iframe은 출처가 없어서(opaque origin) 사이트의 쿠키, 저장소, 이 화면에 손댈 수 없습니다.
//   - 서버가 그 문서에 CSP를 붙여 네트워크와 외부 스크립트, eval을 막습니다 (server/internal/site의 runnerCSP).
//   - 게임 함수 호출마다 시간 제한이 있고, 넘으면 그 Worker를 끝내고 오류로 알립니다.
//   - 돌아온 값은 믿지 않고 모양과 크기를 검사해서 알려진 칸만 남깁니다.
//   - Worker를 띄울 수 없는 브라우저에서는 iframe 안에서 바로 돌립니다 (frame.js). 그래도 위의 격리는 같고,
//     무한 루프에 화면이 멈추는 것만 막지 못합니다.
//
// 판 상태는 Worker 안에만 있습니다. 화면은 start/play로 판을 진행하고 look으로 결과, 화면(view), 둘 수 있는 수를 받습니다.
//   const g = await loadGame(entry);       // g.info: { id, board, pieces, specialActions, maxActions, turn, legal }
//   const s = await g.start(seed, look);   // { hash, turn, look }
//   const r = await g.play([{ player, action }], look);  // { steps: [{ hash, changed, turn }], look }
//   const l = await g.look(look, at);      // { result, views: { 0: view, 1: view }, legal }
//   const c = await g.check({ n, langs, thumbnail });  // 등록창의 자동 검사 { problems, warnings, stats, thumbnail }
//   const shape = await g.ai(lang);        // AI 대국 준비. 관측과 행동의 모양 { rows, cols, channels, channelNames, specials, nActions }
//   let r = await g.think(sims);           // AI의 탐색. 신경망이 필요하면 { need: { planes } }, 끝나면 { done: 행동 | null }
//   r = await g.answer(logits, value);     // 신경망 결과를 넘기고 이어 갑니다 (web/ai.js)
//   g.close();
// look = { players: [0, 1], lang, legalFor: 0 | 1 | null }

const FRAME = '/web/runner/frame.html';
const LOAD_MS = 10_000;
const CALL_MS = 3_000; // 한 번 부를 때. play는 행동 수에 따라 늘립니다
const PER_MOVE_MS = 20;
const CHECK_MS = 60_000; // 자동 검사는 랜덤 대국을 여러 판 둡니다

const PLACES = ['cells', 'points', 'both'];
const LOOKS = ['plain', 'checker', 'wood'];
const PIECE_SETS = ['chess', 'go-stones', 'xo'];
const MARK_TYPES = ['dot', 'ring', 'last-move', 'danger', 'ghost', 'blocked', 'frame'];
// 테두리(frame)와 선(lines)의 두께 범위. 칸 한 변의 %입니다 (sdk/playground/board.js의 FRAME_WIDTH, LINE_WIDTH)
const FRAME_WIDTH = { min: 1, max: 30 };
const LINE_WIDTH = { min: 1, max: 50 };

let frame = null; // Promise<HTMLIFrameElement>, 페이지마다 하나
let nextSession = 0;
const sessions = new Map(); // session → GameRunner

function openFrame() {
  frame ??= new Promise((resolve, reject) => {
    const el = document.createElement('iframe');
    el.sandbox = 'allow-scripts';
    el.src = FRAME;
    el.hidden = true;
    el.tabIndex = -1;
    el.setAttribute('aria-hidden', 'true');
    const timer = setTimeout(() => reject(new Error('game runner did not start')), LOAD_MS);
    const onReady = (e) => {
      if (e.source !== el.contentWindow || e.data?.type !== 'ready') return;
      removeEventListener('message', onReady);
      clearTimeout(timer);
      resolve(el);
    };
    addEventListener('message', onReady);
    document.body.append(el);
  });
  return frame;
}

// iframe에서 온 메시지를 게임별로 나눕니다. 다른 창이 보낸 것은 버립니다.
addEventListener('message', async (e) => {
  if (!frame) return;
  const el = await frame.catch(() => null);
  if (!el || e.source !== el.contentWindow) return;
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  const g = sessions.get(m.session);
  if (!g) return;
  if (typeof m.crashed === 'string') g.fail(new Error(`game code crashed: ${m.crashed.slice(0, 200)}`));
  else g.receive(m.data);
});

// ---- 돌아온 값 검사 ----

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
/** 색: 0 / 1(플레이어 색), 이름 붙은 색(sdk/playground/board.js의 NAMED_COLORS), '#rrggbb' */
const COLOR_NAMES = ['green', 'yellow', 'gray'];
const isColor = (c) => c === 0 || c === 1 || COLOR_NAMES.includes(c) || (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));
const isWidth = (w, range) => typeof w === 'number' && w >= range.min && w <= range.max;

function cleanBoard(b) {
  if (!b || typeof b !== 'object' || !PLACES.includes(b.places) || !isInt(b.rows, 1, 32) || !isInt(b.cols, 1, 32)) {
    throw new Error('board: places, rows, cols are needed');
  }
  const out = { places: b.places, rows: b.rows, cols: b.cols };
  if (LOOKS.includes(b.look)) out.look = b.look;
  if (b.labels === true) out.labels = true;
  if (b.flipForPlayer === 0 || b.flipForPlayer === 1) out.flipForPlayer = b.flipForPlayer;
  if (b.starPoints === true) out.starPoints = true;
  else if (Array.isArray(b.starPoints)) {
    out.starPoints = b.starPoints.slice(0, 64).filter((c) => isInt(c?.row, 0, b.rows - 1) && isInt(c?.col, 0, b.cols - 1))
      .map(({ row, col }) => ({ row, col }));
  }
  return out;
}

// 글자 패의 방향 (sdk/playground/board.js의 TILE_ARROWS)
const TILE_ARROWS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

/** 기물 목록의 한 항목: 이름, 또는 글자 패 { name, text(1~2자), player?, arrows? }. 맞지 않으면 null (sdk/check.js의 tileOk와 같은 규칙) */
function cleanPiece(p) {
  if (isStr(p, 32)) return p;
  if (!p || typeof p !== 'object' || !isStr(p.name, 32) || !p.name || typeof p.text !== 'string') return null;
  const chars = [...p.text].length;
  if (chars < 1 || chars > 2) return null;
  const out = { name: p.name, text: p.text };
  if (p.player !== undefined) {
    if (p.player !== 0 && p.player !== 1) return null;
    out.player = p.player;
  }
  if (p.arrows !== undefined) {
    if (!Array.isArray(p.arrows) || !p.arrows.every((a) => TILE_ARROWS.includes(a)) || new Set(p.arrows).size !== p.arrows.length) return null;
    out.arrows = [...p.arrows];
  }
  return out;
}

function cleanInfo(v) {
  if (!v || typeof v !== 'object') throw new Error('game info is missing');
  const list = Array.isArray(v.pieces) && v.pieces.length <= 32 ? v.pieces.map(cleanPiece) : null;
  const pieces = PIECE_SETS.includes(v.pieces) ? v.pieces : list && !list.includes(null) ? list : null;
  if (!pieces) throw new Error('pieces must be a built-in set or a list of names and tiles');
  const specials = Array.isArray(v.specialActions) ? v.specialActions : [];
  return {
    id: isStr(v.id, 40) ? v.id : '',
    board: cleanBoard(v.board),
    pieces,
    specialActions: specials.filter((k) => isStr(k, 24) && k && k !== 'click').slice(0, 8),
    maxActions: isInt(v.maxActions, 1, 2000) ? v.maxActions : 2000,
    turn: v.turn === true,
    legal: v.legal === true,
  };
}

/** 판 화면(view). 판 밖의 자리, 모르는 표시, 긴 글자는 버립니다. */
function cleanView(v, board) {
  const out = { pieces: [] };
  if (!v || typeof v !== 'object') return out;
  const cap = board.rows * board.cols * 4;
  const cell = (c) => c && isInt(c.row, 0, board.rows - 1) && isInt(c.col, 0, board.cols - 1);
  const list = (a) => (Array.isArray(a) ? a.slice(0, cap) : []);
  out.pieces = list(v.pieces).filter((x) => cell(x) && isStr(x.piece, 32)).map(({ row, col, piece }) => ({ row, col, piece }));
  out.marks = list(v.marks).filter((m) => cell(m) && MARK_TYPES.includes(m.type)).map((m) => {
    const o = { row: m.row, col: m.col, type: m.type };
    if (isStr(m.piece, 32)) o.piece = m.piece;
    if (isColor(m.color)) o.color = m.color;
    if (isWidth(m.width, FRAME_WIDTH)) o.width = m.width;
    return o;
  });
  const at = ({ row, col }) => ({ row, col });
  // 칠하기와 선은 칸마다 여러 개(마우스를 올린 칸마다의 미리보기, 이웃 8칸 등)일 수 있어 상한을 두 배로 둡니다
  out.tint = (Array.isArray(v.tint) ? v.tint.slice(0, cap * 2) : []).filter((x) => cell(x) && isColor(x.color) && (x.hover === undefined || cell(x.hover))).map((x) => {
    const o = { row: x.row, col: x.col, color: x.color };
    if (cell(x.hover)) o.hover = at(x.hover);
    return o;
  });
  out.text = list(v.text).filter((x) => cell(x) && isStr(x.text, 8)).map(({ row, col, text }) => ({ row, col, text }));
  out.lines = (Array.isArray(v.lines) ? v.lines.slice(0, cap * 2) : []).filter((l) => l && cell(l.from) && cell(l.to) && (l.hover === undefined || cell(l.hover))).map((l) => {
    const o = { from: at(l.from), to: at(l.to) };
    if (isColor(l.color)) o.color = l.color;
    if (isWidth(l.width, LINE_WIDTH)) o.width = l.width;
    if (cell(l.hover)) o.hover = at(l.hover);
    return o;
  });
  if (isStr(v.message, 200)) out.message = v.message;
  return out;
}

function cleanResult(r) {
  if (!r || typeof r !== 'object' || !(r.winner === 0 || r.winner === 1 || r.winner === null || r.winner === undefined)) return null;
  const out = { winner: r.winner ?? null };
  if (isStr(r.reason, 200)) out.reason = r.reason;
  return out;
}

function cleanAction(a) {
  if (!a || typeof a !== 'object' || !isStr(a.kind, 24) || !a.kind) return null;
  if (a.kind !== 'click') return { kind: a.kind };
  return isInt(a.row, 0, 31) && isInt(a.col, 0, 31) ? { kind: 'click', row: a.row, col: a.col } : null;
}

/** 자동 검사 결과. 글자 목록과 숫자만 남깁니다. */
function cleanCheck(v) {
  const texts = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 50).map((x) => x.slice(0, 500)) : []);
  const num = (x) => (Number.isFinite(x) ? x : 0);
  const s = v?.stats && typeof v.stats === 'object' ? v.stats : null;
  const tally = {};
  for (const k of ['0', '1', 'draw', 'maxActions', 'stuck', 'noLegal']) tally[k] = num(s?.tally?.[k]);
  return {
    problems: texts(v?.problems),
    warnings: texts(v?.warnings),
    stats: s && { n: num(s.n), tally, avgMoves: num(s.avgMoves), avgMs: num(s.avgMs), maxMs: num(s.maxMs) },
    thumbnail: Array.isArray(v?.thumbnail) ? texts(v.thumbnail) : null, // 썸네일을 넘기지 않았으면 null
  };
}

function cleanLook(l, board) {
  const views = {};
  for (const p of [0, 1]) if (l?.views && p in l.views) views[p] = cleanView(l.views[p], board);
  return {
    result: cleanResult(l?.result),
    views,
    legal: Array.isArray(l?.legal) ? l.legal.slice(0, 5000).map(cleanAction).filter(Boolean) : null,
  };
}

/** AI 대국의 관측과 행동 모양 (web/runner/host.js의 ai) */
function cleanShape(v) {
  const names = (a, max) => Array.isArray(a) && a.length <= max && a.every((x) => isStr(x, 64) && x);
  if (!v || !isInt(v.rows, 1, 32) || !isInt(v.cols, 1, 32) || !names(v.channelNames, 256) || !names(v.specials, 8)
    || v.channels !== v.channelNames.length || v.nActions !== v.rows * v.cols + v.specials.length) {
    throw new Error('bad AI shape');
  }
  return {
    rows: v.rows, cols: v.cols, channels: v.channels, channelNames: [...v.channelNames], specials: [...v.specials], nActions: v.nActions,
  };
}

/**
 * AI 탐색의 답. 관측은 길이만 맞으면 신경망에 넣습니다 (게임 코드가 만든 값이라 이상해도 AI의 수만 이상해집니다).
 * 고른 행동은 판 안의 클릭이나 이 게임의 특수 행동이어야 합니다.
 */
function cleanThink(v, shape) {
  if (v?.need) {
    const { planes } = v.need;
    if (!(planes instanceof Float32Array) || planes.length !== shape.channels * shape.rows * shape.cols) throw new Error('bad AI observation');
    return { need: { planes } };
  }
  if (!v || !('done' in v)) throw new Error('bad AI reply');
  if (v.done === null) return { done: null };
  const a = cleanAction(v.done?.action);
  const ok = a && (a.kind === 'click' ? a.row < shape.rows && a.col < shape.cols : shape.specials.includes(a.kind));
  if (!ok) throw new Error('bad AI move');
  return { done: a };
}

const cleanTurn = (t) => (t === 0 || t === 1 ? t : null);
const cleanHash = (h) => {
  if (typeof h !== 'string' || !/^[0-9a-f]{8}$/.test(h)) throw new Error('bad state hash');
  return h;
};

// ---- 게임 하나 ----

class GameRunner {
  constructor(el, session) {
    this.el = el;
    this.session = session;
    this.calls = new Map(); // id → { resolve, reject, timer }
    this.nextId = 0;
    this.dead = null; // 끝났으면 그 이유
    this.info = null;
  }

  post(msg) {
    this.el.contentWindow?.postMessage({ ...msg, session: this.session }, '*');
  }

  call(method, args, ms = CALL_MS) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`game code took too long (${method})`)), ms);
      this.calls.set(id, { resolve, reject, timer });
      this.post({ type: 'call', data: { id, method, args } });
    });
  }

  receive(data) {
    const c = data && this.calls.get(data.id);
    if (!c) return;
    this.calls.delete(data.id);
    clearTimeout(c.timer);
    if (data.ok) c.resolve(data.value);
    else c.reject(new Error(isStr(data.error, 500) ? data.error : 'game code error'));
  }

  /** 더 쓸 수 없게 합니다. 기다리던 호출은 모두 실패합니다. */
  fail(err) {
    if (this.dead) return;
    this.dead = err;
    for (const c of this.calls.values()) {
      clearTimeout(c.timer);
      c.reject(err);
    }
    this.calls.clear();
    this.close();
  }

  close() {
    this.post({ type: 'close' });
    sessions.delete(this.session);
    this.dead ??= new Error('game closed');
  }

  async start(seed, look, keep = false) {
    const v = await this.call('start', { seed: seed >>> 0, keep, look });
    return { hash: cleanHash(v?.hash), turn: cleanTurn(v?.turn), look: cleanLook(v?.look, this.info.board) };
  }

  async play(moves, look) {
    const v = await this.call('play', { moves, look }, CALL_MS + PER_MOVE_MS * moves.length);
    const steps = Array.isArray(v?.steps) ? v.steps : [];
    if (steps.length !== moves.length) throw new Error('game code skipped moves');
    return {
      steps: steps.map((s) => ({ hash: cleanHash(s?.hash), changed: s?.changed === true, turn: cleanTurn(s?.turn) })),
      look: cleanLook(v?.look, this.info.board),
    };
  }

  async look(look, at = null) {
    return cleanLook(await this.call('look', { at, look }), this.info.board);
  }

  async check({ n = 100, langs = ['en'], thumbnail = null } = {}) {
    return cleanCheck(await this.call('check', { n, langs, thumbnail }, CHECK_MS));
  }

  /** AI 대국 준비. lang은 학습할 때 쓴 언어입니다 (관측이 학습 때와 같도록) */
  async ai(lang) {
    this.shape = cleanShape(await this.call('ai', { lang }, LOAD_MS));
    return this.shape;
  }

  /** 지금 판에서 AI가 sims번 탐색합니다. 신경망 계산이 필요할 때마다 { need }로 돌아옵니다 */
  async think(sims) {
    return cleanThink(await this.call('think', { sims }), this.shape);
  }

  /** need에 대한 신경망 결과 (행동 점수 nActions개, 둘 차례인 쪽 기준 가치) */
  async answer(logits, value) {
    return cleanThink(await this.call('answer', { logits, value }), this.shape);
  }
}

/**
 * 학습한 모델(/api/games의 ai)을 지금 게임 코드에 쓸 수 있는지. 관측 채널 이름, 판 크기, 특수 행동이 같아야 합니다.
 * 코드 버전은 달라도 됩니다 (trainer/train.py의 SHAPE와 같은 칸).
 * @param {object} model /api/games의 ai
 * @param {object} shape GameRunner.ai()가 돌려준 모양
 */
export function modelFits(model, shape) {
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
  return !!model && !!shape && model.rows === shape.rows && model.cols === shape.cols && model.nActions === shape.nActions
    && same(model.channelNames, shape.channelNames) && same(model.specials, shape.specials);
}

/**
 * 게임 코드를 실행기에 불러옵니다. 페이지마다 iframe은 하나이고 게임마다 Worker가 하나입니다.
 * @param {{ module: string }} entry /api/games의 항목
 */
export async function loadGame(entry) {
  const el = await openFrame();
  const g = new GameRunner(el, ++nextSession);
  sessions.set(g.session, g);
  g.post({ type: 'open' });
  try {
    g.info = cleanInfo(await g.call('load', { module: new URL(entry.module, location.href).href }, LOAD_MS));
  } catch (err) {
    g.fail(err);
    throw err;
  }
  return g;
}
