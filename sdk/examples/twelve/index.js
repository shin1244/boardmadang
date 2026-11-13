// Twelve Janggi: a 3×4 board, four pieces each. An example of picking a piece and moving it, pieces in hand, and promotion.
// Try it: npx boardmadang dev sdk/examples/twelve
//
// A captured piece joins your side and goes to your hand; instead of moving, you may drop it on an empty square.
// The grid has 6 rows: row 0 is the top player's (1) hand, rows 1-4 are the board, row 5 is the bottom player's (0) hand.
// A piece is two characters: its kind (k king, g general, e elephant, s soldier, l lord) + its owner (0, 1). For example 'k0'

const KINDS = { k: '王', g: '將', e: '相', s: '子', l: '侯' };
/** The directions each kind can move (drawn as triangles on the tile, and used by the rules). 'n' is forward */
const ARROWS = {
  k: ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'],
  g: ['n', 'e', 's', 'w'],
  e: ['ne', 'se', 'sw', 'nw'],
  s: ['n'],
  l: ['n', 'ne', 'e', 's', 'w', 'nw'],
};
/** Direction → the change in [row, col], for the bottom player (0): forward ('n') is toward smaller row numbers */
const STEP = { n: [-1, 0], ne: [-1, 1], e: [0, 1], se: [1, 1], s: [1, 0], sw: [1, -1], w: [0, -1], nw: [-1, -1] };

const HAND_ROW = [5, 0]; // each player's hand row
const CAMP_ROW = [4, 1]; // each player's camp (their back row)
const HAND_KINDS = ['e', 'g', 's']; // the order in the hand (from the left, as that player sees it)
/** The hand square where that kind sits */
const handCell = (player, kind) => ({ row: HAND_ROW[player], col: player === 0 ? HAND_KINDS.indexOf(kind) : 2 - HAND_KINDS.indexOf(kind) });

const onBoard = (row, col) => row >= 1 && row <= 4 && col >= 0 && col <= 2;
const ownerOf = (piece) => Number(piece[1]);

export default {
  id: 'twelve',
  board: {
    places: 'cells', rows: 6, cols: 3, flipForPlayer: 1,
    areas: [{ side: 'top', row: 0, col: 0, rows: 1, cols: 3 }, { side: 'bottom', row: 5, col: 0, rows: 1, cols: 3 }],
  },
  pieces: Object.keys(KINDS).flatMap((kind) => [0, 1].map((player) => ({ name: kind + player, text: KINDS[kind], player, arrows: ARROWS[kind] }))),
  playerPieces: ['k0', 'k1'],
  maxActions: 300,
  noMoves: 'lose', // with no move to make, you lose
  repeat: 3, // the same position three times is a draw

  setup: () => ({
    // grid[row][col] = piece | null. The board uses rows 1-4 only
    grid: [
      [null, null, null],
      ['g1', 'k1', 'e1'],
      [null, 's1', null],
      [null, 's0', null],
      ['e0', 'k0', 'g0'],
      [null, null, null],
    ],
    hands: [{ e: 0, g: 0, s: 0 }, { e: 0, g: 0, s: 0 }],
    entered: null, // the player whose king has just entered the opponent's camp: they win unless it is captured next turn
    won: null,
  }),

  moves(state, player) {
    const list = [];
    const forward = player === 0 ? 1 : -1; // the top player's directions are reversed
    state.grid.forEach((line, row) => line.forEach((piece, col) => {
      if (!onBoard(row, col)) return;
      // My pieces: one square in each direction, but not onto my own piece
      if (piece && ownerOf(piece) === player) {
        for (const dir of ARROWS[piece[0]]) {
          const to = { row: row + STEP[dir][0] * forward, col: col + STEP[dir][1] * forward };
          const there = onBoard(to.row, to.col) ? state.grid[to.row][to.col] : undefined;
          if (there === null || (there && ownerOf(there) !== player)) list.push({ from: { row, col }, to });
        }
      }
      // Pieces in hand: drop on any empty square outside the opponent's camp
      if (!piece && row !== CAMP_ROW[1 - player]) {
        for (const kind of HAND_KINDS) if (state.hands[player][kind] > 0) list.push({ from: handCell(player, kind), to: { row, col }, drop: kind });
      }
    }));
    return list;
  },

  move(state, m, player) {
    const { grid, hands } = state;
    const waiting = state.entered; // the opponent, if their king entered my camp on their last move
    state.entered = null;
    if (m.drop) {
      hands[player][m.drop] -= 1;
      grid[m.to.row][m.to.col] = m.drop + player;
    } else {
      const piece = grid[m.from.row][m.from.col];
      const taken = grid[m.to.row][m.to.col];
      if (taken?.[0] === 'k') state.won = player; // capturing the king wins
      else if (taken) hands[player][taken[0] === 'l' ? 's' : taken[0]] += 1; // a captured lord comes back as a soldier
      grid[m.from.row][m.from.col] = null;
      const inCamp = m.to.row === CAMP_ROW[1 - player];
      grid[m.to.row][m.to.col] = piece[0] === 's' && inCamp ? `l${player}` : piece; // a soldier that reaches the opponent's camp becomes a lord
      if (piece[0] === 'k' && inCamp) state.entered = player;
    }
    // The opponent's king entered my camp and this move did not capture it: the opponent wins
    if (waiting !== null && state.won === null) state.won = waiting;
  },

  winner: (state) => state.won,

  view(state) {
    const pieces = [];
    const text = [];
    state.grid.forEach((line, row) => line.forEach((piece, col) => {
      if (piece) pieces.push({ row, col, piece });
    }));
    for (const player of [0, 1]) {
      for (const kind of HAND_KINDS) {
        const n = state.hands[player][kind];
        if (n > 0) pieces.push({ ...handCell(player, kind), piece: kind + player });
        if (n > 1) text.push({ ...handCell(player, kind), text: String(n) });
      }
    }
    // Camps: each back row in its player's color
    const tint = [0, 1].flatMap((player) => [0, 1, 2].map((col) => ({ row: CAMP_ROW[player], col, color: player })));
    return { pieces, text, tint };
  },
};
