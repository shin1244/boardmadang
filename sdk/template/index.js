// Your new game. It starts as tic-tac-toe: change the rules to make it yours.
// Guide: https://github.com/shin1244/boardmadang/blob/main/sdk/README.md
//   npx boardmadang dev     play both sides, and save a thumbnail for the game list
//   npx boardmadang check   run the same checks as the upload
//   npx boardmadang pack    make the zip to upload

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];

const PIECE = ['x', 'o'];

// In-game text, one table per language. Translate it for every language you mark "full" in listing.json.
// Boardmadang passes one of those languages as `lang`.
const TEXT = {
  en: { line: 'Three in a row', full: 'Board is full', myTurn: 'Your turn', theirTurn: "Opponent's turn", draw: 'Draw', won: 'You won!', lost: 'You lost' },
  ko: { line: '세 줄 완성', full: '판이 가득 참', myTurn: '당신 차례', theirTurn: '상대 차례', draw: '무승부', won: '이겼습니다!', lost: '졌습니다' },
};

/** The board is 9 squares in a row: board[row * 3 + col] = null (empty) | 0 | 1 */
/** @typedef {{ board: (0 | 1 | null)[], turn: 0 | 1, last: number | null }} State */

/** The three squares in a line, or null */
function winningLine(board) {
  return LINES.find(([a, b, c]) =>
    board[a] !== null && board[a] === board[b] && board[a] === board[c]) ?? null;
}

/** The starting position. Use `rng` (not Math.random) if you need randomness. */
function setup(rng) {
  return { board: Array(9).fill(null), turn: 0, last: null };
}

/** Over? { winner: 0 | 1 } or { winner: null } for a draw. Still playing: null */
function result(state, lang = 'en') {
  const line = winningLine(state.board);
  if (line) return { winner: state.board[line[0]], reason: TEXT[lang].line };
  if (state.board.every((c) => c !== null)) return { winner: null, reason: TEXT[lang].full };
  return null;
}

/** A player clicked. Return the new state, or the same state to ignore the move. */
function play(state, player, action) {
  // Ignore every move that isn't allowed. The other browser ignores it too, so the boards stay the same.
  if (result(state)) return state;
  if (player !== state.turn) return state;
  if (action.kind !== 'click') return state;
  const { row, col } = action;
  if (!Number.isInteger(row) || !Number.isInteger(col)) return state;
  if (row < 0 || row > 2 || col < 0 || col > 2) return state;
  const i = row * 3 + col;
  if (state.board[i] !== null) return state;

  // Don't change the state you received. Make a new one.
  const board = state.board.slice();
  board[i] = player;
  return { board, turn: 1 - player, last: i };
}

/** Whose turn it is. null once the game is over (the clock stops). Needed for a timer. */
function turn(state) {
  return result(state) ? null : state.turn;
}

/** The moves allowed right now. Used for hover hints and for the AI. */
function legal(state, player) {
  if (result(state) || player !== state.turn) return [];
  const actions = [];
  state.board.forEach((c, i) => {
    if (c === null) actions.push({ kind: 'click', row: Math.floor(i / 3), col: i % 3 });
  });
  return actions;
}

/** What to draw for this player. Boardmadang does the drawing. */
function view(state, player, lang = 'en') {
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
  const text = TEXT[lang];
  let message;
  if (!r) message = state.turn === player ? text.myTurn : text.theirTurn;
  else if (r.winner === null) message = text.draw;
  else message = r.winner === player ? text.won : text.lost;

  return { pieces, marks, tint, message };
}

/** @type {import('boardmadang').Game<State>} */
export default {
  id: '__ID__',
  board: { places: 'cells', rows: 3, cols: 3, look: 'plain' },
  pieces: 'xo',
  maxActions: 9,
  setup,
  play,
  result,
  view,
  legal,
  turn,
};
