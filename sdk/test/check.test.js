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

/** 칸을 눌러 고르고(다른 칸을 누르면 바꿈) 같은 칸을 다시 눌러야 두는 틱택토. 한 수가 행동 두 개 이상입니다 */
const pickToPlace = variant({
  setup: () => ({ ...tictactoe.setup(), sel: null }),
  play(state, player, action) {
    const { sel, ...inner } = state;
    const next = tictactoe.play(inner, player, action);
    if (next === inner) return state;
    const i = action.row * 3 + action.col;
    return sel === i ? { ...next, sel: null } : { ...state, sel: i };
  },
});

test('maxActions는 차례가 넘어간 수만 셉니다 (칸 고르기는 세지 않음)', () => {
  const r = checkGame(pickToPlace, opts);
  assert.deepEqual(r.problems, []);
  assert.equal(r.stats.tally.maxActions, 0, '9수 안에 끝나는 게임은 고르기가 많아도 maxActions(9)에 닿지 않습니다');
  assert.ok(r.stats.avgMoves >= 5 && r.stats.avgMoves <= 9);
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
  assert.ok(r.problems.some((p) => p.includes('Replaying the same seed')), r.problems.join('\n'));
});

test('받은 state를 고치면 걸립니다', () => {
  const play = (s, p, a) => {
    const next = tictactoe.play(s, p, a);
    s.touched = true;
    return next;
  };
  const r = checkGame(variant({ play }), opts);
  assert.ok(r.problems.some((p) => p.includes('changed the state it received')), r.problems.join('\n'));
});

test('state에 JSON이 아닌 값이 있으면 걸립니다', () => {
  const setup = () => ({ ...tictactoe.setup(), seen: new Set() });
  const r = checkGame(variant({ setup }), opts);
  assert.ok(r.problems.some((p) => p.includes('non-JSON value') && p.includes('Set')), r.problems.join('\n'));
});

test('행동이 계속 무시되기만 하면 진행 불가로 걸립니다', () => {
  const { legal, ...noLegal } = tictactoe; // legal()이 없으면 아무 칸이나 눌러 봅니다
  const r = checkGame({ ...noLegal, play: (s) => s }, opts);
  assert.ok(r.problems.some((p) => p.includes('got stuck')), r.problems.join('\n'));
});

test('게임 함수가 오류를 던지면 어느 함수인지 알려줍니다', () => {
  const r = checkGame(variant({ result: () => { throw new Error('boom'); } }), opts);
  assert.ok(r.problems.some((p) => p === 'result() threw an error: boom'), r.problems.join('\n'));
});

test('turn()이 없으면 걸립니다', () => {
  const { turn, ...noTurn } = tictactoe;
  assert.ok(checkMembers(noTurn).includes('turn(): missing (must be a function)'));
});

test('turn()이 play()와 어긋나면 걸립니다', () => {
  const r = checkGame(variant({ turn: (s) => (tictactoe.turn(s) === null ? null : 0) }), opts);
  assert.ok(r.problems.some((p) => p.includes('The two must agree')), r.problems.join('\n'));
});

test('판 그림이 언어에 따라 달라지면 걸립니다', () => {
  const view = (s, p, lang) => ({ ...tictactoe.view(s, p, lang), pieces: lang === 'en' ? [] : tictactoe.view(s, p, lang).pieces });
  const r = checkGame(variant({ view }), opts);
  assert.ok(r.problems.some((p) => p.includes('view() changes more than the message')), r.problems.join('\n'));
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
  assert.match(broken((t) => { t.view.pieces = Array.from({ length: 5000 }, () => ({ row: 0, col: 0, piece: 'x'.repeat(30) })); return t; })[0], /larger than/);
  assert.deepEqual(validateThumbnail(null), ['thumbnail: must be an object']);
});

test('썸네일의 테두리 두께와 선: hover가 있는 칠하기와 선은 빼고, 범위 밖의 두께는 막습니다', () => {
  const thumb = makeThumbnail(tictactoe, 0, {
    pieces: [],
    marks: [{ row: 0, col: 0, type: 'frame', color: 1, width: 4.5, extra: 1 }],
    tint: [{ row: 0, col: 1, color: 0 }, { row: 2, col: 1, color: 1, hover: { row: 2, col: 2 } }],
    lines: [
      { from: { row: 0, col: 0 }, to: { row: 2, col: 2, extra: 1 }, color: '#2563eb', width: 12 },
      { from: { row: 1, col: 1 }, to: { row: 0, col: 1 }, hover: { row: 1, col: 1 } },
    ],
  });
  assert.deepEqual(thumb.view.marks, [{ row: 0, col: 0, type: 'frame', color: 1, width: 4.5 }]);
  assert.deepEqual(thumb.view.lines, [{ from: { row: 0, col: 0 }, to: { row: 2, col: 2 }, color: '#2563eb', width: 12 }]);
  assert.deepEqual(thumb.view.tint, [{ row: 0, col: 1, color: 0 }]);
  assert.deepEqual(validateThumbnail(thumb), []);
  // 이름 붙은 색 (판 팔레트)
  assert.deepEqual(validateThumbnail({ ...thumb, view: { ...thumb.view, tint: [{ row: 0, col: 0, color: 'green' }] } }), []);
  assert.match(validateThumbnail({ ...thumb, view: { ...thumb.view, tint: [{ row: 0, col: 0, color: 'pink' }] } })[0], /thumbnail\.view\.tint/);
  // 썸네일을 직접 만든 경우: hover가 판 밖이면 막습니다
  assert.match(validateThumbnail({ ...thumb, view: { ...thumb.view, tint: [{ row: 0, col: 0, color: 0, hover: { row: 3, col: 0 } }] } })[0], /thumbnail\.view\.tint/);

  const broken = (f) => validateThumbnail(f(structuredClone(thumb)));
  assert.match(broken((t) => { t.view.marks[0].width = 31; return t; })[0], /thumbnail\.view\.marks/);
  assert.match(broken((t) => { t.view.marks[0].width = '5'; return t; })[0], /thumbnail\.view\.marks/);
  assert.match(broken((t) => { t.view.lines[0].width = 0.5; return t; })[0], /thumbnail\.view\.lines: .*width from 1 to 50/);
  assert.match(broken((t) => { t.view.lines[0].to.row = 3; return t; })[0], /thumbnail\.view\.lines/);
  assert.match(broken((t) => { t.view.lines[0].hover = { row: 9, col: 0 }; return t; })[0], /thumbnail\.view\.lines/);
  assert.match(broken((t) => { t.view.lines = {}; return t; })[0], /thumbnail\.view\.lines: must be a list/);
});

test('찍은 뒤 게임의 판이나 기물을 바꾸면 다시 찍으라고 합니다', () => {
  const thumb = makeThumbnail(tictactoe, 0, tictactoe.view(midGame(), 0, 'ko'));
  const bigger = variant({ board: { ...tictactoe.board, rows: 4 } });
  assert.match(checkThumbnail(bigger, thumb)[0], /board settings changed/);
  const custom = variant({ pieces: ['a', 'b'] });
  const problems = checkThumbnail(custom, thumb);
  assert.ok(problems.some((p) => p.includes('pieces changed')));
  assert.ok(problems.some((p) => p.includes("isn't in the game's pieces")));
  // 키 순서만 다른 board는 같은 것으로 봅니다
  const reordered = variant({ board: { look: 'plain', cols: 3, rows: 3, places: 'cells' } });
  assert.deepEqual(checkThumbnail(reordered, thumb), []);
});

test('글자 패: { name, text, player, arrows }를 이름과 섞어 쓸 수 있고, 썸네일은 이름으로 맞춥니다', () => {
  const tiles = [
    { name: 'x', text: '王', player: 0, arrows: ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] },
    { name: 'o', text: '侯爵' },
  ];
  assert.deepEqual(checkMembers({ ...tictactoe, pieces: tiles }), []);
  assert.deepEqual(checkMembers({ ...tictactoe, pieces: [...tiles, 'plain'] }), []);
  const bad = [
    { name: 'x', text: '三글자' }, { name: 'x', text: '' }, { name: '', text: '王' }, { name: 'x' },
    { name: 'x', text: '王', player: 2 }, { name: 'x', text: '王', player: null },
    { name: 'x', text: '王', arrows: ['up'] }, { name: 'x', text: '王', arrows: ['n', 'n'] }, { name: 'x', text: '王', arrows: 'n' },
    7, null, ['x'],
  ];
  for (const piece of bad) {
    assert.match(checkMembers({ ...tictactoe, pieces: [piece] }).join(), /pieces: must be/, JSON.stringify(piece));
  }
  // 썸네일은 기물 목록을 그대로 담고, 판의 기물이 목록의 이름인지 봅니다
  const game = variant({ pieces: tiles });
  const thumb = makeThumbnail(game, 0, tictactoe.view(midGame(), 0, 'ko'));
  assert.deepEqual(thumb.pieces, tiles);
  assert.deepEqual(checkThumbnail(game, thumb), []);
  assert.deepEqual(validateThumbnail({ ...thumb, pieces: [{ name: 'x', text: '王', player: 3 }] }), ["thumbnail.pieces: must look like the game's pieces"]);
});

test('판 밖 영역(areas): 판을 가운데에 남기고 겹치지 않아야 하며, 썸네일에도 남습니다', () => {
  // 13 × 12 판: 왼쪽 8열이 판, 오른쪽 4열에 영역 셋 (영역 사이의 빈 줄은 그리지 않는 칸)
  const board = {
    places: 'cells', rows: 13, cols: 12,
    areas: [
      { side: 'right', row: 0, col: 8, rows: 4, cols: 4 },
      { side: 'right', row: 5, col: 8, rows: 2, cols: 4 },
      { side: 'right', row: 8, col: 8, rows: 2, cols: 4 },
    ],
  };
  const game = variant({ board });
  assert.deepEqual(checkMembers(game), []);
  const bad = [
    [{ side: 'middle', row: 0, col: 0, rows: 1, cols: 1 }, /areas\[0\]: needs side/],
    [{ side: 'top', row: 0, col: 0, rows: 14, cols: 1 }, /areas\[0\]: needs side/],
    [{ side: 'top', row: 0, col: 10, rows: 1, cols: 3 }, /areas\[0\]: needs side/],
    [{ side: 'top', row: 0, col: 0, rows: 13, cols: 12 }, /leave the board in the middle/],
  ];
  for (const [area, msg] of bad) assert.match(checkMembers(variant({ board: { ...board, areas: [area] } })).join(), msg);
  assert.match(checkMembers(variant({ board: { ...board, areas: {} } })).join(), /board\.areas: must be a list/);
  assert.match(checkMembers(variant({ board: { ...board, areas: Array(9).fill(board.areas[0]) } })).join(), /up to 8/);
  // 위 영역이 오른쪽 영역의 열까지 걸치면 겹칩니다
  const overlapping = [...board.areas, { side: 'top', row: 0, col: 0, rows: 1, cols: 12 }];
  assert.match(checkMembers(variant({ board: { ...board, areas: overlapping } })).join(), /areas\[0\] and areas\[3\] overlap/);

  const thumb = makeThumbnail(game, 0, { pieces: [{ row: 0, col: 9, piece: 'x', from: { row: 12, col: 0 } }] });
  assert.deepEqual(thumb.board.areas, board.areas);
  assert.deepEqual(thumb.view.pieces, [{ row: 0, col: 9, piece: 'x' }]); // 움직임(from)은 썸네일에 넣지 않습니다
  assert.deepEqual(checkThumbnail(game, thumb), []);
  const withArea = variant({ board: { ...tictactoe.board, areas: [{ side: 'bottom', row: 2, col: 0, rows: 1, cols: 3 }] } });
  assert.match(checkThumbnail(tictactoe, makeThumbnail(withArea, 0, { pieces: [] }))[0], /board settings changed/);
  assert.match(validateThumbnail({ ...thumb, board: { ...board, areas: [{ side: 'top' }] } })[0], /thumbnail\.board\.areas\[0\]/);
});

test('버튼(buttons)의 글자는 언어마다 달라도 되고, specialActions에 없는 버튼은 경고합니다', () => {
  const words = { ko: '넘기기', en: 'Pass' };
  const withButtons = (kinds) => variant({
    specialActions: ['pass'],
    view: (s, p, lang) => ({ ...tictactoe.view(s, p, lang), buttons: kinds.map((kind) => ({ kind, label: words[lang] })) }),
  });
  const ok = checkGame(withButtons(['pass']), opts);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.warnings, []);
  const r = checkGame(withButtons(['pass', 'undo']), opts);
  assert.ok(r.warnings.some((w) => w.includes("view().buttons has 'undo'")), r.warnings.join('\n'));
  // 버튼의 행동이 언어마다 다르면 판 그림이 다른 것으로 봅니다
  const swapped = variant({
    specialActions: ['pass', 'skip'],
    view: (s, p, lang) => ({ ...tictactoe.view(s, p, lang), buttons: [{ kind: lang === 'ko' ? 'pass' : 'skip' }] }),
  });
  assert.ok(checkGame(swapped, opts).problems.some((x) => x.includes('view() changes more than the message')));
});

test('효과(effects): 아는 종류는 그대로 두고, 모르는 종류는 경고하며, 썸네일에는 넣지 않습니다', () => {
  const withEffects = (type) => variant({
    view: (s, p, lang) => ({ ...tictactoe.view(s, p, lang), effects: [{ row: 0, col: 0, piece: 'x', ...(type ? { type } : {}) }] }),
  });
  for (const type of [undefined, 'shatter']) {
    const ok = checkGame(withEffects(type), opts);
    assert.deepEqual(ok.problems, []);
    assert.deepEqual(ok.warnings, []);
  }
  const r = checkGame(withEffects('explode'), opts);
  assert.ok(r.warnings.some((w) => w.includes("view().effects has type 'explode'")), r.warnings.join('\n'));
  const thumb = makeThumbnail(tictactoe, 0, { pieces: [], effects: [{ row: 0, col: 0, piece: 'x' }] });
  assert.equal(thumb.view.effects, undefined);
});
