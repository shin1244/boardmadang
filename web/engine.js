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
//   g.close();
// look = { players: [0, 1], lang, legalFor: 0 | 1 | null }

const FRAME = '/web/runner/frame.html';
const LOAD_MS = 10_000;
const CALL_MS = 3_000; // 한 번 부를 때. play는 행동 수에 따라 늘립니다
const PER_MOVE_MS = 20;

const PLACES = ['cells', 'points', 'both'];
const LOOKS = ['plain', 'checker', 'wood'];
const PIECE_SETS = ['chess', 'go-stones', 'xo'];
const MARK_TYPES = ['dot', 'ring', 'last-move', 'danger', 'ghost', 'blocked', 'frame'];

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
const isColor = (c) => c === 0 || c === 1 || (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));

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

function cleanInfo(v) {
  if (!v || typeof v !== 'object') throw new Error('game info is missing');
  const pieces = PIECE_SETS.includes(v.pieces) ? v.pieces
    : Array.isArray(v.pieces) && v.pieces.length <= 32 && v.pieces.every((p) => isStr(p, 32)) ? [...v.pieces] : null;
  if (!pieces) throw new Error('pieces must be a built-in set or a list of names');
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
    return o;
  });
  out.tint = list(v.tint).filter((x) => cell(x) && isColor(x.color)).map(({ row, col, color }) => ({ row, col, color }));
  out.text = list(v.text).filter((x) => cell(x) && isStr(x.text, 8)).map(({ row, col, text }) => ({ row, col, text }));
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

function cleanLook(l, board) {
  const views = {};
  for (const p of [0, 1]) if (l?.views && p in l.views) views[p] = cleanView(l.views[p], board);
  return {
    result: cleanResult(l?.result),
    views,
    legal: Array.isArray(l?.legal) ? l.legal.slice(0, 5000).map(cleanAction).filter(Boolean) : null,
  };
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
