// 브라우저 AI(web/runner/host.js의 ai, think, answer)가 학습과 같은 관측과 탐색을 쓰는지 봅니다.
// 브라우저에서는 탐색이 실행기 Worker 안에서 돌고 신경망은 밖에서 돌아서, 신경망을 부를 때마다 관측(planes)이 메시지로 나갑니다.
// 같은 판이면 그 관측이 학습 때(env.encode)와 한 글자도 달라선 안 되고, 같은 신경망이면 같은 수를 골라야 합니다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashOf } from '../sdk/playground/platform.js';
import { createHost } from '../web/runner/host.js';
import { loadEnv } from './load.js';
import { Node, networkPolicy, pick, search } from './mcts.js';

const TICTACTOE = new URL('../games/tictactoe/', import.meta.url);

/** 관측만 보고 정해지는 가짜 신경망 (행동 점수 nActions개와 가치) */
const fakeNet = (nActions) => (planes) => {
  const logits = new Float32Array(nActions);
  let v = 0;
  for (let i = 0; i < planes.length; i++) {
    for (let a = 0; a < nActions; a++) logits[a] += planes[i] * Math.sin(1 + i * 7 + a * 13);
    v += planes[i] * Math.cos(i * 3);
  }
  return { logits, value: Math.tanh(v / 4) };
};

/** 실행기 쪽: 메시지 하나를 보내고 답을 받습니다 */
async function call(host, method, args) {
  const r = await host({ id: 1, method, args });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/** 실행기 쪽 AI가 한 행동을 고릅니다. 신경망에 넣은 관측을 seen에 모읍니다 */
async function hostThink(host, net, sims, seen) {
  let r = await call(host, 'think', { sims });
  while (r.need) {
    seen.push(Array.from(r.need.planes));
    r = await call(host, 'answer', net(r.need.planes));
  }
  return r.done?.action ?? null;
}

/** 학습 쪽: 같은 판에서 같은 신경망으로 탐색합니다 (selfplay.js의 networkEvaluator와 같은 계산) */
async function directThink(env, pos, net, sims, seen) {
  const evaluate = async (p, actions) => {
    const planes = env.encode(p);
    seen.push(Array.from(planes));
    const { logits, value } = net(planes);
    return { policy: networkPolicy(logits, actions), value };
  };
  const root = await search(env, new Node(pos), evaluate, { sims });
  const child = root.outcome ? null : pick(env, root, 0);
  return child && env.actionOf(child.action);
}

/** 게임 모듈 소스를 data: 주소로 (실행기는 게임을 주소로 불러옵니다) */
const moduleOf = (src) => `data:text/javascript,${encodeURIComponent(src)}`;

test('the browser AI sees the same observations and picks the same moves as training (tic-tac-toe)', async () => {
  const env = await loadEnv(fileURLToPath(TICTACTOE));
  const host = createHost();
  await call(host, 'load', { module: new URL('index.js', TICTACTOE).href });
  await call(host, 'start', { seed: 3, look: { players: [] } });
  const shape = await call(host, 'ai', { lang: env.lang });
  assert.deepEqual(shape, {
    rows: 3, cols: 3, channels: env.channels, channelNames: env.channelNames(), specials: [], nActions: 9,
  });

  const net = fakeNet(env.nActions);
  let pos = env.start(3);
  let plies = 0;
  while (!env.outcome(pos, env.children(pos))) {
    const fromHost = [];
    const fromTraining = [];
    const a = await hostThink(host, net, 30, fromHost);
    const b = await directThink(env, pos, net, 30, fromTraining);
    assert.deepEqual(a, b);
    assert.ok(fromHost.length > 0);
    assert.deepEqual(fromHost, fromTraining, 'the same observations in the same order');
    const player = env.toPlay(pos);
    await call(host, 'play', { moves: [{ player, action: a }], look: { players: [] } });
    pos = env.step(pos, env.indexOf(a));
    plies++;
  }
  assert.ok(plies >= 5);
  // 끝난 판에서는 둘 수가 없습니다
  assert.equal(await hostThink(host, net, 10, []), null);
});

test('the browser AI knows the moves made and the positions already seen in this turn', async () => {
  // 돌 빼기: 0칸(1개)이나 1칸(2개)을 눌러 고르고(같은 칸을 다시 누르면 취소) take로 가져갑니다. 마지막 돌을 가져가면 이깁니다
  const src = `export default {
    id: 'repick',
    board: { places: 'cells', rows: 1, cols: 2 },
    pieces: ['picked'],
    specialActions: ['take'],
    maxActions: 3,
    setup: () => ({ pile: 9, turn: 0, picked: null, last: null }),
    turn: (s) => (s.pile === 0 ? null : s.turn),
    play(s, player, a) {
      if (s.pile === 0 || player !== s.turn) return s;
      if (a.kind === 'click' && a.row === 0 && a.col + 1 <= s.pile) return { ...s, picked: s.picked === a.col + 1 ? null : a.col + 1 };
      if (a.kind === 'take' && s.picked !== null) return { pile: s.pile - s.picked, turn: 1 - s.turn, picked: null, last: s.turn };
      return s;
    },
    result: (s) => (s.pile === 0 ? { winner: s.last } : null),
    view: (s) => ({ pieces: s.picked ? [{ row: 0, col: s.picked - 1, piece: 'picked' }] : [], text: [{ row: 0, col: 0, text: String(s.pile) }] }),
  };`;
  const module = moduleOf(src);
  const game = (await import(module)).default;
  const { Env } = await import('./env.js');
  const env = new Env(game, { lang: 'en' });
  const host = createHost();
  await call(host, 'load', { module });
  await call(host, 'start', { seed: 0, look: { players: [] } });
  await call(host, 'ai', { lang: 'en' });
  const net = fakeNet(env.nActions);

  // 1개를 골랐다가 취소: 판은 처음과 같지만, 이번 차례에 1개를 고른 판이 이미 나왔으므로 다시 고를 수 없습니다
  const pickOne = { kind: 'click', row: 0, col: 0 };
  await call(host, 'play', { moves: [{ player: 0, action: pickOne }, { player: 0, action: pickOne }], look: { players: [] } });
  const start = game.setup();
  const picked = game.play(start, 0, pickOne);
  const pos = { state: start, hash: hashOf(start), moves: 0, turnHashes: [hashOf(start), hashOf(picked)] };
  const fromHost = [];
  const fromTraining = [];
  const a = await hostThink(host, net, 20, fromHost);
  assert.deepEqual(a, await directThink(env, pos, net, 20, fromTraining));
  assert.deepEqual(fromHost, fromTraining);
  assert.deepEqual(a, { kind: 'click', row: 0, col: 1 }, 'picking one again would come back to a position of this turn');

  // 세 수(maxActions)를 두면 무승부라 더 둘 수가 없습니다. 고르기만 한 행동은 수가 아닙니다
  const take = { kind: 'take' };
  const pickTwo = { kind: 'click', row: 0, col: 1 };
  await call(host, 'play', {
    moves: [{ player: 0, action: pickTwo }, { player: 0, action: take }, { player: 1, action: pickOne }, { player: 1, action: take }],
    look: { players: [] },
  });
  assert.notEqual(await hostThink(host, net, 5, []), null, 'two moves so far');
  await call(host, 'play', { moves: [{ player: 0, action: pickOne }, { player: 0, action: take }], look: { players: [] } });
  assert.equal(await hostThink(host, net, 5, []), null, 'three moves: a draw by maxActions');
});

test('think stops at its time limit before using up sims, and still picks a move', async () => {
  const host = createHost();
  await call(host, 'load', { module: new URL('index.js', TICTACTOE).href });
  await call(host, 'start', { seed: 1, look: { players: [] } });
  await call(host, 'ai', { lang: 'en' });
  const net = fakeNet(9);
  let asked = 0;
  let r = await call(host, 'think', { sims: 1000, ms: 60 });
  while (r.need) {
    asked++;
    await new Promise((ok) => setTimeout(ok, 10)); // 신경망 한 번에 10ms쯤
    r = await call(host, 'answer', net(r.need.planes));
  }
  assert.ok(r.done?.action, 'picks a move');
  assert.ok(asked >= 2 && asked < 30, `asked the network ${asked} times`);
});

test('a new think drops the search that was waiting, and answer needs a search', async () => {
  const host = createHost();
  await call(host, 'load', { module: new URL('index.js', TICTACTOE).href });
  await call(host, 'start', { seed: 1, look: { players: [] } });
  await assert.rejects(call(host, 'think', { sims: 5 }), /call ai first/);
  await call(host, 'ai', { lang: 'en' });
  const net = fakeNet(9);
  const first = await call(host, 'think', { sims: 5 });
  assert.equal(first.need.planes.length, 14 * 3 * 3);
  // 다른 탐색을 새로 시작해도 처음부터 끝까지 됩니다
  assert.ok(await hostThink(host, net, 5, []));
  await assert.rejects(call(host, 'answer', net(first.need.planes)), /nothing to answer/);
  // 수를 두면 기다리던 탐색은 버립니다
  await call(host, 'think', { sims: 5 });
  await call(host, 'play', { moves: [{ player: 0, action: { kind: 'click', row: 1, col: 1 } }], look: { players: [] } });
  await assert.rejects(call(host, 'answer', net(first.need.planes)), /nothing to answer/);
});
