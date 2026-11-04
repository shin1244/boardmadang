// 자기대국 워커. train.py가 띄우고 stdin/stdout으로 이야기합니다.
//
// 게임 코드와 MCTS는 여기(Node)에서 돌고, 신경망 계산만 train.py에 부탁합니다.
// 여러 판을 동시에 두면서 각 판이 낸 국면을 모아 한 번에 보내므로(batch), 신경망 호출 수는 탐색 횟수만큼만 생깁니다.
//
// 메시지: [u32 길이][u8 종류][u32 JSON 길이][JSON][바이너리]. 길이는 그 뒤 바이트 수, 숫자는 모두 리틀 엔디언입니다.
//   워커 → train.py   H 게임 정보 · E 신경망 계산 부탁 (float32 국면) · G 한 판의 학습 데이터 · D 명령 끝 (통계)
//   train.py → 워커   C 명령 · R 신경망 결과 (float32 행동 점수 n × nActions, 그다음 가치 n개)
//
// 명령 (C)
//   selfplay { games, parallel, sims, cPuct, tempMoves, maxMoves, noise, seed, teacher, method, valueMix }
//            자기대국. 판마다 G를 보냅니다
//            teacher가 'rollout'이면 신경망 대신 학습 없는 롤아웃 탐색으로 둡니다 (학습 초반에 신경망을 먼저 가르칠 때)
//            method가 'gumbel'이면 Gumbel 탐색으로 둡니다 (mcts.js). 'puct'(기본)는 AlphaZero의 탐색입니다
//            valueMix(0~1)만큼 가치 정답에 탐색이 낸 그 국면의 평가를 섞습니다 (0이면 최종 승패만)
//   match    { opponent: 'random' | 'perfect' | 'rollout', oppSims, games, parallel, sims, maxMoves, seed }
//            AI 대 상대. 절반은 AI가 선공. rollout은 학습 없는 롤아웃 탐색(oppSims번)입니다
//   accuracy { sims, parallel }   완전 탐색한 판마다 AI가 가장 좋은 수를 고르는 비율
//   solve    { limit }   완전 탐색. 판 수가 limit을 넘으면 { tooBig: true }
//   quit

import { codeVersion } from '../sdk/lib/games.js';
import { makeRng } from '../sdk/playground/platform.js';
import { drawRule } from './env.js';
import { loadEnv } from './load.js';
import { Node, gumbelSearch, networkPolicy, pick, rolloutEvaluator, search, visitPolicy } from './mcts.js';
import { keyOf, solve } from './solve.js';

// stdout은 메시지 전용입니다. 게임 코드가 console.log를 써도 stderr로 보냅니다
for (const k of ['log', 'info', 'warn', 'debug']) console[k] = (...args) => console.error(...args);

// ---- 메시지 ----

function send(type, json = {}, bin = null) {
  const j = Buffer.from(JSON.stringify(json));
  const b = bin ? Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength) : Buffer.alloc(0);
  const head = Buffer.alloc(9);
  head.writeUInt32LE(5 + j.length + b.length, 0);
  head.writeUInt8(type.charCodeAt(0), 4);
  head.writeUInt32LE(j.length, 5);
  process.stdout.write(Buffer.concat([head, j, b]));
}

const inbox = { C: [], R: [] };
const waiting = { C: [], R: [] };
let buf = Buffer.alloc(0);

function deliver(type, value) {
  const w = waiting[type]?.shift();
  if (w) w(value);
  else inbox[type]?.push(value);
}

const receive = (type) => (inbox[type].length
  ? Promise.resolve(inbox[type].shift())
  : new Promise((resolve) => waiting[type].push(resolve)));

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const len = buf.readUInt32LE(0);
    const type = String.fromCharCode(buf[4]);
    const jlen = buf.readUInt32LE(5);
    const json = JSON.parse(buf.subarray(9, 9 + jlen).toString() || '{}');
    const bin = buf.subarray(9 + jlen, 4 + len);
    buf = buf.subarray(4 + len);
    if (type === 'C') deliver('C', json);
    else if (type === 'R') deliver('R', new Float32Array(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)));
  }
});
process.stdin.on('end', () => process.exit(0));

/** Float32Array 여러 개를 하나로 */
function concat(arrays) {
  const out = new Float32Array(arrays.reduce((s, a) => s + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

// ---- 신경망 ----

/**
 * train.py의 신경망으로 계산하는 evaluate. 같은 틱에 들어온 요청을 모아 한 번에 보냅니다.
 * 행동 점수는 둘 수 있는 행동만 골라 softmax합니다.
 */
function networkEvaluator(env) {
  const size = env.channels * env.rows * env.cols;
  let queue = [];
  let scheduled = false;
  async function flush() {
    scheduled = false;
    const batch = queue;
    queue = [];
    const planes = new Float32Array(batch.length * size);
    batch.forEach((r, i) => env.encode(r.pos, planes.subarray(i * size, (i + 1) * size)));
    send('E', { n: batch.length }, planes);
    const out = await receive('R');
    const A = env.nActions;
    batch.forEach((r, i) => {
      r.resolve({ policy: networkPolicy(out, r.actions, i * A), value: out[batch.length * A + i] });
    });
  }
  return (pos, actions) => new Promise((resolve) => {
    queue.push({ pos, actions, resolve });
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  });
}

/** n개를 parallel개씩 동시에 돌립니다. 그래야 신경망 요청이 모입니다 */
async function lanes(n, parallel, work) {
  let next = 0;
  const lane = async () => {
    while (next < n) await work(next++);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallel, n)) }, lane));
}

// ---- 명령 ----

let solved; // 완전 탐색 결과 (한 번만)
function getSolved(limit = 200_000) {
  if (solved === undefined) solved = solve(env, env.start(0), { limit });
  return solved;
}

async function selfplay(
  { games, parallel = 64, sims = 50, cPuct = 1.5, tempMoves = 4, maxMoves = 512, noise = { eps: 0.25 }, seed = 1, teacher = null, method = 'puct', valueMix = 0 },
  evaluate,
) {
  const stats = { games, wins: [0, 0], draws: 0, cut: 0, moves: 0 };
  await lanes(games, parallel, async (i) => {
    const random = makeRng(seed * 1000003 + i).next;
    const ev = teacher === 'rollout' ? rolloutEvaluator(env, random) : evaluate;
    let root = new Node(env.start(seed + i));
    const history = [];
    const cut = drawRule(maxMoves);
    let outcome;
    for (;;) {
      const g = method === 'gumbel' ? await gumbelSearch(env, root, ev, { sims, random }) : null;
      if (method !== 'gumbel') await search(env, root, ev, { sims, cPuct, noise, random });
      outcome = root.outcome;
      if (outcome) break;
      if (cut(root.pos)) {
        outcome = { winner: null };
        stats.cut++;
        break;
      }
      const pi = g ? g.policy : visitPolicy(env, root);
      const q = root.toPlay === 0 ? root.q : -root.q; // 탐색이 본 이 국면의 가치 (둘 차례인 쪽 기준)
      history.push({ planes: env.encode(root.pos), pi, toPlay: root.toPlay, q });
      // 고른 수의 트리를 그대로 이어서 씁니다. 둘 수가 하나도 없었으면 root가 끝난 판이 되어 다음 탐색에서 멈춥니다
      root = (g ? g.chosen : pick(env, root, root.pos.moves < tempMoves ? 1 : 0, random)) ?? root;
    }
    const { winner } = outcome;
    if (winner === null) stats.draws++;
    else stats.wins[winner]++;
    stats.moves += root.pos.moves;
    // 가치의 정답은 그 국면에서 둘 차례였던 쪽 기준입니다. 최종 승패는 운이 섞여 있어 탐색의 평가를 섞을 수 있습니다
    const z = Float32Array.from(history, (h) => {
      const result = winner === null ? 0 : winner === h.toPlay ? 1 : -1;
      return (1 - valueMix) * result + valueMix * h.q;
    });
    send('G', { positions: history.length, winner }, concat([...history.map((h) => h.planes), ...history.map((h) => h.pi), z]));
  });
  return stats;
}

/** AI가 고르는 수. sims가 0이면 신경망의 사전 확률만 봅니다 */
async function aiMove(pos, evaluate, sims) {
  const root = await search(env, new Node(pos), evaluate, { sims });
  return pick(env, root, 0);
}

async function match({ opponent, oppSims = 200, games, parallel = 64, sims = 50, maxMoves = 512, seed = 1 }, evaluate) {
  let table = null;
  if (opponent === 'perfect') {
    table = getSolved()?.table;
    if (!table) return { error: 'this game is too big to solve, so there is no perfect opponent' };
  }
  // AI가 선공일 때와 후공일 때의 [승, 무, 패]. cut은 학습용 무승부 규칙으로 끝난 판 수,
  // lost는 AI가 진 판의 행동 번호들 (몇 판만)
  const result = { opponent, games, sims, first: [0, 0, 0], second: [0, 0, 0], cut: 0, lost: [] };
  await lanes(games, parallel, async (i) => {
    const ai = i % 2;
    const random = makeRng(seed * 1000003 + i).next;
    let pos = env.start(seed + i);
    const actions = [];
    const cut = drawRule(maxMoves);
    for (;;) {
      const moves = env.children(pos);
      let out = env.outcome(pos, moves);
      if (!out && cut(pos)) {
        out = { winner: null };
        result.cut++;
      }
      if (out) {
        const k = out.winner === null ? 1 : out.winner === ai ? 0 : 2;
        result[ai === 0 ? 'first' : 'second'][k]++;
        if (k === 2 && result.lost.length < 5) result.lost.push({ ai, actions });
        return;
      }
      let move;
      if (env.toPlay(pos) === ai) {
        move = (await aiMove(pos, evaluate, sims)) ?? moves[0];
      } else if (table) {
        const best = table.get(keyOf(pos)).best;
        const a = best[Math.floor(random() * best.length)];
        move = moves.find((m) => m.action === a);
      } else if (opponent === 'rollout') {
        move = (await aiMove(pos, rolloutEvaluator(env, random), oppSims)) ?? moves[0];
      } else {
        move = moves[Math.floor(random() * moves.length)];
      }
      actions.push(move.action);
      pos = move.pos;
    }
  });
  return result;
}

/**
 * 가장 좋은 수가 따로 있는 판(아무 수나 둬도 같은 판은 뺌)에서 AI가 그 수를 고르는 비율.
 * 틀린 수는 이길 판을 놓친 것(missedWins)과 지지 않을 판에서 지는 수를 둔 것(blunders)으로 나눕니다.
 */
async function accuracy({ sims = 50, parallel = 256 }, evaluate) {
  const table = getSolved()?.table;
  if (!table) return { error: 'this game is too big to solve' };
  const cases = [...table.values()].filter((e) => e.toPlay !== null && e.best.length < e.moves);
  const grade = async (s) => {
    const out = { rate: 0, missedWins: 0, blunders: 0 };
    await lanes(cases.length, parallel, async (i) => {
      const { pos, value, toPlay } = cases[i];
      const sign = toPlay === 0 ? 1 : -1;
      const move = await aiMove(pos, evaluate, s);
      const got = move ? sign * table.get(keyOf(move.pos)).value : -sign;
      const want = sign * value;
      if (got === want) out.rate++;
      else if (want === 1) out.missedWins++;
      else if (got === -1) out.blunders++;
    });
    out.rate /= cases.length;
    return out;
  };
  return { positions: cases.length, policy: await grade(0), search: sims ? await grade(sims) : null };
}

// ---- 시작 ----

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node trainer/selfplay.js <game folder>');
  process.exit(2);
}
const env = await loadEnv(dir);
send('H', {
  id: env.game.id,
  version: codeVersion(dir), // 사이트의 게임 코드 버전 (/api/games의 version과 같은 계산)
  rows: env.rows,
  cols: env.cols,
  channels: env.channels,
  channelNames: env.channelNames(),
  nActions: env.nActions,
  specials: env.specials,
  maxActions: env.maxActions,
  lang: env.lang,
});

const evaluate = networkEvaluator(env);
for (;;) {
  const cmd = await receive('C');
  if (cmd.cmd === 'quit') break;
  let out;
  try {
    if (cmd.cmd === 'selfplay') out = await selfplay(cmd, evaluate);
    else if (cmd.cmd === 'match') out = await match(cmd, evaluate);
    else if (cmd.cmd === 'accuracy') out = await accuracy(cmd, evaluate);
    else if (cmd.cmd === 'solve') {
      const r = getSolved(cmd.limit);
      out = r ? { value: r.value, positions: r.table.size } : { tooBig: true };
    } else out = { error: `unknown command: ${cmd.cmd}` };
  } catch (err) {
    out = { error: String(err?.stack ?? err) };
  }
  send('D', out);
}
process.exit(0);
