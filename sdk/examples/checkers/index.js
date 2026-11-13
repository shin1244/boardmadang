// Checkers. An example of moving again: after a capture, if the same piece can capture more, move() returns 'again'.
// Try it: npx boardmadang dev sdk/examples/checkers
//
// Pieces stay on the dark squares. A man (m) moves one square diagonally forward, a king (k) one square along any diagonal.
// You capture by jumping over an opponent's piece, and if you can capture you must.
// A piece is two characters: its kind (m man, k king) + its owner (0 black, at the bottom · 1 white, at the top)

const SIZE = 8;
const DIAGONALS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const cellsOf = (grid) => grid.flatMap((line, row) => line.map((piece, col) => ({ row, col, piece })));
const ownerOf = (piece) => Number(piece[1]);
/** The directions this piece can go. A man only goes forward (for the bottom player, toward smaller row numbers) */
const dirsOf = (piece) => DIAGONALS.filter(([dr]) => piece[0] === 'k' || dr === (ownerOf(piece) === 0 ? -1 : 1));

/** The one-square moves of the piece at (row, col) */
const stepsFrom = (grid, row, col) => dirsOf(grid[row][col])
  .map(([dr, dc]) => ({ from: { row, col }, to: { row: row + dr, col: col + dc } }))
  .filter((m) => grid[m.to.row]?.[m.to.col] === null);

/** The captures of the piece at (row, col): it jumps over the square `over` */
const jumpsFrom = (grid, row, col) => dirsOf(grid[row][col])
  .map(([dr, dc]) => ({ from: { row, col }, to: { row: row + 2 * dr, col: col + 2 * dc }, over: { row: row + dr, col: col + dc } }))
  .filter((m) => grid[m.to.row]?.[m.to.col] === null && grid[m.over.row][m.over.col] && ownerOf(grid[m.over.row][m.over.col]) !== ownerOf(grid[row][col]));

export default {
  id: 'checkers',
  board: { places: 'cells', rows: SIZE, cols: SIZE, look: 'checker', flipForPlayer: 1 },
  pieces: 'go-stones',
  playerPieces: ['black', 'white'],
  maxActions: 200,
  noMoves: 'lose', // with no pieces left, or none that can move, you lose

  setup: () => ({
    // On the dark squares (row + col is odd): white men on the top three rows, black men on the bottom three
    grid: Array.from({ length: SIZE }, (_, row) => Array.from({ length: SIZE }, (_, col) => (
      (row + col) % 2 === 0 ? null : row < 3 ? 'm1' : row > 4 ? 'm0' : null))),
    jumping: null, // the square of a piece that is in the middle of several jumps
  }),

  moves(state, player) {
    const mine = state.jumping ? [state.jumping] : cellsOf(state.grid).filter((c) => c.piece && ownerOf(c.piece) === player);
    const jumps = mine.flatMap((c) => jumpsFrom(state.grid, c.row, c.col));
    return jumps.length ? jumps : mine.flatMap((c) => stepsFrom(state.grid, c.row, c.col)); // if you can capture, you must
  },

  move(state, m, player) {
    const { grid } = state;
    const piece = grid[m.from.row][m.from.col];
    const crowned = piece[0] === 'm' && m.to.row === (player === 0 ? 0 : SIZE - 1); // a man that reaches the far row becomes a king
    grid[m.from.row][m.from.col] = null;
    grid[m.to.row][m.to.col] = crowned ? `k${player}` : piece;
    if (m.over) grid[m.over.row][m.over.col] = null;
    // After a capture, if the same piece can capture again, the turn goes on (but becoming a king ends it)
    state.jumping = m.over && !crowned && jumpsFrom(grid, m.to.row, m.to.col).length ? m.to : null;
    return state.jumping ? 'again' : undefined;
  },

  view(state) {
    const stones = cellsOf(state.grid).filter((c) => c.piece);
    return {
      pieces: stones.map((c) => ({ row: c.row, col: c.col, piece: ['black', 'white'][ownerOf(c.piece)] })),
      text: stones.filter((c) => c.piece[0] === 'k').map((c) => ({ row: c.row, col: c.col, text: 'K' })),
    };
  },
};
