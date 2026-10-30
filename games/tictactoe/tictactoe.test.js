import { test } from 'node:test';
import assert from 'node:assert/strict';
import game from './index.js';

const click = (row, col) => ({ kind: 'click', row, col });

/** 행동을 [player, row, col] 순서대로 적용합니다. */
function replay(moves) {
  let s = game.setup();
  for (const [p, r, c] of moves) s = game.play(s, p, click(r, c));
  return s;
}

test('가로 세 줄이면 선공 승리', () => {
  const s = replay([[0, 0, 0], [1, 1, 0], [0, 0, 1], [1, 1, 1], [0, 0, 2]]);
  assert.deepEqual(game.result(s), { winner: 0, reason: '세 줄 완성' });
  assert.equal(game.view(s, 0).message, '이겼습니다!');
  assert.equal(game.view(s, 1).message, '졌습니다');
  assert.equal(game.view(s, 0).tint.length, 3);
});

test('판이 가득 차면 무승부', () => {
  // x o x / x o o / o x x
  const s = replay([
    [0, 0, 0], [1, 0, 1], [0, 0, 2], [1, 1, 1], [0, 1, 0],
    [1, 1, 2], [0, 2, 1], [1, 2, 0], [0, 2, 2],
  ]);
  assert.deepEqual(game.result(s), { winner: null, reason: '판이 가득 참' });
});

test('둘 수 없는 행동은 상태를 그대로 돌려준다', () => {
  const s0 = game.setup();
  assert.equal(game.play(s0, 1, click(0, 0)), s0, '남의 차례');
  assert.equal(game.play(s0, 0, click(3, 0)), s0, '판 밖');
  assert.equal(game.play(s0, 0, click(0.5, 0)), s0, '정수가 아님');
  assert.equal(game.play(s0, 0, { kind: 'pass' }), s0, '선언하지 않은 특수 행동');

  const s1 = game.play(s0, 0, click(1, 1));
  assert.equal(game.play(s1, 1, click(1, 1)), s1, '이미 놓인 칸');

  const won = replay([[0, 0, 0], [1, 1, 0], [0, 0, 1], [1, 1, 1], [0, 0, 2]]);
  assert.equal(game.play(won, 1, click(2, 2)), won, '끝난 판');
});

test('받은 state를 고치지 않는다', () => {
  const s0 = game.setup();
  const before = JSON.stringify(s0);
  game.play(s0, 0, click(1, 1));
  assert.equal(JSON.stringify(s0), before);
});

test('legal은 내 차례의 빈칸만 돌려준다', () => {
  const s = game.play(game.setup(), 0, click(1, 1));
  assert.equal(game.legal(s, 0).length, 0);
  assert.equal(game.legal(s, 1).length, 8);
});

test('랜덤 대국은 항상 9수 안에 끝나고, 상태는 JSON으로 왕복된다', () => {
  let seed = 1;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };

  for (let g = 0; g < 1000; g++) {
    let s = game.setup();
    let n = 0;
    while (!game.result(s)) {
      const p = s.turn;
      const moves = game.legal(s, p);
      s = game.play(s, p, moves[rand(moves.length)]);
      n++;
      assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
    }
    assert.ok(n <= 9);
  }
});
