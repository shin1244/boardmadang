# boardmadang

Make 1-vs-1 board games for [boardmadang.com](https://boardmadang.com).
You write only the **rules**. Boardmadang draws the board, runs online matches, and later trains an AI opponent.

[한국어](https://github.com/shin1244/boardmadang/blob/main/sdk/README.ko.md)

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npx boardmadang new my-game
cd my-game
npx boardmadang dev
```

Open the address it prints. You'll see both players' boards side by side, so you can play both sides yourself.
The new game is tic-tac-toe. Change the rules in `index.js` and refresh the page.

## Commands

| Command | What it does |
|---|---|
| `npx boardmadang new <folder>` | Makes a new game from a tic-tac-toe starter. The folder name becomes the game id. |
| `npx boardmadang dev` | Opens the playground. Play both sides and take a [thumbnail](#thumbnail). |
| `npx boardmadang check` | Runs the same checks the site runs when you upload. |
| `npx boardmadang pack` | If the checks pass, makes `<id>.zip` for uploading (`--out game.zip` to put it somewhere else). |

Upload the zip on the **Register a game** page of boardmadang.com (<https://boardmadang.com/web/register.html>).
You need to log in. The page runs the same checks in your browser. Then you play both sides and win one game (the clear check), fill in the listing, and register.
The winning game is kept as your clear replay, and if you change the code and upload it again, you clear it again. You can take the thumbnail on this page too.

## A game folder

```
my-game/
├─ index.js        your game (required)
├─ *.js, *.mjs     other files that index.js imports (optional)
├─ listing.json    name, description, rules text, difficulty, languages, timer (optional)
├─ thumbnail.json  the picture in the game list (optional, made in the playground)
└─ package.json    tells Node that index.js is a module (made by `new`)
```

## How a game works

A game is one object. Here is the idea, using tic-tac-toe:

```js
export default {
  id: 'my-game',
  board: { places: 'cells', rows: 3, cols: 3 }, // a 3×3 board, pieces go inside the squares
  pieces: 'xo',                                  // built-in X and O pieces
  maxActions: 9,                                 // the game must end within this many moves

  // The starting position.
  setup(rng) {
    return { board: Array(9).fill(null), turn: 0 };
  },

  // A player clicked a square. Return the new state.
  // If the move isn't allowed (not their turn, square taken), return the same state.
  play(state, player, action) {
    const i = action.row * 3 + action.col;
    if (player !== state.turn || state.board[i] !== null) return state;
    const board = state.board.slice(); // copy, don't change the old state
    board[i] = player;
    return { board, turn: 1 - player };
  },

  // Whose turn is it? 0 or 1, or null once the game is over (the game clock stops).
  turn(state) {
    return state.turn; // (return null here once the game is over)
  },

  // Is the game over? { winner: 0 or 1 } or { winner: null } for a draw. null = keep playing.
  result(state, lang) {
    return null; // (check for three in a row here)
  },

  // What to draw for this player.
  view(state, player, lang) {
    const pieces = [];
    state.board.forEach((p, i) => {
      if (p !== null) pieces.push({ row: Math.floor(i / 3), col: i % 3, piece: p === 0 ? 'x' : 'o' });
    });
    return { pieces, message: state.turn === player ? 'Your turn' : "Opponent's turn" };
  },
};
```

That's all. When someone clicks, boardmadang turns the click into `{ kind: 'click', row, col }` and calls `play()`.
Both players' browsers run your `play()` with the same clicks in the same order, so they always see the same board.
Your code never deals with the network, the screen, or who the opponent is.
On the site your code runs in a sandbox, so `fetch`, storage, `eval`, and `Worker` aren't available.

## Four rules your code must follow

1. **Same input, same result.** Don't use `Math.random()` or `Date.now()`.
   If you need randomness, use the `rng` passed to `setup(rng)` (`rng.next()`, `rng.int(n)`).
   Otherwise the two players' boards drift apart.
2. **Don't change the state you receive.** Copy it and return a new one.
3. **Keep the state plain JSON.** Numbers, strings, booleans, arrays, plain objects.
   No `Set`, `Map`, classes, or functions.
4. **Ignore moves that aren't allowed** by returning the same state. Your game decides whose turn it is,
   and `play()` only accepts moves from the player `turn()` names.

`npx boardmadang check` catches all four, plays 200 random games, and checks speed and size limits.

## Optional parts

| Add this | When |
|---|---|
| `legal(state, player)` | Return the moves allowed right now. Shows hover hints and helps the AI learn. |
| `observe(state, player)` | Extra info you can't see on the board (like castling rights in chess), for the AI. |
| `specialActions: ['pass']` | Moves that aren't on the board (up to 8). Boardmadang shows them as buttons below the board and sends `{ kind: 'pass' }`. You can set the button text [as shown below](#panels-buttons-and-motion). |

Resigning is built into the site, so your game doesn't handle it.

## Drawing (`view`)

Return what to show. Boardmadang does the drawing.

```js
view(state, player, lang) {
  return {
    pieces:  [{ row: 1, col: 1, piece: 'x' }],
    marks:   [{ row: 1, col: 1, type: 'last-move' }],
    tint:    [{ row: 0, col: 0, color: 0 }],  // color a square with player 0's color
    text:    [{ row: 2, col: 2, text: '4' }], // a short label on a square
    lines:   [{ from: { row: 0, col: 0 }, to: { row: 2, col: 2 }, color: 1 }], // a line between two squares
    message: 'Your turn',
  };
}
```

| Mark | Meaning |
|---|---|
| `dot` | You can move here |
| `ring` | Selected piece |
| `last-move` | The last move |
| `danger` | Danger (like check) |
| `ghost` | See-through piece (needs `piece`), e.g. a preview |
| `blocked` | A square you can't use (darkened) |
| `frame` | A colored border (needs `color`), e.g. a goal square. Set `width` to make it 1–30% of a square's side (default 9%) |

**Colors:** a `color` is a player color (`0`, `1`), a named board-palette color (`'green'`, `'yellow'`, `'gray'`), or `'#rrggbb'`.
Boardmadang draws board backgrounds (the `plain`, `checker` and `wood` looks), player colors, marks, chess pieces and stones from one palette,
so every game's board looks like part of the same set. `'#rrggbb'` may clash with it, so prefer player colors and named colors.

**Lines (`lines`):** a see-through line drawn over the pieces, from the center of one square to another. You can set `color` (default dark gray)
and `width` (1–50% of a square's side, default 20%). Add `hover: { row, col }` to show it only while the mouse is over that square,
for example to preview which stones a move would connect to. If your game has `legal()`, the mouse only counts as over squares you can play.
Lines aren't part of what the AI sees, and lines with `hover` aren't saved in thumbnails.

**Paint previews:** a `tint` can also have `hover: { row, col }`. It's then drawn only while the mouse is over that square, lighter,
in place of that square's usual tint — for example to show which squares a move would turn your color.
Tints with `hover` aren't part of what the AI sees and aren't saved in thumbnails.

**On phones:** a finger can't hover, so pressing the board and sliding shows the preview (lines and tints with `hover`) for the square under the finger,
and lifting the finger plays that square. A quick tap plays right away, as before. Pressing a piece that has no preview clicks it at once,
so players can pick a piece and drag it to where it should go (like on Lichess).

**Board options:** `places` is `'cells'` (inside squares, like chess) or `'points'` (on line crossings, like go).
`rows` and `cols` are how many places there are (up to 32). You can also set `look` (`'plain'`, `'checker'`, `'wood'`),
`starPoints`, `labels`, and `flipForPlayer` (show the board upside down for one player, like black in chess).

**Pieces:** use a built-in set (`'xo'`, `'go-stones'`, `'chess'`) or list your own names, like `['red', 'blue']`.
Your own names are drawn as circles, colored by their order in the list, with the first two characters of the name.

The site puts a red (first player) or blue (second player) dot next to each player's name. Give each player a piece, first player then second, like `playerPieces: ['black', 'white']`, and the site draws that piece instead of the dot, so everyone sees who plays which stones.

To draw pieces like janggi or shogi pieces, put a **lettered tile** in the list instead of a name. It is a square tile with a character on it, and small triangles on its edges show the directions it can move.

```js
pieces: [
  { name: 'wK', text: '王', player: 0, arrows: ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] },
  { name: 'wP', text: '子', player: 0, arrows: ['n'] },
  { name: 'bK', text: '王', player: 1, arrows: ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] },
  // …
],
```

- `name`: the name you use as `piece` in `view()`. The AI's observation is split by this name too.
- `text`: the characters on the tile, 1 or 2.
- `player` (optional): the tile's owner. The tile is drawn in that player's color and faces its owner: the bottom player's tiles stand upright and the top player's are upside down (also on a board flipped with `flipForPlayer`).
- `arrows` (optional): the direction marks. `'n'` is forward from the owner's side, then clockwise `'ne'`, `'e'`, `'se'`, `'s'`, `'sw'`, `'w'`, `'nw'`.

You can mix names and tiles in one list. `text` on a cell with a tile is drawn small in the cell's corner so it doesn't cover the tile (a count of pieces in hand, for example).

## Panels, buttons and motion

Things that aren't part of the board, like a piece picker, pieces in hand or a preview of the next piece, don't have to sit in board squares.
All six parts below are optional. Without them, everything is drawn as before.

```js
board: {
  places: 'cells', rows: 13, cols: 12,
  // take the right 4 columns off the board and draw them as two separate panels to its right
  areas: [
    { side: 'right', row: 0, col: 8, rows: 4, cols: 4 }, // preview of the picked piece
    { side: 'right', row: 5, col: 8, rows: 2, cols: 4 }, // pieces you can pick
  ],
},
specialActions: ['rotate'],

view(state, player, lang) {
  return {
    pieces: [
      // from: it just fell from row 0, so it is shown falling
      { row: 12, col: 3, piece: 'black', from: { row: 0, col: 3 } },
      { row: 5, col: 8, piece: 'black' },                              // panel squares work like any square
    ],
    // pressing the edge (columns 6 and 7) counts as pressing column 5, where the piece fits
    aliases: [{ from: { row: 0, col: 6 }, to: { row: 0, col: 5 } }, { from: { row: 0, col: 7 }, to: { row: 0, col: 5 } }],
    // the text and order of the buttons below the board
    buttons: [{ kind: 'rotate', label: lang === 'ko' ? '↻ 돌리기' : '↻ Rotate' }],
    // a stone that was just captured: shown breaking apart on its square
    effects: [{ row: 11, col: 3, piece: 'white', id: 42 }],
  };
},
```

**Areas (`board.areas`):** pick rectangles of the whole grid and draw them as separate panels above (`top`), below (`bottom`), left of (`left`)
or right of (`right`) the board (up to 8). Coordinates don't change, so `view()`, clicks, `legal()` and the AI use whole-grid coordinates exactly as without areas.
The board is the rectangle left in the middle. Squares that are in neither the board nor an area (in the example, the right 4 squares of rows 4 and 7–12)
aren't drawn and can't be pressed. If areas overlap or don't leave a board in the middle, `check` tells you, and the whole grid is drawn without areas.
On a board flipped with `flipForPlayer`, the areas appear on the other side. Coordinate `labels`, default `starPoints` and the board size shown in the lobby and on the game page (13×8 in the example) count only the board.

**Lists (`board.lists`, `view().lists`):** small panels outside the grid that only show things, like the order of upcoming pieces (up to 4).
They take no squares of the grid, so they can't be pressed and don't make the board, the AI's input or its moves any bigger.

```js
board: {
  // ...
  // 20 rows × 10 columns at 0.4 of the square size, starting at the top-left corner of square (6, 0) (under a 4-column panel)
  lists: [{ at: { row: 6, col: 0 }, rows: 20, cols: 10, scale: 0.4 }],
},
view(state, player, lang) {
  return {
    pieces: [/* ... */],
    // the pieces of board.lists[0], in list coordinates (0-19, 0-9)
    lists: [{ pieces: [{ row: 0, col: 0, piece: 'black' }, { row: 1, col: 0, piece: 'black' }] }],
  };
},
```

A list is drawn from the top-left corner of its `at` square (`scale` 0.25–1, default 1), so put `at` on an empty square under an area to continue that panel.
If it runs past the edge, the canvas grows to fit. On a flipped board it hangs from that square's bottom-right corner instead, but what's inside isn't flipped.
`from` on a piece can be a list square, `{ list, row, col }`, and a piece in a list can have a board square as `from`: it moves and changes size between the two.
The AI doesn't see lists. If it needs to know what they show (the upcoming pieces, say), give it to the AI with `observe()`.

**Buttons (`view().buttons`):** sets the order and text of the `specialActions` buttons. Write the text in `lang`.
Only the listed buttons are shown, so you can leave out buttons that can't be used now. If your game has `legal()`, buttons not in `legal()` are dimmed and can't be pressed.
Without `buttons`, every `specialActions` entry is shown with its name, as before.

**Click aliases (`view().aliases`):** when the mouse or finger is on the `from` square, it counts as being on the `to` square, for clicks and `hover` previews alike.
Use it in games where "the column you press is the piece's left edge", so pressing an edge square where the piece would stick out still drops it where it fits.
`legal()` only needs the `to` square, so the AI doesn't see duplicate moves.

**Motion (`pieces[].from`):** `from` on a piece means "it just came from that square". The first time boardmadang draws that view, it moves the piece from `from` to its place.
Pieces that go straight down the screen fall and speed up; others slide. Motion is tracked per piece. Each motion is shown only once, so you can keep returning the same `from` until the next move, and if you give another piece (one in hand, say) a new `from` in the meantime, only that piece moves.
Pieces jump straight to their place when the viewer has asked their system for reduced motion, or when a replay skips several moves.

**Effects (`view().effects`):** one-off effects. Give a piece that isn't in this view anymore, like one that was just captured, as `{ row, col, piece }`,
and boardmadang draws it on that square, cracks it, and breaks it into four pieces that fly apart and fade (`type: 'shatter'`, the default).
`type: 'flash'` makes it glow white, then shrink and fade instead, for pieces the rules clear away (like a full line in Tetris).
Each effect is shown only once, so you can keep returning the same `effects` until the next move. If the same piece can vanish from the same square twice in a row, tell them apart with `id` (the piece's number, say).
Effects start together with motion, so the pieces fly apart while the stones above come down. They aren't shown when the viewer has asked for reduced motion, or when a replay skips several moves.

`areas` are kept in thumbnails. `lists`, `from`, `aliases`, `buttons` and `effects` are not part of what the AI sees and aren't saved in thumbnails.

## Thumbnail

There are no image uploads. Instead, the picture in the game list is a **snapshot of a real board**.
In the playground, play until the board looks the way you want, then press **Use as thumbnail** under a board.
It saves that board to `thumbnail.json`, and the site draws it with the same board renderer as the game.

- If there's no thumbnail, the site shows the starting position.
- If you later change `board` or `pieces` in your code, take the snapshot again. `check` will remind you.
- You can also take one the same way on the site's register page while you clear the game.

## listing.json: the text on the site

`listing.json` holds what players read: the name, a one-line description, the rules, difficulty (`easy`, `normal`, `hard`),
languages, and the timer. You can also fill it in on the site when you register.

```json
{
  "languages": { "en": "full", "ko": "full" },
  "difficulty": "easy",
  "timer": { "minutes": 10, "custom": true },
  "name": { "en": "Tic-tac-toe", "ko": "틱택토" },
  "description": { "en": "Fill a line first to win.", "ko": "한 줄을 먼저 채우면 이깁니다." },
  "rulebook": { "en": "Two players take turns…", "ko": "두 사람이 번갈아…" }
}
```

- **Languages:** `full` means your game's own text (`message` in `view`, `reason` in `result`) is translated too.
  `rulebook` means only the name, description, and rules are. Boardmadang passes one of your `full` languages as `lang`,
  so keep your in-game text in a small table per language.
- **Timer:** each player gets this many minutes in total, like a chess clock (1 to 180, or `null` for none).
  `custom: true` lets a room host pick their own time.

## Limits

| | Max |
|---|---|
| Board size (`rows`, `cols`) | 32 |
| Kinds of pieces | 32 |
| `maxActions` | 2,000 |
| Game code | 256 KB |
| State (as JSON) | 64 KB |
| Time per `play()` | 2 ms on average, 50 ms at most |

Big games are fine for people playing each other. The AI just gets a fixed training budget, so it ends up weaker in bigger games.

## Editor autocomplete

Add a type comment above your game to get autocomplete in VS Code and other editors.
For it to find the types, install the package in your game folder with `npm i -D boardmadang`.

```js
/** @type {import('boardmadang').Game<State>} */
export default { /* … */ };
```

The full types are in [game.d.ts](https://github.com/shin1244/boardmadang/blob/main/sdk/game.d.ts).

## FAQ

**Who owns my game?** You do. This SDK is MIT, and your game does not become AGPL like the boardmadang server.
See [LICENSING.md](https://github.com/shin1244/boardmadang/blob/main/LICENSING.md).

**Can I hide my code?** It's protected by copyright, but games run in the players' browsers, so anyone can read the code
with the browser's developer tools. That's true for every website.

**Do I need to know about servers?** No. Your game is pure rules. Matchmaking, clocks, reconnecting,
replays, and spectating are all handled by boardmadang.
