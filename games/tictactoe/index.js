// 틱택토. 보드마당 게임 API의 가장 작은 예제입니다.
// 판은 칸 9개짜리 배열입니다. board[row * 3 + col] = null(빈칸) | 0 | 1

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // 가로
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // 세로
  [0, 4, 8], [2, 4, 6],            // 대각선
];

const PIECE = ['x', 'o'];

/** @typedef {{ board: (0 | 1 | null)[], turn: 0 | 1, last: number | null }} State */

/** 세 개가 이어진 줄. 없으면 null */
function winningLine(board) {
  return LINES.find(([a, b, c]) =>
    board[a] !== null && board[a] === board[b] && board[a] === board[c]) ?? null;
}

function setup() {
  return { board: Array(9).fill(null), turn: 0, last: null };
}

function result(state) {
  const line = winningLine(state.board);
  if (line) return { winner: state.board[line[0]], reason: '세 줄 완성' };
  if (state.board.every((c) => c !== null)) return { winner: null, reason: '판이 가득 참' };
  return null;
}

function play(state, player, action) {
  // 둘 수 없는 행동은 전부 무시합니다. 상대 화면에서도 똑같이 무시되므로 판이 어긋나지 않습니다.
  if (result(state)) return state;
  if (player !== state.turn) return state;
  if (action.kind !== 'click') return state;
  const { row, col } = action;
  if (!Number.isInteger(row) || !Number.isInteger(col)) return state;
  if (row < 0 || row > 2 || col < 0 || col > 2) return state;
  const i = row * 3 + col;
  if (state.board[i] !== null) return state;

  // 받은 state는 고치지 않고 새로 만듭니다.
  const board = state.board.slice();
  board[i] = player;
  return { board, turn: 1 - player, last: i };
}

function legal(state, player) {
  if (result(state) || player !== state.turn) return [];
  const actions = [];
  state.board.forEach((c, i) => {
    if (c === null) actions.push({ kind: 'click', row: Math.floor(i / 3), col: i % 3 });
  });
  return actions;
}

function view(state, player) {
  const pieces = [];
  state.board.forEach((c, i) => {
    if (c !== null) pieces.push({ row: Math.floor(i / 3), col: i % 3, piece: PIECE[c] });
  });

  const marks = [];
  if (state.last !== null) {
    marks.push({ row: Math.floor(state.last / 3), col: state.last % 3, type: 'last-move' });
  }

  const tint = [];
  const line = winningLine(state.board);
  if (line) {
    for (const i of line) tint.push({ row: Math.floor(i / 3), col: i % 3, color: state.board[i] });
  }

  const r = result(state);
  let message;
  if (!r) message = state.turn === player ? '당신 차례' : '상대 차례';
  else if (r.winner === null) message = '무승부';
  else message = r.winner === player ? '이겼습니다!' : '졌습니다';

  return { pieces, marks, tint, message };
}

/** @type {import('../../sdk/game').Game<State>} */
export default {
  id: 'tictactoe',
  name: '틱택토',
  board: { places: 'cells', rows: 3, cols: 3, look: 'plain' },
  pieces: 'xo',
  maxActions: 9,
  setup,
  play,
  result,
  view,
  legal,
};
