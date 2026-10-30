import { test } from 'node:test';
import assert from 'node:assert/strict';
import tictactoe from '../../games/tictactoe/index.js';
import { checkGame, checkMembers, checkThumbnail, makeThumbnail, validateThumbnail } from '../check.js';

/** 결정적인 난수 (검사가 매번 같은 판을 두게) */
function seeded(seed = 1) {
  let a = seed;
  return () => {
    a = (a * 1103515245 + 12345) % 2 ** 31;
    return a / 2 ** 31;
  };
}

const opts = { n: 30, langs: ['ko', 'en'], random: seeded() };

/** 틱택토를 바탕으로 한 곳만 고친 게임 */
const variant = (over) => ({ ...tictactoe, ...over });

test('틱택토는 검사를 통과합니다', () => {
  const r = checkGame(tictactoe, opts);
  assert.deepEqual(r.problems, []);
  assert.equal(r.stats.n, 30);
  assert.equal(r.stats.tally[0] + r.stats.tally[1] + r.stats.tally.draw + r.stats.tally.maxActions, 30);
});

test('필수 멤버가 없으면 대국을 두지 않고 멈춥니다', () => {
  const r = checkGame({ id: 'Bad Id', board: { places: 'cells', rows: 40, cols: 3 }, pieces: 'xo', maxActions: 9 }, opts);
  assert.equal(r.stats, null);
  assert.ok(r.problems.some((p) => p.startsWith('id:')));
  assert.ok(r.problems.some((p) => p.startsWith('board.rows:')));
  assert.ok(r.problems.some((p) => p.startsWith('play():')));
  assert.deepEqual(checkMembers(tictactoe), []);
});

test('Math.random()을 쓰면 결정성 검사에 걸립니다', () => {
  const play = (s, p, a) => ({ ...tictactoe.play(s, p, a), noise: Math.random() });
  const r = checkGame(variant({ play }), opts);
  assert.ok(r.problems.some((p) => p.includes('같은 시드·같은 행동')), r.problems.join('\n'));
});

test('받은 state를 고치면 걸립니다', () => {
  const play = (s, p, a) => {
    const next = tictactoe.play(s, p, a);
    s.touched = true;
    return next;
  };
  const r = checkGame(variant({ play }), opts);
  assert.ok(r.problems.some((p) => p.includes('state를 고쳤습니다')), r.problems.join('\n'));
});

test('state에 JSON이 아닌 값이 있으면 걸립니다', () => {
  const setup = () => ({ ...tictactoe.setup(), seen: new Set() });
  const r = checkGame(variant({ setup }), opts);
  assert.ok(r.problems.some((p) => p.includes('JSON이 아닌 값') && p.includes('Set')), r.problems.join('\n'));
});

test('행동이 계속 무시되기만 하면 진행 불가로 걸립니다', () => {
  const { legal, ...noLegal } = tictactoe; // legal()이 없으면 아무 칸이나 눌러 봅니다
  const r = checkGame({ ...noLegal, play: (s) => s }, opts);
  assert.ok(r.problems.some((p) => p.includes('진행되지 않은 판')), r.problems.join('\n'));
});

test('게임 함수가 오류를 던지면 어느 함수인지 알려줍니다', () => {
  const r = checkGame(variant({ result: () => { throw new Error('펑'); } }), opts);
  assert.ok(r.problems.some((p) => p === 'result()에서 오류: 펑'), r.problems.join('\n'));
});

test('판 그림이 언어에 따라 달라지면 걸립니다', () => {
  const view = (s, p, lang) => ({ ...tictactoe.view(s, p, lang), pieces: lang === 'en' ? [] : tictactoe.view(s, p, lang).pieces });
  const r = checkGame(variant({ view }), opts);
  assert.ok(r.problems.some((p) => p.includes('view()가 lang에 따라')), r.problems.join('\n'));
});

// ---- 썸네일 ----

function midGame() {
  let s = tictactoe.setup();
  s = tictactoe.play(s, 0, { kind: 'click', row: 1, col: 1 });
  s = tictactoe.play(s, 1, { kind: 'click', row: 0, col: 0 });
  return s;
}

test('썸네일은 판 설정, 기물 세트, 화면을 담고 글자(message)는 뺍니다', () => {
  const thumb = makeThumbnail(tictactoe, 0, tictactoe.view(midGame(), 0, 'ko'));
  assert.deepEqual(thumb.board, tictactoe.board);
  assert.equal(thumb.pieces, 'xo');
  assert.equal(thumb.player, 0);
  assert.equal(thumb.view.message, undefined);
  assert.deepEqual(thumb.view.pieces, [{ row: 0, col: 0, piece: 'o' }, { row: 1, col: 1, piece: 'x' }]);
  assert.deepEqual(validateThumbnail(thumb), []);
  assert.deepEqual(checkThumbnail(tictactoe, thumb), []);
});

test('썸네일 모양 검사', () => {
  const thumb = makeThumbnail(tictactoe, 1, tictactoe.view(midGame(), 1, 'ko'));
  const broken = (f) => validateThumbnail(f(structuredClone(thumb)));
  assert.match(broken((t) => { t.view.pieces[0].row = 3; return t; })[0], /thumbnail\.view\.pieces/);
  assert.match(broken((t) => { t.view.marks = [{ row: 0, col: 0, type: 'sparkle' }]; return t; })[0], /thumbnail\.view\.marks/);
  assert.match(broken((t) => { t.view.tint = [{ row: 0, col: 0, color: 'red' }]; return t; })[0], /thumbnail\.view\.tint/);
  assert.match(broken((t) => { t.player = 2; return t; })[0], /thumbnail\.player/);
  assert.match(broken((t) => { t.board.rows = 0; return t; })[0], /thumbnail\.board\.rows/);
  assert.match(broken((t) => { t.view.pieces = Array.from({ length: 5000 }, () => ({ row: 0, col: 0, piece: 'x'.repeat(30) })); return t; })[0], /KB를 넘습니다/);
  assert.deepEqual(validateThumbnail(null), ['썸네일: 객체가 필요합니다']);
});

test('찍은 뒤 게임의 판이나 기물을 바꾸면 다시 찍으라고 합니다', () => {
  const thumb = makeThumbnail(tictactoe, 0, tictactoe.view(midGame(), 0, 'ko'));
  const bigger = variant({ board: { ...tictactoe.board, rows: 4 } });
  assert.match(checkThumbnail(bigger, thumb)[0], /board 설정이 바뀌었습니다/);
  const custom = variant({ pieces: ['a', 'b'] });
  const problems = checkThumbnail(custom, thumb);
  assert.ok(problems.some((p) => p.includes('pieces가 바뀌었습니다')));
  assert.ok(problems.some((p) => p.includes('pieces에 없는 기물')));
  // 키 순서만 다른 board는 같은 것으로 봅니다
  const reordered = variant({ board: { look: 'plain', cols: 3, rows: 3, places: 'cells' } });
  assert.deepEqual(checkThumbnail(reordered, thumb), []);
});
