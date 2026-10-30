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
| `npx boardmadang pack` | If the checks pass, makes `<id>.zip` for uploading. |

Uploading on boardmadang.com is coming soon.

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

## Four rules your code must follow

1. **Same input, same result.** Don't use `Math.random()` or `Date.now()`.
   If you need randomness, use the `rng` passed to `setup(rng)` (`rng.next()`, `rng.int(n)`).
   Otherwise the two players' boards drift apart.
2. **Don't change the state you receive.** Copy it and return a new one.
3. **Keep the state plain JSON.** Numbers, strings, booleans, arrays, plain objects.
   No `Set`, `Map`, classes, or functions.
4. **Ignore moves that aren't allowed** by returning the same state. Your game decides whose turn it is.

`npx boardmadang check` catches all four, plays 200 random games, and checks speed and size limits.

## Optional parts

| Add this | When |
|---|---|
| `turn(state)` | Return whose turn it is (`0`, `1`, or `null` when the game is over). Needed for a game timer. |
| `legal(state, player)` | Return the moves allowed right now. Shows hover hints and helps the AI learn. |
| `observe(state, player)` | Extra info you can't see on the board (like castling rights in chess), for the AI. |
| `specialActions: ['pass']` | Moves that aren't on the board. Boardmadang shows them as buttons and sends `{ kind: 'pass' }`. |

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
| `frame` | A colored border (needs `color`), e.g. a goal square |

**Board options:** `places` is `'cells'` (inside squares, like chess) or `'points'` (on line crossings, like go).
`rows` and `cols` are how many places there are (up to 32). You can also set `look` (`'plain'`, `'checker'`, `'wood'`),
`starPoints`, `labels`, and `flipForPlayer` (show the board upside down for one player, like black in chess).

**Pieces:** use a built-in set (`'xo'`, `'go-stones'`, `'chess'`) or list your own names, like `['red', 'blue']`.

## Thumbnail

There are no image uploads. Instead, the picture in the game list is a **snapshot of a real board**.
In the playground, play until the board looks the way you want, then press **Use as thumbnail** under a board.
It saves that board to `thumbnail.json`, and the site draws it with the same board renderer as the game.

- If there's no thumbnail, the site shows the starting position.
- If you later change `board` or `pieces` in your code, take the snapshot again. `check` will remind you.

## listing.json: the text on the site

`listing.json` holds what players read: the name, a one-line description, the rules, difficulty (`easy`, `normal`, `hard`),
languages, and the timer. You can also fill it in on the site later, without uploading your code again.

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
  `custom: true` lets a room host pick their own time. A timer needs `turn()`.

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
