// 리버시(오델로)를 "둘 수 있는 수" 형태로 쓴 것 (시제품, sdk/experimental/simple.js).
// 특수 행동의 예입니다: 둘 곳이 없을 때만 "넘기기" 버튼을 누를 수 있습니다.

const SIZE = 8;
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const cellsOf = (grid) => grid.flatMap((line, row) => line.map((owner, col) => ({ row, col, owner })));

/** (row, col)에 player가 두면 뒤집히는 돌들. 방향마다 상대 돌이 이어지다 내 돌로 막혀야 뒤집힙니다 */
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
/** player가 돌을 놓을 수 있는 칸들 */
const places = (grid, player) => cellsOf(grid).filter((c) => flips(grid, c.row, c.col, player).length);
const count = (grid, player) => cellsOf(grid).filter((c) => c.owner === player).length;

export default {
  id: 'reversi-simple',
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

  // 뒤집을 수 있는 칸에만 둡니다. 그런 칸이 없으면 넘깁니다
  moves(state, player) {
    const cells = places(state.grid, player);
    return cells.length ? cells : [{ special: 'pass' }];
  },

  move(state, m, player) {
    if (m.special) return;
    for (const c of [m, ...flips(state.grid, m.row, m.col, player)]) state.grid[c.row][c.col] = player;
  },

  // 둘 다 둘 곳이 없으면 돌이 많은 쪽이 이깁니다
  winner(state) {
    if (places(state.grid, 0).length || places(state.grid, 1).length) return undefined;
    const [black, white] = [count(state.grid, 0), count(state.grid, 1)];
    return black === white ? 'draw' : black > white ? 0 : 1;
  },

  view: (state) => ({
    pieces: cellsOf(state.grid).filter((c) => c.owner !== null).map((c) => ({ row: c.row, col: c.col, piece: ['black', 'white'][c.owner] })),
  }),
};
