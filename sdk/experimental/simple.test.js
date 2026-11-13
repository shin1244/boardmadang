// 시제품(simple.js)의 테스트: "둘 수 있는 수" 형태로 쓴 게임이 지금의 게임 API로 바뀌어 원래 검사를 통과하는지,
// 그리고 플랫폼이 대신 하는 일(차례, 기물 고르기, 표시, 끝)이 맞는지 봅니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import classic from '../../games/tictactoe/index.js';
import { checkGame } from '../check.js';
import { makeRng } from '../playground/platform.js';
import { isSimple, toGame } from './simple.js';
import tictactoeDef from './tictactoe/index.js';
import twelveDef from './twelve/index.js';

const tictactoe = toGame(tictactoeDef);
const twelve = toGame(twelveDef);

function seeded(seed = 1) {
  let a = seed;
  return () => {
    a = (a * 1103515245 + 12345) % 2 ** 31;
    return a / 2 ** 31;
  };
}
const click = (row, col) => ({ kind: 'click', row, col });
/** 둘 차례인 플레이어가 칸들을 차례로 누릅니다 (기물 누르기 → 갈 곳 누르기) */
const press = (game, state, ...cells) => cells.reduce((s, [row, col]) => game.play(s, game.turn(s), click(row, col)), state);
const marksOf = (game, state, player, type) => game.view(state, player, 'en').marks.filter((m) => m.type === type).map((m) => [m.row, m.col]);

test('두 예제가 지금의 검사를 그대로 통과합니다 (랜덤 대국 200판, legal()과 play()가 어긋나지 않음)', () => {
  for (const game of [tictactoe, twelve]) {
    const r = checkGame(game, { n: 200, langs: ['ko', 'en'], random: seeded() });
    assert.deepEqual(r.problems, [], game.id);
    assert.deepEqual(r.warnings, [], game.id);
    assert.equal(r.stats.n, 200);
    assert.equal(r.stats.tally.stuck + r.stats.tally.noLegal, 0);
  }
});

test('이미 지금의 API로 쓴 게임은 그대로 둡니다', () => {
  assert.ok(isSimple(tictactoeDef) && !isSimple(classic));
  assert.equal(toGame(classic), classic);
});

test('틱택토: 지금 형태로 쓴 것(games/tictactoe)과 같은 판, 같은 결과입니다', () => {
  const random = seeded(7);
  const piecesOf = (game, s) => game.view(s, 0, 'en').pieces.map((p) => `${p.row},${p.col},${p.piece}`).sort();
  for (let n = 0; n < 300; n++) {
    let a = classic.setup(makeRng(n));
    let b = tictactoe.setup(makeRng(n));
    for (let i = 0; i < 30 && !classic.result(a, 'en'); i++) {
      // 차례가 아닌 쪽의 수와 찬 칸의 수도 섞어서, 양쪽이 똑같이 무시하는지 봅니다
      const player = random() < 0.8 ? classic.turn(a) : 1 - classic.turn(a);
      const action = click(Math.floor(random() * 3), Math.floor(random() * 3));
      a = classic.play(a, player, action);
      b = tictactoe.play(b, player, action);
      assert.deepEqual(piecesOf(tictactoe, b), piecesOf(classic, a));
      assert.equal(tictactoe.turn(b), classic.turn(a));
    }
    assert.equal(tictactoe.result(b, 'en')?.winner, classic.result(a, 'en')?.winner);
  }
});

test('받은 상태는 고치지 않습니다 (move()가 상태를 그대로 고쳐도)', () => {
  const start = twelve.setup(makeRng(1));
  const before = JSON.stringify(start);
  const next = press(twelve, start, [3, 1], [2, 1]);
  assert.equal(JSON.stringify(start), before);
  assert.notEqual(JSON.stringify(next), before);
});

test('기물 고르기: 누르면 고르고, 다른 기물을 누르면 바꾸고, 다시 누르면 취소합니다. 차례는 그대로입니다', () => {
  const start = twelve.setup(makeRng(1));
  const picked = press(twelve, start, [3, 1]);
  assert.deepEqual(picked.pick, { row: 3, col: 1 });
  assert.equal(twelve.turn(picked), 0);
  // 고른 기물과 갈 곳은 둘 차례인 플레이어에게만 보입니다
  assert.deepEqual(marksOf(twelve, picked, 0, 'ring'), [[3, 1]]);
  assert.deepEqual(marksOf(twelve, picked, 0, 'dot'), [[2, 1]]);
  assert.deepEqual(marksOf(twelve, picked, 1, 'ring'), []);
  assert.deepEqual(marksOf(twelve, picked, 1, 'dot'), []);
  assert.deepEqual(press(twelve, picked, [4, 1]).pick, { row: 4, col: 1 }, '다른 기물로 바꿈');
  assert.equal(press(twelve, picked, [3, 1]).pick, null, '다시 누르면 취소');
  // 갈 수 없는 칸, 상대 기물, 차례가 아닌 쪽: 아무 일도 없습니다 (같은 상태를 그대로 돌려줌)
  assert.equal(press(twelve, picked, [3, 0]), picked);
  assert.equal(press(twelve, start, [1, 1]), start);
  assert.equal(twelve.play(start, 1, click(2, 1)), start);
  // legal(): 고르기 전에는 움직일 수 있는 내 기물, 고른 뒤에는 갈 곳과 바꿀 수 있는 다른 기물
  const cells = (s, p) => twelve.legal(s, p).map((a) => `${a.row},${a.col}`).sort();
  assert.deepEqual(cells(start, 0), ['3,1', '4,1', '4,2']);
  assert.deepEqual(cells(picked, 0), ['2,1', '4,1', '4,2']);
  assert.deepEqual(cells(start, 1), []);
});

test('한 수를 두면: 차례가 넘어가고, 마지막 수와 움직임이 화면에 붙습니다', () => {
  const s = press(twelve, twelve.setup(makeRng(1)), [3, 1], [2, 1]);
  assert.equal(twelve.turn(s), 1);
  assert.equal(s.pick, null);
  for (const player of [0, 1]) assert.deepEqual(marksOf(twelve, s, player, 'last-move'), [[2, 1]]);
  const moved = twelve.view(s, 0, 'en').pieces.find((p) => p.row === 2 && p.col === 1);
  assert.deepEqual(moved, { row: 2, col: 1, piece: 's0', from: { row: 3, col: 1 } });
  assert.equal(twelve.view(s, 0, 'ko').message, '상대 차례');
  assert.equal(twelve.view(s, 1, 'ko').message, '내 차례');
  assert.equal(twelve.view(s, 1, 'ja').message, 'Your turn', '한국어와 영어 말고는 영어로');
});

test('십이장기: 잡은 기물은 손에 들어오고, 상대 진영이 아닌 빈칸에 내려놓습니다', () => {
  let s = press(twelve, twelve.setup(makeRng(1)), [3, 1], [2, 1]); // 빨강 자가 파랑 자를 잡음
  assert.deepEqual(s.game.hands[0], { e: 0, g: 0, s: 1 });
  s = press(twelve, s, [1, 1], [2, 1]); // 파랑 왕이 그 자를 잡음
  assert.deepEqual(s.game.hands[1], { e: 0, g: 0, s: 1 });
  s = press(twelve, s, [5, 2]); // 빨강이 손의 자를 고름
  assert.deepEqual(marksOf(twelve, s, 0, 'dot').sort(), [[2, 0], [2, 2], [3, 0], [3, 1], [3, 2]], '비어 있어도 상대 진영(1번 줄)에는 못 놓습니다');
  s = press(twelve, s, [3, 1]);
  assert.equal(s.game.grid[3][1], 's0');
  assert.equal(s.game.hands[0].s, 0);
  assert.deepEqual(twelve.view(s, 0, 'en').pieces.find((p) => p.row === 3 && p.col === 1).from, { row: 5, col: 2 }, '손에서 판으로 움직여 옵니다');
});

test('십이장기: 자가 상대 진영에 닿으면 후가 되고, 잡힌 후는 자로 돌아옵니다', () => {
  let s = press(twelve, twelve.setup(makeRng(1)), [3, 1], [2, 1], /* 파랑 왕이 비킴 */ [1, 1], [2, 0], [2, 1], [1, 1]);
  assert.equal(s.game.grid[1][1], 'l0');
  s = press(twelve, s, [1, 0], [1, 1]); // 파랑 장이 후를 잡음
  assert.equal(s.game.grid[1][1], 'g1');
  assert.deepEqual(s.game.hands[1], { e: 0, g: 0, s: 1 });
});

test('십이장기: 왕을 잡으면 이기고, 왕이 상대 진영에 들어가 한 차례를 버티면 이깁니다', () => {
  const start = twelve.setup(makeRng(1));
  // 왕 잡기
  const taken = press(twelve, start, [3, 1], [2, 1], [1, 0], [2, 0], [2, 1], [1, 1]);
  assert.deepEqual(twelve.result(taken, 'en'), { winner: 0 });
  assert.equal(twelve.turn(taken), null);
  assert.equal(twelve.view(taken, 0, 'ko').message, '이겼습니다!');
  assert.equal(twelve.view(taken, 1, 'ko').message, '졌습니다');
  assert.equal(press(twelve, taken, [4, 1]), taken, '끝난 판에서는 아무 수도 받지 않습니다');
  // 파랑 왕이 빨강 진영으로 들어감 (4번 줄)
  const entered = press(twelve, start, [3, 1], [2, 1], [1, 1], [2, 0], [2, 1], [1, 1], [2, 0], [3, 0], [4, 1], [3, 1], [3, 0], [4, 0]);
  assert.equal(entered.game.entered, 1);
  assert.equal(twelve.result(entered, 'en'), null, '아직 빨강이 잡을 기회가 있습니다');
  assert.deepEqual(twelve.result(press(twelve, entered, [3, 1], [4, 0]), 'en'), { winner: 0 }, '바로 잡으면 빨강이 이김');
  assert.deepEqual(twelve.result(press(twelve, entered, [4, 2], [3, 2]), 'en'), { winner: 1 }, '못 잡으면 파랑이 이김');
});

test('같은 판이 세 번 나오면 무승부입니다 (repeat: 3)', () => {
  const back = [[4, 2], [3, 2], [1, 0], [2, 0], [3, 2], [4, 2], [2, 0], [1, 0]]; // 양쪽 장이 나갔다 돌아옴
  let s = press(twelve, twelve.setup(makeRng(1)), ...back);
  assert.equal(twelve.result(s, 'en'), null, '두 번째');
  s = press(twelve, s, ...back);
  assert.deepEqual(twelve.result(s, 'ko'), { winner: null, reason: '같은 판이 다시 나옴' });
  assert.equal(twelve.view(s, 0, 'en').message, 'Draw');
});

test('둘 수 있는 수가 없으면 무승부(기본)이거나, noMoves: lose면 그 플레이어가 집니다', () => {
  // 선공이 한 번 두면 후공은 둘 곳이 없는 게임
  const def = {
    id: 'one-move', board: { places: 'cells', rows: 1, cols: 1 }, pieces: 'xo',
    setup: () => ({ done: false }),
    moves: (s) => (s.done ? [] : [{ row: 0, col: 0 }]),
    move: (s) => { s.done = true; },
    view: () => ({ pieces: [] }),
  };
  for (const [noMoves, winner] of [[undefined, null], ['lose', 0]]) {
    const game = toGame({ ...def, noMoves });
    const s = game.play(game.setup(makeRng(1)), 0, click(0, 0));
    assert.deepEqual(game.result(s, 'en'), { winner, reason: 'No moves left' });
    assert.equal(game.maxActions, 300, '안 적으면 300');
    assert.deepEqual(checkGame(game, { n: 20, langs: ['ko', 'en'] }).problems, []);
  }
});
