// Your new game. It starts as tic-tac-toe: change the rules to make it yours.
// Guide: https://github.com/shin1244/boardmadang/blob/main/sdk/README.md
//   npx boardmadang dev     play both sides, and save a thumbnail for the game list
//   npx boardmadang check   run the same checks as the upload
//   npx boardmadang pack    make the zip to upload
//
// You write the rules once: which moves are allowed (moves) and what a move does (move).
// Boardmadang takes care of turns, ignoring moves that aren't allowed, hover hints, and the "Your turn" text.

/** The state is a 3×3 grid: grid[row][col] = null (empty) | 0 | 1 (the player who played there) */
/** @typedef {{ grid: (0 | 1 | null)[][] }} State */

/** Every square of the grid, one by one: { row, col, owner } */
const squares = (grid) => grid.flatMap((line, row) => line.map((owner, col) => ({ row, col, owner })));

// The eight lines of three squares: three rows, three columns, two diagonals
const LINES = [0, 1, 2].flatMap((i) => [[[i, 0], [i, 1], [i, 2]], [[0, i], [1, i], [2, i]]])
  .concat([[[0, 0], [1, 1], [2, 2]], [[0, 2], [1, 1], [2, 0]]]);

/** A line one player has filled, or undefined */
const fullLine = (grid) => LINES.find((line) => line.every(([row, col]) => grid[row][col] !== null && grid[row][col] === grid[line[0][0]][line[0][1]]));

/** @type {import('boardmadang').MovesGame<State>} */
export default {
  id: '__ID__',
  board: { places: 'cells', rows: 3, cols: 3, look: 'plain' },
  pieces: 'xo',
  maxActions: 9,

  /** The starting position. Use `rng` (not Math.random) if you need randomness. */
  setup: () => ({ grid: [[null, null, null], [null, null, null], [null, null, null]] }),

  /** The moves `player` may make right now. Here: any empty square. */
  moves: (state) => squares(state.grid).filter((square) => square.owner === null),

  /** Make the move. `m` is one of the moves from moves(), and you may change `state` directly. */
  move(state, m, player) {
    state.grid[m.row][m.col] = player;
  },

  /** Who won? 0 or 1, 'draw', or nothing while the game goes on. When no moves are left, it is a draw. */
  winner(state) {
    const line = fullLine(state.grid);
    return line && { winner: state.grid[line[0][0]][line[0][1]], reason: { en: 'Three in a row', ko: '세 줄 완성' } };
  },

  /** What to draw for this player. Boardmadang does the drawing and adds the last-move mark. */
  view(state) {
    const line = fullLine(state.grid) ?? [];
    return {
      pieces: squares(state.grid).filter((square) => square.owner !== null).map(({ row, col, owner }) => ({ row, col, piece: 'xo'[owner] })),
      tint: line.map(([row, col]) => ({ row, col, color: state.grid[row][col] })), // color the winning line
    };
  },
};
