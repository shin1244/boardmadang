// 렌더러(sdk/playground/board.js)에서 화면 없이 셀 수 있는 부분: 판 밖 영역의 배치, 클릭 옮기기(aliases), 버튼, 움직임, 효과
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardView, attachInput, buttonsOf, fieldOf } from '../playground/board.js';

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
  b.drawEffect(fx, false, fx.t0 + 480);
  assert.equal(canvas.calls.length, 0);
});
