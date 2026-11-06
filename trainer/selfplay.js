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
//   selfplay { games, parallel, sims, cPuct, tempMoves, maxMoves, noise, seed, teacher, method, valueMix, fastSims, fullProb }
//            자기대국. 판마다 G를 보냅니다 (학습 데이터로 남긴 국면만. fastSims를 주면 일부 수만 남깁니다)
//            teacher가 'rollout'이면 신경망 대신 학습 없는 롤아웃 탐색으로 둡니다 (학습 초반에 신경망을 먼저 가르칠 때)
//            method가 'gumbel'이면 Gumbel 탐색으로 둡니다 (mcts.js). 'puct'(기본)는 AlphaZero의 탐색입니다
//            valueMix(0~1)만큼 가치 정답에 탐색이 낸 그 국면의 평가를 섞습니다 (0이면 최종 승패만)
//   match    { opponent: 'random' | 'perfect' | 'rollout' | 'network', oppSims, games, parallel, sims, maxMoves, seed, openingMoves }
//            AI 대 상대. 절반은 AI가 선공. rollout은 학습 없는 롤아웃 탐색(oppSims번)입니다
//            network는 train.py의 두 번째 신경망입니다 (E 메시지의 net이 1). 판 둘을 한 쌍으로, 무작위 첫 수를 같게 둡니다
//   accuracy { sims, parallel }   완전 탐색한 판마다 AI가 가장 좋은 수를 고르는 비율
//   solve    { limit }   완전 탐색. 판 수가 limit을 넘으면 { tooBig: true }
//   showcase { games, sims, maxMoves, seed, tempMoves }
//            학습 스냅샷에 남길 AI끼리 둔 판. 기보처럼 시드와 행동({ player, action })으로 돌려줍니다 (web/replay.html이 다시 둠).
//            첫 판은 늘 가장 좋은 수만 두고, 다음 판부터는 처음 tempMoves수를 방문 수에 비례해 뽑아 다른 판을 봅니다
//   quit

import { codeVersion } from '../sdk/lib/games.js';
import { hashOf, makeRng } from '../sdk/playground/platform.js';
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
 * net은 train.py가 신경망을 여러 개 쥐고 있을 때 몇 번째로 계산할지입니다 (모델 대 모델 대국. 0이면 표시하지 않음).
 */
function networkEvaluator(env, net = 0) {
  const size = env.channels * env.rows * env.cols;
  let queue = [];
  let scheduled = false;
  async function flush() {
    scheduled = false;
    const batch = queue;
    queue = [];
    const planes = new Float32Array(batch.length * size);
    batch.forEach((r, i) => env.encode(r.pos, planes.subarray(i * size, (i + 1) * size)));
    send('E', net ? { n: batch.length, net } : { n: batch.length }, planes);
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

/**
 * 자기대국. fastSims가 0보다 크면 KataGo의 playout cap randomization을 씁니다 (Wu, "Accelerating Self-Play Learning in Go", 2019):
 * 수마다 fullProb의 확률로만 sims번 탐색해서 그 수를 학습 데이터로 남기고, 나머지 수는 fastSims번만 탐색해 판을 진행합니다.
 * 한 판에서 남기는 국면이 줄고 판 수가 늘어서, 서로 닮은 국면이 덜 쌓여 가치(승패) 학습이 덜 외우게 됩니다.
 * 정책의 정답은 깊게 탐색한 수에서만 나오므로 질은 그대로입니다. 얕은 탐색은 디리클레 잡음 없이 합니다 (KataGo와 같음).
 */
async function selfplay(
  { games, parallel = 64, sims = 50, cPuct = 1.5, tempMoves = 4, maxMoves = 512, noise = { eps: 0.25 }, seed = 1, teacher = null, method = 'puct', valueMix = 0, fastSims = 0, fullProb = 0.25 },
  evaluate,
) {
  const stats = { games, wins: [0, 0], draws: 0, cut: 0, moves: 0, positions: 0 };
  await lanes(games, parallel, async (i) => {
    const random = makeRng(seed * 1000003 + i).next;
    const ev = teacher === 'rollout' ? rolloutEvaluator(env, random) : evaluate;
    let root = new Node(env.start(seed + i));
    const history = [];
    const cut = drawRule(maxMoves);
    let outcome;
    for (;;) {
      // 끄면(fastSims 0) random()을 부르지 않아서, 같은 시드면 예전과 같은 판이 나옵니다
      const full = !(fastSims > 0) || random() < fullProb;
      const n = full ? sims : fastSims;
      const g = method === 'gumbel' ? await gumbelSearch(env, root, ev, { sims: n, random }) : null;
      if (method !== 'gumbel') await search(env, root, ev, { sims: n, cPuct, noise: full ? noise : null, random });
      outcome = root.outcome;
      if (outcome) break;
      if (cut(root.pos)) {
        outcome = { winner: null };
        stats.cut++;
        break;
      }
      if (full) {
        const pi = g ? g.policy : visitPolicy(env, root);
        const q = root.toPlay === 0 ? root.q : -root.q; // 탐색이 본 이 국면의 가치 (둘 차례인 쪽 기준)
        history.push({ planes: env.encode(root.pos), pi, toPlay: root.toPlay, q });
      }
      // 고른 수의 트리를 그대로 이어서 씁니다. 둘 수가 하나도 없었으면 root가 끝난 판이 되어 다음 탐색에서 멈춥니다
      root = (g ? g.chosen : pick(env, root, root.pos.moves < tempMoves ? 1 : 0, random)) ?? root;
    }
    const { winner } = outcome;
    if (winner === null) stats.draws++;
    else stats.wins[winner]++;
    stats.moves += root.pos.moves;
    stats.positions += history.length;
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

/**
 * AI 대 상대. 절반은 AI가 선공입니다.
 * opponent가 'network'면 train.py의 두 번째 신경망(net 1)이 같은 sims로 둡니다 (모델 대 모델).
 * 이때는 판 둘이 한 쌍입니다: 같은 시작 판과 같은 무작위 첫 수(openingMoves수)로, 차례만 바꿔 둡니다.
 * 둘 다 잡음 없이 가장 좋은 수만 두므로, 첫 수를 섞지 않으면 모든 판이 같아지기 때문입니다.
 */
async function match({ opponent, oppSims = 200, games, parallel = 64, sims = 50, maxMoves = 512, seed = 1, openingMoves = 0 }, evaluate) {
  let table = null;
  if (opponent === 'perfect') {
    table = getSolved()?.table;
    if (!table) return { error: 'this game is too big to solve, so there is no perfect opponent' };
  }
  const versus = opponent === 'network';
  const other = versus ? networkEvaluator(env, 1) : null;
  // AI가 선공일 때와 후공일 때의 [승, 무, 패]. cut은 학습용 무승부 규칙으로 끝난 판 수,
  // lost는 AI가 진 판의 행동 번호들 (몇 판만)
  const result = { opponent, games, sims, first: [0, 0, 0], second: [0, 0, 0], cut: 0, lost: [] };
  // 모델 대 모델은 판마다 짧은 해시를 남깁니다. 같은 판이 되풀이되면 판 수만큼 믿을 수 없어서, train.py가 서로 다른 판을 셉니다
  if (versus) result.hashes = [];
  await lanes(games, parallel, async (i) => {
    const ai = i % 2;
    const pair = versus ? Math.floor(i / 2) : i;
    const random = makeRng(seed * 1000003 + pair).next;
    let pos = env.start(seed + pair);
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
        result.hashes?.push(hashOf([ai, actions]));
        return;
      }
      let move;
      if (pos.moves < openingMoves) {
        move = moves[Math.floor(random() * moves.length)];
      } else if (env.toPlay(pos) === ai) {
        move = (await aiMove(pos, evaluate, sims)) ?? moves[0];
      } else if (other) {
        move = (await aiMove(pos, other, sims)) ?? moves[0];
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
 * AI끼리 둔 판 (학습 스냅샷). 탐색은 평가와 같은 sims, 잡음 없이 합니다.
 * reason은 result(게임이 끝냄이나 아무도 둘 수 없음), maxActions(수 상한), cut(학습용 무승부 규칙: 같은 판 반복, maxMoves)입니다.
 */
async function showcase({ games = 2, sims = 50, maxMoves = 512, seed = 1, tempMoves = 2 }, evaluate) {
  const out = [];
  await lanes(games, games, async (i) => {
    const random = makeRng(seed * 1000003 + i).next;
    let root = new Node(env.start(seed));
    const moves = [];
    const cut = drawRule(maxMoves);
    let reason = 'result';
    for (;;) {
      await search(env, root, evaluate, { sims, random });
      if (root.outcome) break;
      if (cut(root.pos)) {
        reason = 'cut';
        break;
      }
      const child = pick(env, root, i > 0 && root.pos.moves < tempMoves ? 1 : 0, random);
      if (!child) break;
      moves.push({ player: root.toPlay, action: env.actionOf(child.action) });
      root = child;
    }
    // 게임의 result()가 끝내지 않았는데 수 상한에 이르렀으면 maxActions 무승부입니다 (env.outcome과 같은 순서)
    if (reason === 'result' && root.pos.moves >= env.maxActions && !env.game.result(root.pos.state, env.lang)) reason = 'maxActions';
    out[i] = { seed, moves, winner: root.outcome?.winner ?? null, reason };
  });
  return { games: out };
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
    else if (cmd.cmd === 'showcase') out = await showcase(cmd, evaluate);
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
