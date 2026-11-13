// moves()와 move()로 쓴 게임(playground/moves.js): 게임 API로 바뀌어 원래 검사를 통과하는지,
// 그리고 toGame()이 대신 하는 일(차례, 기물 고르기, 표시, 끝, 특수 행동, 이어서 두기)이 맞는지 봅니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import classic from '../../games/tictactoe/index.js';
import { checkGame, checkMembers } from '../check.js';
import checkersDef from '../examples/checkers/index.js';
import reversiDef from '../examples/reversi/index.js';
import twelveDef from '../examples/twelve/index.js';
import { buttonsOf } from '../playground/board.js';
import { toGame } from '../playground/moves.js';
import { makeRng, usesMoves } from '../playground/platform.js';
import template from '../template/index.js';

// npx boardmadang new가 만드는 게임 (틱택토). id만 폴더 이름 대신 넣습니다
const tictactoeDef = { ...template, id: 'tictactoe' };
const tictactoe = toGame(tictactoeDef);
const twelve = toGame(twelveDef);
const reversi = toGame(reversiDef);
const checkers = toGame(checkersDef);

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
/** 시작 상태에서 판만 바꾼 상태. cells는 { 'row,col': 값 } */
function withGrid(game, cells, turn = 0) {
  const start = game.setup(makeRng(1));
  const grid = start.game.grid.map((line, row) => line.map((_, col) => cells[`${row},${col}`] ?? null));
  return { ...start, turn, game: { ...start.game, grid } };
}
const cellsIn = (game, state, player) => game.legal(state, player).map((a) => (a.kind === 'click' ? `${a.row},${a.col}` : a.kind)).sort();
const marksOf = (game, state, player, type) => game.view(state, player, 'en').marks.filter((m) => m.type === type).map((m) => [m.row, m.col]);

test('예제 넷이 지금의 검사를 그대로 통과합니다 (랜덤 대국 200판, legal()과 play()가 어긋나지 않음)', () => {
  for (const game of [tictactoe, twelve, reversi, checkers]) {
    const r = checkGame(game, { n: 200, langs: ['ko', 'en'], random: seeded() });
    assert.deepEqual(r.problems, [], game.id);
    assert.deepEqual(r.warnings, [], game.id);
    assert.equal(r.stats.n, 200);
    assert.equal(r.stats.tally.stuck + r.stats.tally.noLegal, 0);
  }
});

test('이미 게임 API로 쓴 게임은 그대로 둡니다. 바꾸지 않은 채로 검사하면 어떻게 하라고 알려 줍니다', () => {
  assert.ok(usesMoves(tictactoeDef) && !usesMoves(classic) && !usesMoves(tictactoe));
  assert.equal(toGame(classic), classic);
  const p = checkMembers(tictactoeDef);
  assert.ok(p.length === 1 && p[0].includes('npx boardmadang pack'), p.join(' / '));
});

test('이긴 이유: winner()가 { winner, reason }을 주면 언어에 맞는 글자로 나옵니다', () => {
  const won = press(tictactoe, tictactoe.setup(makeRng(1)), [0, 0], [1, 0], [0, 1], [1, 1], [0, 2]);
  assert.deepEqual(tictactoe.result(won, 'ko'), { winner: 0, reason: '세 줄 완성' });
  assert.deepEqual(tictactoe.result(won, 'ja'), { winner: 0, reason: 'Three in a row' }, '적지 않은 언어는 영어로');
  const text = toGame({ ...tictactoeDef, winner: () => ({ winner: 'draw', reason: 'agreed' }) });
  assert.deepEqual(text.result(text.setup(makeRng(1)), 'ko'), { winner: null, reason: 'agreed' }, '글자 하나면 어느 언어든 그 글자');
});

test('틱택토(템플릿): 게임 API로 쓴 것(games/tictactoe)과 같은 판, 같은 결과입니다', () => {
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

// ---- 특수 행동 (리버시의 넘기기) ----

test('리버시: 뒤집을 수 있는 칸에만 두고, 사이에 낀 돌이 뒤집힙니다', () => {
  const start = reversi.setup(makeRng(1));
  assert.deepEqual(cellsIn(reversi, start, 0), ['2,3', '3,2', '4,5', '5,4']);
  const s = press(reversi, start, [2, 3]);
  assert.deepEqual([s.game.grid[2][3], s.game.grid[3][3], s.game.grid[4][3]], [0, 0, 0]);
  assert.equal(reversi.turn(s), 1);
  assert.equal(press(reversi, start, [0, 0]), start, '뒤집을 돌이 없는 칸은 무시합니다');
});

test('특수 행동: moves()에 있을 때만 누를 수 있고, 버튼 글자는 언어마다 나옵니다', () => {
  assert.deepEqual(reversi.specialActions, ['pass']);
  const start = reversi.setup(makeRng(1));
  // 둘 곳이 있으면 넘기기는 흐립니다 (화면이 쓰는 buttonsOf 그대로)
  assert.deepEqual(buttonsOf(reversi.specialActions, reversi.view(start, 0, 'ko'), reversi.legal(start, 0)), [{ kind: 'pass', label: '넘기기', disabled: true }]);
  assert.equal(reversi.view(start, 0, 'en').buttons[0].label, 'Pass');
  assert.equal(reversi.view(start, 0, 'ja').buttons[0].label, 'Pass', '적지 않은 언어는 영어로');
  assert.equal(reversi.play(start, 0, { kind: 'pass' }), start, '둘 곳이 있으면 넘기기를 무시합니다');

  // 검은 돌은 둘 곳이 없고 흰 돌은 있는 판: 넘기기만 됩니다
  const stuck = withGrid(reversi, { '0,0': 1, '0,1': 0 });
  assert.deepEqual(cellsIn(reversi, stuck, 0), ['pass']);
  assert.deepEqual(buttonsOf(reversi.specialActions, reversi.view(stuck, 0, 'en'), reversi.legal(stuck, 0)), [{ kind: 'pass', label: 'Pass', disabled: false }]);
  assert.equal(reversi.play(stuck, 0, click(0, 2)), stuck);
  const passed = reversi.play(stuck, 0, { kind: 'pass' });
  assert.equal(reversi.turn(passed), 1);
  assert.deepEqual(marksOf(reversi, passed, 0, 'last-move'), [], '넘기기에는 마지막 수 표시가 없습니다');
  // 흰 돌이 두면 둘 다 둘 곳이 없어 끝나고, 돌이 많은 쪽이 이깁니다
  const over = press(reversi, passed, [0, 2]);
  assert.deepEqual(reversi.result(over, 'en'), { winner: 1 });
});

test('특수 행동을 이름 목록으로만 적으면 버튼 글자는 그 이름입니다', () => {
  const game = toGame({
    id: 'only-pass', board: { places: 'cells', rows: 1, cols: 1 }, pieces: 'xo', specialActions: ['pass'],
    setup: () => ({ n: 0 }),
    moves: (s) => (s.n < 4 ? [{ special: 'pass' }] : []),
    move: (s) => { s.n += 1; },
    view: () => ({ pieces: [] }),
  });
  const start = game.setup(makeRng(1));
  assert.deepEqual(game.view(start, 0, 'ko').buttons, [{ kind: 'pass', label: 'pass' }]);
  assert.equal(game.play(start, 0, { kind: 'pass' }).game.n, 1);
  assert.deepEqual(checkGame(game, { n: 20, langs: ['ko', 'en'] }).problems, []);
});

// ---- 이어서 두기 (체커의 연속 뛰기) ----

test('체커: 잡을 수 있으면 반드시 잡고, 같은 기물로 더 잡을 수 있으면 차례가 넘어가지 않습니다', () => {
  const start = withGrid(checkers, { '5,2': 'm0', '7,0': 'm0', '4,3': 'm1', '2,5': 'm1', '0,1': 'm1' });
  assert.deepEqual(cellsIn(checkers, start, 0), ['5,2'], '한 칸 갈 수 있는 다른 졸(7,0)은 고를 수 없습니다');
  const first = press(checkers, start, [5, 2], [3, 4]);
  assert.equal(first.game.grid[4][3], null, '뛰어넘은 돌을 잡습니다');
  assert.equal(checkers.turn(first), 0, '더 잡을 수 있으니 차례는 그대로');
  assert.deepEqual(first.pick, { row: 3, col: 4 }, '옮긴 기물이 고른 채로 남습니다');
  assert.deepEqual(marksOf(checkers, first, 0, 'dot'), [[1, 6]]);
  assert.deepEqual(cellsIn(checkers, first, 0), ['1,6'], '뛰던 기물로만 이어서 둡니다');
  assert.equal(checkers.play(first, 1, click(0, 1)), first, '상대는 아직 둘 수 없습니다');
  const second = press(checkers, first, [1, 6]);
  assert.equal(second.game.grid[2][5], null);
  assert.equal(checkers.turn(second), 1);
  assert.equal(second.pick, null);
  assert.equal(second.game.jumping, null);
});

test('체커: 끝줄에 닿은 졸은 왕이 되고, 상대가 움직일 기물이 없으면 이깁니다', () => {
  const crowned = press(checkers, withGrid(checkers, { '1,2': 'm0', '5,6': 'm1' }), [1, 2], [0, 1]);
  assert.equal(crowned.game.grid[0][1], 'k0');
  assert.deepEqual(checkers.view(crowned, 0, 'en').text, [{ row: 0, col: 1, text: 'K' }]);
  // 왕은 뒤로도 갑니다
  const king = withGrid(checkers, { '3,2': 'k0', '7,6': 'm1' });
  assert.deepEqual(marksOf(checkers, press(checkers, king, [3, 2]), 0, 'dot').sort(), [[2, 1], [2, 3], [4, 1], [4, 3]]);
  const won = press(checkers, withGrid(checkers, { '5,2': 'm0', '4,3': 'm1' }), [5, 2], [3, 4]);
  assert.deepEqual(checkers.result(won, 'en'), { winner: 0, reason: 'No moves left' });
});

test("이어서 두기: 'again'을 돌려줬어도 둘 수가 없으면 차례를 넘깁니다", () => {
  const game = toGame({
    id: 'again', board: { places: 'cells', rows: 1, cols: 2 }, pieces: 'xo',
    setup: () => ({ left: 3 }),
    // 선공만 세 번까지 이어서 둡니다
    moves: (s, player) => (player === 0 && s.left > 0 ? [{ row: 0, col: 0 }] : player === 1 ? [{ row: 0, col: 1 }] : []),
    move(s, m, player) {
      if (player === 0) s.left -= 1;
      return 'again';
    },
    view: () => ({ pieces: [] }),
  });
  let s = game.setup(makeRng(1));
  for (const left of [2, 1]) {
    s = game.play(s, 0, click(0, 0));
    assert.deepEqual([s.game.left, game.turn(s)], [left, 0]);
  }
  s = game.play(s, 0, click(0, 0));
  assert.deepEqual([s.game.left, game.turn(s)], [0, 1], '선공이 더 둘 수 없으니 후공 차례');
});
