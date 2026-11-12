// 렌더러(sdk/playground/board.js)에서 화면 없이 셀 수 있는 부분: 판 밖 영역의 배치, 클릭 옮기기(aliases), 버튼, 움직임, 효과, 내 차례 테두리
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardView, PLAYER_COLORS, attachInput, buttonsOf, fieldOf, knowsPiece, listsOf, paintPlayerDot } from '../playground/board.js';

// 캔버스 없이 BoardView를 만듭니다. 그리기 함수는 아무것도 하지 않고 부른 것만 적어 둡니다
globalThis.window ??= { devicePixelRatio: 1 };
function fakeCanvas() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : (...args) => {
      calls.push([k, ...args]);
      return { addColorStop() {} };
    }),
    set: (o, k, v) => {
      o[k] = v;
      return true;
    },
  });
  const listeners = {};
  return {
    calls,
    style: {},
    width: 0,
    height: 0,
    getContext: () => ctx,
    // 화면에 그려진 크기는 캔버스 크기 그대로 (화면 배율 1, CSS로 늘이지 않음)
    getBoundingClientRect() {
      return { left: 0, top: 0, width: this.width, height: this.height };
    },
    addEventListener: (k, f) => {
      listeners[k] = f;
    },
    fire: (k, e) => listeners[k]?.({ timeStamp: 1e9, ...e }),
    setPointerCapture() {},
  };
}
const at = (x, y) => ({ clientX: x, clientY: y });

const tall = {
  places: 'cells', rows: 13, cols: 12,
  areas: [
    { side: 'right', row: 0, col: 8, rows: 4, cols: 4 },
    { side: 'right', row: 5, col: 8, rows: 2, cols: 4 },
  ],
};

test('fieldOf: 영역을 뺀 가운데 판', () => {
  assert.deepEqual(fieldOf({ rows: 3, cols: 3 }), { field: { top: 0, bottom: 3, left: 0, right: 3 }, areas: [], problems: [] });
  assert.deepEqual(fieldOf(tall).field, { top: 0, bottom: 13, left: 0, right: 8 });
  const both = fieldOf({
    rows: 10, cols: 5,
    areas: [{ side: 'top', row: 0, col: 0, rows: 2, cols: 5 }, { side: 'bottom', row: 8, col: 1, rows: 2, cols: 3 }],
  });
  assert.deepEqual(both.field, { top: 2, bottom: 8, left: 0, right: 5 });
  // 틀렸으면 영역 없이 판 전체
  const bad = fieldOf({ rows: 3, cols: 3, areas: [{ side: 'top', row: 0, col: 0, rows: 3, cols: 3 }] });
  assert.deepEqual(bad.areas, []);
  assert.deepEqual(bad.field, { top: 0, bottom: 3, left: 0, right: 3 });
  assert.equal(bad.problems.length, 1);
});

test('listsOf: 판 옆 목록은 4개까지, at은 판의 칸, rows · cols는 1~32, scale은 0.25~1 (없으면 1)', () => {
  const of = (lists) => listsOf({ rows: 5, cols: 6, lists });
  assert.deepEqual(of(undefined), { lists: [], problems: [] });
  assert.deepEqual(of([{ at: { row: 4, col: 5, x: 1 }, rows: 32, cols: 1, y: 2 }]).lists, [{ at: { row: 4, col: 5 }, rows: 32, cols: 1, scale: 1 }]);
  assert.equal(of([{ at: { row: 0, col: 0 }, rows: 2, cols: 2, scale: 0.25 }]).lists[0].scale, 0.25);
  const one = { at: { row: 0, col: 0 }, rows: 2, cols: 2 };
  assert.equal(of([one, one, one, one]).lists.length, 4);
  for (const bad of [
    {}, [one, one, one, one, one], [null], [{ ...one, at: { row: 5, col: 0 } }], [{ ...one, at: { row: 0 } }],
    [{ ...one, rows: 33 }], [{ ...one, cols: 0 }], [{ ...one, scale: 0.2 }], [{ ...one, scale: 1.5 }], [{ ...one, scale: '0.5' }],
  ]) {
    const r = of(bad);
    assert.deepEqual(r.lists, [], JSON.stringify(bad));
    assert.equal(r.problems.length, 1, JSON.stringify(bad));
  }
});

// 왼쪽 패널(0~2줄, 0~3열) 아래에 반 크기 목록. 판은 4~9열
const withList = (list) => ({
  places: 'cells', rows: 10, cols: 10,
  areas: [{ side: 'left', row: 0, col: 0, rows: 3, cols: 4 }],
  lists: [{ at: { row: 4, col: 0 }, rows: 6, cols: 8, scale: 0.5, ...list }],
});
const near = (a, b) => Math.abs(a - b) < 0.01;

test('판 옆 목록(lists): at 칸의 왼쪽 위 귀퉁이에서 작은 칸으로 놓이고, 판 배치와 캔버스 크기는 그대로입니다', () => {
  const canvas = fakeCanvas();
  const b = new BoardView(canvas, withList(), 'go-stones');
  b.resize(480);
  const ref = new BoardView(fakeCanvas(), { ...withList(), lists: undefined }, 'go-stones');
  ref.resize(480);
  assert.equal(b.S, ref.S);
  assert.equal(b.width, ref.width);
  assert.equal(b.height, ref.height);
  assert.deepEqual(b.center(4, 0), ref.center(4, 0));
  const { S } = b;
  const [ax, ay] = b.center(4, 0);
  // 칸 간격은 반 칸, 첫 칸은 at 칸의 왼쪽 위 귀퉁이에서 시작하고, 8칸이 위 패널의 4칸 폭과 같습니다
  assert.ok(near(b.listCenter(0, 0, 0)[0], ax - S / 2 + S / 4));
  assert.ok(near(b.listCenter(0, 0, 0)[1], ay - S / 2 + S / 4));
  assert.ok(near(b.listCenter(0, 1, 1)[0] - b.listCenter(0, 0, 0)[0], S / 2));
  assert.ok(near(b.listCenter(0, 1, 1)[1] - b.listCenter(0, 0, 0)[1], S / 2));
  assert.ok(near(b.listCenter(0, 0, 7)[0] + S / 4, b.center(0, 3)[0] + S / 2));
  // 목록은 누를 수 없습니다. 판 위에 겹친 목록이면 그 아래 칸도
  const over = new BoardView(fakeCanvas(), { places: 'cells', rows: 4, cols: 4, lists: [{ at: { row: 0, col: 0 }, rows: 2, cols: 2 }] }, 'go-stones');
  over.resize(200);
  assert.equal(over.cellAt(at(...over.center(1, 1)), false), null);
  assert.deepEqual(over.cellAt(at(...over.center(2, 2)), false), { row: 2, col: 2 });
  // 목록의 기물은 목록 칸에 반 크기로 그립니다 (ctx.scale). 없는 목록이나 목록 밖의 칸은 그리지 않습니다
  const scaled = () => canvas.calls.filter(([k]) => k === 'scale');
  canvas.calls.length = 0;
  b.draw({ pieces: [{ row: 5, col: 5, piece: 'black' }] });
  assert.equal(scaled().length, 0);
  b.draw({ pieces: [], lists: [{ pieces: [{ row: 5, col: 7, piece: 'black' }] }] });
  assert.deepEqual(scaled()[0], ['scale', 0.5, 0.5]);
  const bad = { pieces: [], lists: [{ pieces: [{ row: 6, col: 0, piece: 'black' }, { row: 0, col: 8, piece: 'black' }, { row: 0, col: 0 }] }, { pieces: [{ row: 0, col: 0, piece: 'black' }] }] };
  assert.deepEqual(b.listPieces(bad), []);
});

test('판 옆 목록(lists): 뒤집으면 at 칸의 오른쪽 아래 귀퉁이에서 반대로 자라고, 넘치면 캔버스가 커집니다', () => {
  const b = new BoardView(fakeCanvas(), withList(), 'go-stones');
  b.resize(480);
  const { S } = b;
  // 뒤집은 화면: 목록 안은 뒤집지 않고, 마지막 칸이 at 칸의 오른쪽 아래 귀퉁이에 닿습니다
  const [fx, fy] = b.center(4, 0, true);
  assert.ok(near(b.listCenter(0, 5, 7, true)[0], fx + S / 2 - S / 4));
  assert.ok(near(b.listCenter(0, 5, 7, true)[1], fy + S / 2 - S / 4));
  assert.ok(b.listCenter(0, 0, 0, true)[0] < b.listCenter(0, 0, 7, true)[0]);
  // 20줄 × 반 칸 = 10칸: 4줄에서 시작하면 판 아래로 나가므로 캔버스가 그만큼 커지고,
  // 뒤집은 화면에서는 위로 나가므로 모든 자리가 아래로 옮겨집니다
  const long = new BoardView(fakeCanvas(), withList({ rows: 20 }), 'go-stones');
  long.resize(2000);
  const ref = new BoardView(fakeCanvas(), { ...withList(), lists: undefined }, 'go-stones');
  ref.resize(2000);
  assert.equal(long.S, ref.S);
  assert.ok(long.height > ref.height);
  for (const flip of [false, true]) {
    const box = long.place(flip).lists[0];
    assert.ok(box.y[0] - long.pad > -0.01, `flip=${flip}`);
    assert.ok(box.y[1] + long.pad < long.height + 0.01, `flip=${flip}`);
    assert.ok(near(box.y[1] - box.y[0], 10 * long.S));
  }
  assert.ok(Math.abs(long.place(false).lists[0].y[1] + long.pad - long.height) < 1);
  assert.ok(near(long.place(true).lists[0].y[0] - long.pad, 0));
});

test('판 옆 목록(lists): 목록과 판을 오가는 기물(from: { list, row, col })은 자리와 크기가 함께 바뀝니다', () => {
  const b = new BoardView(fakeCanvas(), withList(), 'go-stones');
  b.resize(480);
  // 목록 0줄 0열 → 판 5줄 5열
  const p = { row: 5, col: 5, piece: 'black', from: { list: 0, row: 0, col: 0 } };
  b.draw({ pieces: [p] });
  assert.equal(b.motions.length, 1);
  const t0 = b.motions[0].t0;
  assert.deepEqual(b.movingAt(p, false, t0), [...b.listCenter(0, 0, 0, false), 0.5]);
  const mid = b.movingAt(p, false, t0 + 60);
  assert.ok(mid[2] > 0.5 && mid[2] < 1);
  assert.deepEqual(b.movingAt(p, false, t0 + 10000), [...b.center(5, 5), 1]);
  // 판 → 목록 (목록 안의 기물에 판의 칸 from)
  const q = { row: 1, col: 1, piece: 'white', from: { row: 5, col: 5 } };
  const c = new BoardView(fakeCanvas(), withList(), 'go-stones');
  c.resize(480);
  c.draw({ pieces: [], lists: [{ pieces: [q] }] });
  assert.equal(c.motions.length, 1);
  const [lq] = c.listPieces({ lists: [{ pieces: [q] }] });
  assert.deepEqual(c.movingAt(lq, false, c.motions[0].t0), [...c.center(5, 5), 1]);
  assert.deepEqual(c.movingAt(lq, false, c.motions[0].t0 + 10000), [...c.listCenter(0, 1, 1, false), 0.5]);
  // 없는 목록에서 오는 기물은 움직이지 않습니다
  const d = new BoardView(fakeCanvas(), withList(), 'go-stones');
  d.resize(480);
  d.draw({ pieces: [{ row: 5, col: 5, piece: 'black', from: { list: 3, row: 0, col: 0 } }] });
  assert.equal(d.motions.length, 0);
});

test('영역이 없으면 칸 자리와 크기가 예전과 같습니다', () => {
  const canvas = fakeCanvas();
  const b = new BoardView(canvas, { places: 'cells', rows: 3, cols: 3 }, 'xo');
  b.resize(300);
  // 칸 98px에 양옆 여백 2px
  assert.equal(b.S, 98);
  assert.equal(canvas.width, 3 * 98 + 4);
  assert.deepEqual(b.center(0, 0, false), [2 + 49, 2 + 49]);
  assert.deepEqual(b.center(0, 0, true), [2 + 98 * 2 + 49, 2 + 98 * 2 + 49]);
  assert.deepEqual(b.cellAt(at(3, 3), false), { row: 0, col: 0 });
  assert.deepEqual(b.cellAt(at(3, 3), true), { row: 2, col: 2 });
  assert.equal(b.cellAt(at(1, 1), false), null);
  // 교차점 모드와 좌표 글자도 예전 계산과 같습니다
  const go = new BoardView(fakeCanvas(), { places: 'points', rows: 9, cols: 9, labels: true }, 'go-stones');
  go.resize(400);
  const S = go.S;
  const lab = Math.round(Math.max(14, S * 0.35));
  const m = Math.round(S * 0.6);
  assert.equal(go.width, lab + m * 2 + 8 * S);
  assert.deepEqual(go.center(0, 0, false), [lab + m, m]);
});

test('영역은 판 옆에 틈을 두고 놓이고, 판과 영역의 칸만 누를 수 있습니다', () => {
  const canvas = fakeCanvas();
  const b = new BoardView(canvas, tall, 'go-stones');
  b.resize(480);
  const { S } = b;
  const P = b.place(false);
  // 판의 마지막 열과 영역의 첫 열 사이에는 칸 하나보다 넓은 간격이 있습니다
  assert.ok(P.cx[8] - P.cx[7] > S);
  assert.equal(P.cx[9] - P.cx[8], S);
  assert.ok(b.width <= 480 && b.height <= 480);
  // 영역 칸의 가운데를 누르면 그 칸, 영역 사이의 빈 줄(4번 줄)과 틈은 아무 칸도 아닙니다
  assert.deepEqual(b.cellAt(at(P.cx[9], P.cy[1]), false), { row: 1, col: 9 });
  assert.equal(b.cellAt(at(P.cx[9], P.cy[4]), false), null);
  assert.equal(b.cellAt(at((P.cx[7] + P.cx[8]) / 2, P.cy[1]), false), null);
  assert.deepEqual(b.cellAt(at(P.cx[7], P.cy[12]), false), { row: 12, col: 7 });
  // 뒤집으면 영역이 왼쪽으로 갑니다
  assert.ok(b.center(0, 8, true)[0] < b.center(0, 0, true)[0]);
  assert.deepEqual(b.cellAt(at(...b.center(1, 9, true)), true), { row: 1, col: 9 });
  // 판에도 영역에도 들지 않는 칸의 기물은 그리지 않습니다
  const stoneAt = (x, y) => canvas.calls.some(([k, ax, ay]) => k === 'arc' && Math.abs(ax - x) < 1 && Math.abs(ay - y) < 1);
  b.draw({ pieces: [{ row: 4, col: 9, piece: 'black' }] });
  assert.ok(!stoneAt(P.cx[9], P.cy[4]));
  b.draw({ pieces: [{ row: 5, col: 9, piece: 'black' }] });
  assert.ok(stoneAt(P.cx[9], P.cy[5]));
});

test('aliases: from 칸을 누르거나 올리면 to 칸으로 칩니다', () => {
  const canvas = fakeCanvas();
  const b = new BoardView(canvas, { places: 'cells', rows: 3, cols: 3 }, 'xo');
  b.resize(300);
  const clicked = [];
  const hovered = [];
  attachInput(b, canvas, { flip: () => false, canHover: () => true, click: (c) => clicked.push(c), hover: (c) => hovered.push(c) });
  b.draw({ pieces: [], aliases: [{ from: { row: 2, col: 2 }, to: { row: 0, col: 1 } }] });
  canvas.fire('click', at(...b.center(2, 2, false)));
  canvas.fire('click', at(...b.center(1, 1, false)));
  assert.deepEqual(clicked, [{ row: 0, col: 1 }, { row: 1, col: 1 }]);
  canvas.fire('mousemove', at(...b.center(2, 2, false)));
  assert.deepEqual(hovered, [{ row: 0, col: 1 }]);
});

test('buttonsOf: view.buttons가 없으면 예전처럼, 있으면 그 글자와 순서에 legal()로 흐리게', () => {
  assert.deepEqual(buttonsOf(['pass'], { pieces: [] }, []), [{ kind: 'pass', label: 'pass', disabled: false }]);
  const view = { pieces: [], buttons: [{ kind: 'rotate', label: '↻ 돌리기' }, { kind: 'pass' }, { kind: 'nope' }, { kind: 'rotate' }] };
  assert.deepEqual(buttonsOf(['pass', 'rotate'], view, [{ kind: 'rotate' }]), [
    { kind: 'rotate', label: '↻ 돌리기', disabled: false },
    { kind: 'pass', label: 'pass', disabled: true },
  ]);
  // legal()이 없는 게임은 늘 누를 수 있습니다
  assert.equal(buttonsOf(['pass'], { pieces: [], buttons: [{ kind: 'pass' }] }, null)[0].disabled, false);
  assert.deepEqual(buttonsOf(['pass'], { pieces: [], buttons: [] }, null), []);
});

test('움직임: 같은 움직임은 한 번만, animate: false면 움직이지 않습니다', () => {
  const b = new BoardView(fakeCanvas(), { places: 'cells', rows: 5, cols: 1 }, 'go-stones');
  b.resize(200);
  const fell = { pieces: [{ row: 4, col: 0, piece: 'black', from: { row: 0, col: 0 } }] };
  b.draw(fell);
  assert.equal(b.motions.length, 1);
  // 떨어지는 중에는 위에서 아래로 내려오는 길 위에 있습니다
  const [, y] = b.movingAt(fell.pieces[0], false, b.motions[0].t0 + 50);
  assert.ok(y < b.center(4, 0, false)[1] && y >= b.center(0, 0, false)[1]);
  b.motions = [];
  b.draw({ ...fell }); // 내용이 같은 새 화면 (언어를 바꾸거나 기물을 고른 뒤)
  assert.equal(b.motions.length, 0);
  b.draw({ pieces: [{ row: 3, col: 0, piece: 'white', from: { row: 0, col: 0 } }] }, { animate: false });
  assert.equal(b.motions.length, 0);
});

test('움직임: 기물마다 따로 봐서, 새 from이 붙은 기물만 움직입니다', () => {
  const b = new BoardView(fakeCanvas(), { places: 'cells', rows: 5, cols: 2 }, 'go-stones');
  b.resize(200);
  const stone = { row: 4, col: 0, piece: 'black', from: { row: 0, col: 0 } };
  b.draw({ pieces: [stone] });
  const t0 = b.motions[0].t0;
  // 같은 수 안에서 다른 기물에 새 from (다음 조각과 바꾸기 같은 것): 그 기물만 새로 움직이고, 떨어지던 돌은 이어서 떨어집니다
  const swapped = { row: 1, col: 1, piece: 'white', from: { row: 3, col: 1 } };
  b.draw({ pieces: [stone, swapped] });
  assert.equal(b.motions.length, 2);
  assert.ok(b.motions[0].keys.size === 1 && b.motions[0].t0 === t0);
  assert.equal(b.motions[1].keys.size, 1);
  const [, y] = b.movingAt(stone, false, t0 + 50);
  assert.ok(y < b.center(4, 0, false)[1]);
});

test('효과(effects): 같은 효과는 한 번만, animate: false면 보이지 않고, 모르는 종류와 그리지 않는 칸은 버립니다', () => {
  const b = new BoardView(fakeCanvas(), { places: 'cells', rows: 3, cols: 3 }, 'go-stones');
  b.resize(200);
  const broke = { row: 1, col: 1, piece: 'white' };
  b.draw({ pieces: [], effects: [broke] });
  assert.equal(b.effects.length, 1);
  assert.ok(b.busy());
  // 내용이 같은 새 화면 (돌리기 같은 행동 뒤): 다시 보여 주지 않고, 보이던 효과는 이어서 보입니다
  b.draw({ pieces: [], effects: [broke] });
  assert.equal(b.effects.length, 1);
  // 같은 칸 · 같은 기물이라도 id가 다르면 새 효과입니다
  b.draw({ pieces: [], effects: [{ ...broke, id: 7 }] });
  assert.equal(b.effects.length, 2);
  // 끝난 효과는 지웁니다
  b.draw({ pieces: [], effects: [{ ...broke, id: 7 }] });
  b.effects.forEach((x) => { x.until = 0; });
  b.draw({ pieces: [] });
  assert.equal(b.effects.length, 0);
  assert.ok(!b.busy());
  b.draw({ pieces: [], effects: [{ ...broke, id: 8 }] }, { animate: false });
  assert.equal(b.effects.length, 0);
  b.draw({ pieces: [], effects: [{ ...broke, id: 9, type: 'explode' }, { row: 5, col: 0, piece: 'black' }] });
  assert.equal(b.effects.length, 0);
});

test('효과(effects): 금이 가는 동안과 조각이 튀는 동안 그 칸에 기물을 그립니다', () => {
  const canvas = fakeCanvas();
  const b = new BoardView(canvas, { places: 'cells', rows: 3, cols: 3 }, 'go-stones');
  b.resize(200);
  b.draw({ pieces: [], effects: [{ row: 1, col: 1, piece: 'black' }] });
  const fx = b.effects[0];
  const arcs = () => canvas.calls.filter(([k]) => k === 'arc').length;
  for (const k of [0.1, 0.6]) {
    canvas.calls.length = 0;
    b.drawEffect(fx, false, fx.t0 + 480 * k);
    assert.ok(arcs() >= 1, `k=${k}`);
  }
  // 조각은 네 개라 부채꼴(clip)이 네 번
  canvas.calls.length = 0;
  b.drawEffect(fx, false, fx.t0 + 480 * 0.6);
  assert.equal(canvas.calls.filter(([k]) => k === 'clip').length, 4);
  // 끝난 뒤에는 그리지 않습니다
  canvas.calls.length = 0;
  b.drawEffect(fx, false, fx.t0 + 481); // 480이면 t0의 소수 부분 때문에 0.9999…가 되어 가끔 그려짐
  assert.equal(canvas.calls.length, 0);
});

test('효과(effects): flash는 빛난 뒤 작아지며 사라지고, 같은 칸 · 기물이라도 shatter와 다른 효과입니다', () => {
  const canvas = fakeCanvas();
  const b = new BoardView(canvas, { places: 'cells', rows: 3, cols: 3 }, 'go-stones');
  b.resize(200);
  const e = { row: 1, col: 1, piece: 'white' };
  b.draw({ pieces: [], effects: [{ ...e, type: 'flash' }, e] });
  assert.equal(b.effects.length, 2);
  const fx = b.effects.find((x) => x.e.type === 'flash');
  // 빛나는 동안은 제 크기, 그 뒤로는 작아집니다 (조각으로 가르지 않으니 clip이 없음)
  for (const [k, small] of [[0.2, false], [0.7, true]]) {
    canvas.calls.length = 0;
    b.drawEffect(fx, false, fx.t0 + 480 * k);
    const scale = canvas.calls.find(([c]) => c === 'scale');
    assert.equal(scale[1] < 1, small, `k=${k}`);
    assert.equal(canvas.calls.filter(([c]) => c === 'clip').length, 0);
    assert.ok(canvas.calls.some(([c]) => c === 'fill'));
  }
  canvas.calls.length = 0;
  b.drawEffect(fx, false, fx.t0 + 481);
  assert.equal(canvas.calls.length, 0);
});

test('내 차례(myTurn): 판 바탕 둘레 안쪽에 테두리 하나, 판 밖 영역은 빼고', () => {
  const frames = (canvas) => canvas.calls.filter(([k]) => k === 'strokeRect');
  const canvas = fakeCanvas();
  const b = new BoardView(canvas, { places: 'cells', rows: 3, cols: 3 }, 'xo');
  b.resize(200);
  b.draw({ pieces: [] });
  assert.equal(frames(canvas).length, 0);
  b.draw({ pieces: [] }, { myTurn: true });
  assert.equal(frames(canvas).length, 1);
  const [[, x, y, w, h]] = frames(canvas);
  // 캔버스 가장자리에 붙어서, 줄이 잘리지 않게 줄 굵기 절반만큼 안쪽
  assert.ok(x > 0 && y > 0 && x + w < b.width && y + h < b.height);
  assert.ok(x < 6 && b.width - (x + w) < 6 && b.height - (y + h) < 6);
  // 영역이 있으면 판 바탕까지만 두르고 영역은 감싸지 않습니다
  const c2 = fakeCanvas();
  const t = new BoardView(c2, tall, 'go-stones');
  t.resize(480);
  t.draw({ pieces: [] }, { myTurn: true });
  const [[, tx, , tw]] = frames(c2);
  const P = t.place(false);
  assert.ok(tx + tw > P.cx[7] && tx + tw < P.cx[8] - t.S / 2);
});

test('플레이어 기물(paintPlayerDot): 아는 기물이면 그 기물 그림, 아니면 플레이어 색 점', () => {
  assert.ok(knowsPiece('go-stones', 'white') && knowsPiece('xo', 'x') && knowsPiece('chess', 'bQ'));
  assert.ok(knowsPiece(['red', { name: 'K', text: '王' }], 'K'));
  assert.ok(!knowsPiece('go-stones', 'red') && !knowsPiece('chess', 'bX') && !knowsPiece(['red'], 'blue') && !knowsPiece('xo', undefined));

  const made = [];
  const saved = globalThis.document;
  globalThis.document = { createElement: () => { const c = fakeCanvas(); made.push(c); return c; } };
  const dot = () => {
    const classes = new Set();
    return {
      dataset: {},
      style: {},
      children: [],
      classList: { toggle: (k, on) => (on ? classes.add(k) : classes.delete(k)), contains: (k) => classes.has(k) },
      replaceChildren(...xs) { this.children = xs; },
    };
  };
  try {
    const el = dot();
    paintPlayerDot(el, 'go-stones', ['black', 'white'], 1);
    assert.ok(el.classList.contains('piece'));
    assert.equal(el.style.background, 'none');
    assert.equal(el.children.length, 1);
    assert.ok(made[0].calls.some(([k]) => k === 'arc'), '돌을 그립니다');
    // 같은 기물이면 캔버스를 새로 만들지 않습니다
    paintPlayerDot(el, 'go-stones', ['black', 'white'], 1);
    assert.equal(made.length, 1);

    // playerPieces가 없거나 모르는 기물이면 플레이어 색 점
    for (const playerPieces of [undefined, ['black', 'red']]) {
      const plain = dot();
      paintPlayerDot(plain, 'go-stones', playerPieces, 1);
      assert.ok(!plain.classList.contains('piece'));
      assert.equal(plain.style.background, PLAYER_COLORS[1]);
      assert.equal(plain.children.length, 0);
    }
    // 그림이던 점도 색 점으로 돌아옵니다
    paintPlayerDot(el, 'go-stones', null, 1);
    assert.equal(el.style.background, PLAYER_COLORS[1]);
    assert.equal(el.children.length, 0);
  } finally {
    globalThis.document = saved;
  }
});
