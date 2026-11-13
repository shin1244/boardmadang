// 틱택토를 "둘 수 있는 수" 형태로 쓴 것 (시제품, sdk/experimental/simple.js). 지금 형태의 틱택토는 games/tictactoe/index.js입니다.

/** 판의 칸을 하나씩: { row, col, owner } */
const cellsOf = (grid) => grid.flatMap((line, row) => line.map((owner, col) => ({ row, col, owner })));

// 세 칸이 이어지는 줄 여덟 개: 가로 셋, 세로 셋, 대각선 둘
const LINES = [0, 1, 2].flatMap((i) => [[[i, 0], [i, 1], [i, 2]], [[0, i], [1, i], [2, i]]])
  .concat([[[0, 0], [1, 1], [2, 2]], [[0, 2], [1, 1], [2, 0]]]);

/** 한 사람이 다 채운 줄. 없으면 undefined */
const fullLine = (grid) => LINES.find((line) => line.every(([r, c]) => grid[r][c] !== null && grid[r][c] === grid[line[0][0]][line[0][1]]));

export default {
  id: 'tictactoe-simple',
  board: { places: 'cells', rows: 3, cols: 3 },
  pieces: 'xo',
  maxActions: 9,

  setup: () => ({ grid: [[null, null, null], [null, null, null], [null, null, null]] }),

  // 빈칸이면 어디든 둘 수 있습니다
  moves: (state) => cellsOf(state.grid).filter((c) => c.owner === null),

  move(state, m, player) {
    state.grid[m.row][m.col] = player;
  },

  winner(state) {
    const line = fullLine(state.grid);
    return line && state.grid[line[0][0]][line[0][1]];
  },

  view(state) {
    const line = fullLine(state.grid) ?? [];
    return {
      pieces: cellsOf(state.grid).filter((c) => c.owner !== null).map((c) => ({ row: c.row, col: c.col, piece: 'xo'[c.owner] })),
      tint: line.map(([row, col]) => ({ row, col, color: state.grid[row][col] })),
    };
  },
};
