// 체커를 "둘 수 있는 수" 형태로 쓴 것 (시제품, sdk/experimental/simple.js).
// 이어서 두기의 예입니다: 잡고 나서 같은 기물로 더 잡을 수 있으면 move()가 'again'을 돌려줍니다.
//
// 어두운 칸에서만 둡니다. 졸(m)은 앞으로 대각선 한 칸, 왕(k)은 네 대각선으로 한 칸. 상대를 뛰어넘어 잡고, 잡을 수 있으면 반드시 잡습니다.
// 기물은 글자 두 개입니다: 종류(m 졸, k 왕) + 주인(0 검은 돌, 아래쪽 · 1 흰 돌, 위쪽)

const SIZE = 8;
const DIAGONALS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const cellsOf = (grid) => grid.flatMap((line, row) => line.map((piece, col) => ({ row, col, piece })));
const ownerOf = (piece) => Number(piece[1]);
/** 이 기물이 갈 수 있는 방향. 졸은 앞(아래쪽 플레이어는 줄 번호가 줄어드는 쪽)으로만 */
const dirsOf = (piece) => DIAGONALS.filter(([dr]) => piece[0] === 'k' || dr === (ownerOf(piece) === 0 ? -1 : 1));

/** (row, col)의 기물이 한 칸 가는 수들 */
const stepsFrom = (grid, row, col) => dirsOf(grid[row][col])
  .map(([dr, dc]) => ({ from: { row, col }, to: { row: row + dr, col: col + dc } }))
  .filter((m) => grid[m.to.row]?.[m.to.col] === null);

/** (row, col)의 기물이 상대를 뛰어넘어 잡는 수들. over가 잡히는 칸입니다 */
const jumpsFrom = (grid, row, col) => dirsOf(grid[row][col])
  .map(([dr, dc]) => ({ from: { row, col }, to: { row: row + 2 * dr, col: col + 2 * dc }, over: { row: row + dr, col: col + dc } }))
  .filter((m) => grid[m.to.row]?.[m.to.col] === null && grid[m.over.row][m.over.col] && ownerOf(grid[m.over.row][m.over.col]) !== ownerOf(grid[row][col]));

export default {
  id: 'checkers-simple',
  board: { places: 'cells', rows: SIZE, cols: SIZE, look: 'checker', flipForPlayer: 1 },
  pieces: 'go-stones',
  playerPieces: ['black', 'white'],
  maxActions: 200,
  noMoves: 'lose', // 기물이 없거나 움직일 수 없으면 집니다

  setup: () => ({
    // 어두운 칸(줄 + 칸이 홀수)의 위 세 줄에 흰 졸, 아래 세 줄에 검은 졸
    grid: Array.from({ length: SIZE }, (_, row) => Array.from({ length: SIZE }, (_, col) => (
      (row + col) % 2 === 0 ? null : row < 3 ? 'm1' : row > 4 ? 'm0' : null))),
    jumping: null, // 연속으로 뛰는 중인 기물의 칸
  }),

  moves(state, player) {
    const mine = state.jumping ? [state.jumping] : cellsOf(state.grid).filter((c) => c.piece && ownerOf(c.piece) === player);
    const jumps = mine.flatMap((c) => jumpsFrom(state.grid, c.row, c.col));
    return jumps.length ? jumps : mine.flatMap((c) => stepsFrom(state.grid, c.row, c.col)); // 잡을 수 있으면 반드시 잡습니다
  },

  move(state, m, player) {
    const { grid } = state;
    const piece = grid[m.from.row][m.from.col];
    const crowned = piece[0] === 'm' && m.to.row === (player === 0 ? 0 : SIZE - 1); // 끝줄에 닿은 졸은 왕이 됩니다
    grid[m.from.row][m.from.col] = null;
    grid[m.to.row][m.to.col] = crowned ? `k${player}` : piece;
    if (m.over) grid[m.over.row][m.over.col] = null;
    // 잡고 나서 같은 기물로 더 잡을 수 있으면 이어서 둡니다 (왕이 된 수는 거기서 끝납니다)
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
