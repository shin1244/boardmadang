// 게임 어댑터, 완전 탐색, MCTS 테스트. 신경망 없이 고른 확률(균등)과 가치 0으로 탐색합니다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Env, drawRule } from './env.js';
import { loadEnv } from './load.js';
import { Node, gumbelSearch, pick, rolloutEvaluator, search, visitPolicy } from './mcts.js';
import { solve } from './solve.js';
import { makeRng } from '../sdk/playground/platform.js';

const TICTACTOE = fileURLToPath(new URL('../games/tictactoe', import.meta.url));
const uniform = async (pos, actions) => ({ policy: actions.map(() => 1 / actions.length), value: 0 });

/** 행동 번호 여러 개를 차례로 둡니다 */
function playAll(env, pos, actions) {
  for (const a of actions) pos = env.step(pos, a);
  return pos;
}

/**
 * 돌 빼기: 더미에서 1개나 2개를 가져가고, 마지막 돌을 가져간 쪽이 이깁니다 (3의 배수를 남기면 이김).
 * 한 차례가 두 행동입니다. 0번 줄의 0칸(1개)이나 1칸(2개)을 눌러 고르고, take로 가져갑니다. 고른 뒤에는 바꿀 수 없습니다.
 */
const takeAway = (pile) => ({
  id: 'take-away',
  board: { places: 'cells', rows: 1, cols: 2 },
  pieces: ['picked'],
  specialActions: ['take'],
  maxActions: 40,
  setup: () => ({ pile, turn: 0, picked: null, last: null }),
  turn: (s) => (s.pile === 0 ? null : s.turn),
  play(s, player, action) {
    if (s.pile === 0 || player !== s.turn) return s;
    if (action.kind === 'click' && s.picked === null && action.row === 0 && action.col + 1 <= s.pile) {
      return { ...s, picked: action.col + 1 };
    }
    if (action.kind === 'take' && s.picked !== null) {
      return { pile: s.pile - s.picked, turn: 1 - s.turn, picked: null, last: s.turn };
    }
    return s;
  },
  result: (s) => (s.pile === 0 ? { winner: s.last } : null),
  view: (s) => ({ pieces: s.picked ? [{ row: 0, col: s.picked - 1, piece: 'picked' }] : [], text: [{ row: 0, col: 0, text: String(s.pile) }] }),
});

/** 돌 빼기인데 고른 개수를 바꾸거나(다른 칸) 취소할(같은 칸) 수 있습니다. 스플체스의 기물 고르기처럼 차례 안에서 맴돌 수 있습니다 */
const repick = (pile) => {
  const g = takeAway(pile);
  return {
    ...g,
    id: 'take-away-repick',
    play(s, player, action) {
      if (s.pile > 0 && player === s.turn && action.kind === 'click' && action.row === 0 && action.col + 1 <= s.pile) {
        return { ...s, picked: s.picked === action.col + 1 ? null : action.col + 1 };
      }
      return g.play(s, player, action);
    },
  };
};

/** 1×3 판의 말 하나를 양쪽이 번갈아 옮깁니다. 말을 눌러 고르고(다시 누르면 취소) 옆 칸을 눌러 옮깁니다. 끝나지 않습니다 */
const shuffle = {
  id: 'shuffle',
  board: { places: 'cells', rows: 1, cols: 3 },
  pieces: ['token'],
  maxActions: 100,
  setup: () => ({ at: 0, turn: 0, picked: false }),
  turn: (s) => s.turn,
  play(s, player, { kind, col }) {
    if (player !== s.turn || kind !== 'click') return s;
    if (col === s.at) return { ...s, picked: !s.picked };
    if (s.picked && Math.abs(col - s.at) === 1) return { at: col, turn: 1 - s.turn, picked: false };
    return s;
  },
  result: () => null,
  view: (s) => ({ pieces: [{ row: 0, col: s.at, piece: 'token' }] }),
};

/** 1×1 판을 번갈아 누르고, n번째에 선공이 이깁니다. 길기만 한 게임 */
const long = (n) => ({
  id: 'long',
  board: { places: 'cells', rows: 1, cols: 1 },
  pieces: ['token'],
  maxActions: n + 1,
  setup: () => ({ n: 0 }),
  turn: (s) => (s.n === n ? null : s.n % 2),
  play: (s, player) => (s.n < n && player === s.n % 2 ? { n: s.n + 1 } : s),
  result: (s) => (s.n === n ? { winner: 0 } : null),
  view: () => ({ pieces: [] }),
});

test('tic-tac-toe adapter', async () => {
  const env = await loadEnv(TICTACTOE);
  assert.equal(env.lang, 'ko');
  assert.equal(env.nActions, 9);
  assert.equal(env.channels, env.channelNames().length);
  const start = env.start(1);
  assert.equal(env.toPlay(start), 0);
  assert.deepEqual(env.children(start).map((m) => m.action), [0, 1, 2, 3, 4, 5, 6, 7, 8]);

  const pos = playAll(env, start, [4, 0]);
  assert.deepEqual(env.children(pos).map((m) => m.action), [1, 2, 3, 5, 6, 7, 8]);
  assert.equal(env.step(pos, 4), null, 'an occupied cell is an ignored action');
  const x = env.encode(pos);
  const plane = (name) => [...x.subarray(env.channelNames().indexOf(name) * 9, (env.channelNames().indexOf(name) + 1) * 9)];
  assert.deepEqual(plane('piece:x'), [0, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(plane('piece:o'), [1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(plane('mark:last-move'), [1, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(plane('toPlay'), [0, 0, 0, 0, 0, 0, 0, 0, 0]);

  const won = playAll(env, start, [0, 3, 1, 4, 2]);
  assert.deepEqual(env.outcome(won), { winner: 0 });
});

test('solve tic-tac-toe: a draw with perfect play', async () => {
  const env = await loadEnv(TICTACTOE);
  const r = solve(env, env.start(1));
  assert.equal(r.value, 0);
  // X가 0, 1, O가 3, 4에 있으면 X는 2에 둬야 이깁니다
  const pos = playAll(env, env.start(1), [0, 3, 1, 4]);
  const entry = [...r.table.values()].find((e) => e.pos.hash === pos.hash);
  assert.deepEqual(entry.best, [2]);
  assert.equal(solve(env, env.start(1), { limit: 100 }), null, 'too big for the limit');
});

test('special actions and a turn of two actions', () => {
  const env = new Env(takeAway(4));
  assert.equal(env.nActions, 3);
  assert.deepEqual(env.actionOf(2), { kind: 'take' });
  assert.equal(env.indexOf({ kind: 'take' }), 2);
  assert.equal(env.indexOf({ kind: 'click', row: 1, col: 0 }), -1);
  // legal()이 없으면 모든 행동을 둬 보고 상태를 바꾸는 것만 남깁니다
  const start = env.start(0);
  assert.deepEqual(env.children(start).map((m) => m.action), [0, 1]);
  const picked = env.step(start, 0);
  assert.equal(env.toPlay(picked), 0, 'still the same player after picking');
  assert.deepEqual(env.children(picked).map((m) => m.action), [2]);
  // 더미 4개: 1개를 가져가 3을 남기면 선공이 이깁니다
  const r = solve(env, start);
  assert.equal(r.value, 1);
  assert.deepEqual([...r.table.values()].find((e) => e.pos.hash === start.hash).best, [0]);
  const lose = new Env(takeAway(3));
  assert.equal(solve(lose, lose.start(0)).value, -1);
});

test('a move passes the turn, and a turn cannot come back to a position it already had', () => {
  const env = new Env(repick(4));
  const start = env.start(0);
  const one = env.step(start, 0);
  assert.equal(one.moves, 0, 'picking is not a move');
  const two = env.step(one, 1);
  assert.equal(env.step(two, 0), null, 'switching back to an earlier pick is ignored');
  assert.equal(env.step(one, 0), null, 'cancelling back to the start of the turn is ignored');
  assert.deepEqual(env.children(two).map((m) => m.action), [2]);
  const taken = env.step(two, 2);
  assert.equal(taken.moves, 1);
  assert.deepEqual(taken.turnHashes, [taken.hash], 'a new turn starts its own list');
  assert.ok(env.step(taken, 0), 'the next player may pick what the last player picked');
  assert.equal(solve(env, start).value, 1);
});

test('solve walks a long game without running out of stack', () => {
  const env = new Env(long(20_000));
  assert.equal(solve(env, env.start(0)).value, 1);
});

test('the training draw rule counts repeats only where a turn starts', () => {
  const env = new Env(shuffle);
  const start = env.start(0);
  // 혼자서는 같은 판을 못 만듭니다: 골랐다 취소하면 차례가 시작된 판으로 돌아가므로 막힙니다
  assert.equal(env.step(env.step(start, 0), 0), null);
  // 양쪽이 말을 오가면 차례가 시작된 판이 세 번째로 나올 때 끝납니다. 고른 상태는 세지 않습니다
  const cut = drawRule(512);
  let pos = start;
  const ends = [cut(pos)];
  for (const a of [0, 1, 1, 0, 0, 1, 1, 0]) {
    pos = env.step(pos, a);
    ends.push(cut(pos));
  }
  assert.deepEqual(ends, [false, false, false, false, false, false, false, false, true]);
  assert.equal(pos.moves, 4);
  // maxMoves는 행동이 아니라 수를 셉니다
  const short = drawRule(2);
  pos = start;
  const capped = [];
  for (const a of [0, 1, 1, 0]) {
    pos = env.step(pos, a);
    capped.push(short(pos));
  }
  assert.deepEqual(capped, [false, false, false, true]);
});

test('MCTS finds the win and the block', async () => {
  const env = await loadEnv(TICTACTOE);
  const win = await search(env, new Node(playAll(env, env.start(1), [0, 3, 1, 4])), uniform, { sims: 200 });
  assert.equal(pick(env, win, 0).action, 2);
  const block = await search(env, new Node(playAll(env, env.start(1), [0, 4, 1])), uniform, { sims: 400 });
  assert.equal(pick(env, block, 0).action, 2);
  const pi = visitPolicy(env, block);
  assert.ok(Math.abs(pi.reduce((s, x) => s + x, 0) - 1) < 1e-6);
  assert.equal(pi[0], 0, 'occupied cells get nothing');
});

test('MCTS keeps the right side when the same player moves twice', async () => {
  const env = new Env(takeAway(4));
  const root = await search(env, new Node(env.start(0)), uniform, { sims: 800 });
  assert.equal(pick(env, root, 0).action, 0, 'pick one stone, leaving three');
  assert.ok(root.q > 0.5, 'the first player is winning');
});

test('rollout AI finds the win and the block without a network', async () => {
  const env = await loadEnv(TICTACTOE);
  const evaluate = rolloutEvaluator(env, makeRng(3).next);
  const win = await search(env, new Node(playAll(env, env.start(1), [0, 3, 1, 4])), evaluate, { sims: 200 });
  assert.equal(pick(env, win, 0).action, 2);
  const block = await search(env, new Node(playAll(env, env.start(1), [0, 4, 1])), evaluate, { sims: 400 });
  assert.equal(pick(env, block, 0).action, 2);
});

test('Gumbel search finds the win and the block with few simulations', async () => {
  const env = await loadEnv(TICTACTOE);
  const win = await gumbelSearch(env, new Node(playAll(env, env.start(1), [0, 3, 1, 4])), uniform, { sims: 16, random: null });
  assert.equal(win.chosen.action, 2);
  assert.ok(Math.abs(win.policy.reduce((s, x) => s + x, 0) - 1) < 1e-6);
  assert.equal(win.policy.indexOf(Math.max(...win.policy)), 2, 'the target puts the most weight on the win');
  assert.equal(win.policy[0], 0, 'occupied cells get nothing');
  const evaluate = rolloutEvaluator(env, makeRng(4).next);
  const block = await gumbelSearch(env, new Node(playAll(env, env.start(1), [0, 4, 1])), evaluate, { sims: 64, random: null });
  assert.equal(block.chosen.action, 2);
  // 잡음이 있어도(자기대국) 고른 수와 정답이 나옵니다
  const noisy = await gumbelSearch(env, new Node(env.start(1)), uniform, { sims: 16, random: makeRng(5).next });
  assert.ok(noisy.chosen.pos);
  assert.equal(await gumbelSearch(env, new Node(playAll(env, env.start(1), [0, 3, 1, 4, 2])), uniform), null, 'game over');
});

test('MCTS drops actions that legal() lists but play() ignores', async () => {
  // 0번 칸(1개)만 실제로 둘 수 있는데 legal()은 1번 칸과 take도 늘 내놓습니다
  const game = { ...takeAway(4), legal: () => [{ kind: 'click', row: 0, col: 1 }, { kind: 'click', row: 0, col: 0 }, { kind: 'take' }] };
  game.play = (s, player, action) => (action.kind === 'click' && action.col === 1 ? s : takeAway(4).play(s, player, action));
  const env = new Env(game);
  const root = await search(env, new Node(env.start(0)), uniform, { sims: 50 });
  assert.deepEqual(root.children.map((c) => c.action), [0], 'only the click that changes the state is left');
  assert.equal(pick(env, root, 0).action, 0);
  // 둘 수 있는 수가 하나도 없으면 무승부로 끝납니다
  const stuck = new Env({ ...game, play: (s, player, action) => (action.kind === 'click' && s.turn === player && s.pile === 4 && s.picked === null ? { ...s, picked: 1 } : s) });
  const picked = await search(stuck, new Node(stuck.step(stuck.start(0), 0)), uniform, { sims: 10 });
  assert.deepEqual(picked.outcome, { winner: null });
  assert.equal(pick(stuck, picked, 0), null);
  assert.equal(await gumbelSearch(stuck, new Node(stuck.step(stuck.start(0), 0)), uniform, { random: null }), null);
  const g = await gumbelSearch(env, new Node(env.start(0)), uniform, { sims: 8, random: null });
  assert.equal(g.chosen.action, 0);
});

test('a game needs turn()', () => {
  const { turn, ...noTurn } = takeAway(4);
  assert.throws(() => new Env(noTurn), /turn\(\) is missing/);
});
