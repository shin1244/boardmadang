// Reversi (Othello). An example of a special action: the Pass button can be pressed only when you have nowhere to play.
// Try it: npx boardmadang dev sdk/examples/reversi

const SIZE = 8;
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const cellsOf = (grid) => grid.flatMap((line, row) => line.map((owner, col) => ({ row, col, owner })));

/** The stones that flip if `player` plays at (row, col): in each direction, a run of the opponent's stones closed by one of yours */
function flips(grid, row, col, player) {
  if (grid[row][col] !== null) return [];
  return DIRS.flatMap(([dr, dc]) => {
    const line = [];
    for (let r = row + dr, c = col + dc; grid[r]?.[c] !== undefined && grid[r][c] !== null; r += dr, c += dc) {
      if (grid[r][c] === player) return line;
      line.push({ row: r, col: c });
    }
    return [];
  });
}
/** The squares where `player` can play */
const places = (grid, player) => cellsOf(grid).filter((c) => flips(grid, c.row, c.col, player).length);
const count = (grid, player) => cellsOf(grid).filter((c) => c.owner === player).length;

export default {
  id: 'reversi',
  board: { places: 'cells', rows: SIZE, cols: SIZE },
  pieces: 'go-stones',
  playerPieces: ['black', 'white'],
  specialActions: { pass: { en: 'Pass', ko: '넘기기' } },
  maxActions: 130,

  setup() {
    const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    [grid[3][4], grid[4][3], grid[3][3], grid[4][4]] = [0, 0, 1, 1];
    return { grid };
  },

  // You may play only where something flips. If there is no such square, you pass
  moves(state, player) {
    const cells = places(state.grid, player);
    return cells.length ? cells : [{ special: 'pass' }];
  },

  move(state, m, player) {
    if (m.special) return;
    for (const c of [m, ...flips(state.grid, m.row, m.col, player)]) state.grid[c.row][c.col] = player;
  },

  // When neither player can play, the one with more stones wins
  winner(state) {
    if (places(state.grid, 0).length || places(state.grid, 1).length) return undefined;
    const [black, white] = [count(state.grid, 0), count(state.grid, 1)];
    return black === white ? 'draw' : black > white ? 0 : 1;
  },

  view: (state) => ({
    pieces: cellsOf(state.grid).filter((c) => c.owner !== null).map((c) => ({ row: c.row, col: c.col, piece: ['black', 'white'][c.owner] })),
  }),
};
