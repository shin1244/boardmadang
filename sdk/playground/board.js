// 범용 보드 렌더러. 게임의 board 설정과 view() 결과만 보고 그립니다.
// 게임 제작자는 이 파일을 몰라도 됩니다.

// ---- 보드마당 판 팔레트 (Night Owl 계열) ----
// 게임은 판 모양(plain, checker, wood), 플레이어 색(0, 1), 이름 붙은 색(NAMED_COLORS)만 고르고
// 실제 색은 여기서 정합니다. 그래서 어느 게임이든 판이 한 계열로 보입니다.

export const PLAYER_COLORS = ['#e0524f', '#4a7fdc'];

/** 게임이 color에 쓸 수 있는 이름 (tint, frame, lines). '#rrggbb'도 되지만 판 팔레트와 맞추려면 이름을 씁니다 */
export const NAMED_COLORS = { green: '#8cc65a', yellow: '#e8b04a', gray: '#7d8fa3' };

const LOOKS = {
  plain: { bg: '#dde5ef', line: '#4b6479' },
  checker: { bg: '#dde5ef', dark: '#8ea6be', line: '#4b6479' },
  wood: { bg: '#d6bf93', line: '#5b4a2f' },
};

/** 판 위 표시의 색 */
const MARK = {
  ring: '#0c969b', // 고른 기물
  last: '#e8b04a', // 마지막 수 (칸)
  lastPoint: '#e0524f', // 마지막 수 (교차점: 나무판 위에서 잘 보이게)
  dot: 'rgb(1 22 39 / 0.35)', // 둘 수 있는 곳
  blocked: 'rgb(1 22 39 / 0.5)', // 쓸 수 없는 칸
  hover: 'rgb(1 22 39 / 0.1)',
  finger: 'rgb(1 22 39 / 0.35)', // 손가락으로 누르고 있는 칸의 고리
  danger: '224, 82, 79',
  ink: '#262b36', // frame, lines의 기본 색
};

/** 흰 · 검은 기물과 돌: 같은 굵기의 테두리와 면 */
const PIECE_INK = {
  w: { fill: '#fbfaf6', stroke: '#262b36' },
  b: { fill: '#2b303b', stroke: '#0f1218' },
};

/**
 * 체스 기물 (100×100 칸 안의 그림). 글꼴의 체스 문자는 기기마다 모양이 달라서 직접 그립니다.
 * 체스를 두는 사람에게 익숙한 전통(스턴턴) 모양을 기하 도형으로 새로 그린 것입니다:
 * 킹은 십자가, 퀸은 뾰족한 관과 구슬로 멀리서도 구별됩니다. 모든 기물이 같은 두 단 받침에 섭니다.
 * 겹치지 않는 조각을 이어 붙이고, 비숍의 홈과 나이트의 눈 · 갈기는 evenodd로 뚫습니다.
 */
const PIECE_FOOT = 'M27 82l3-6h40l3 6z M21 82h58a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3h-58a3 3 0 0 1-3-3v-2a3 3 0 0 1 3-3z';
const CHESS_PATHS = {
  K: `M47 4h6v5h5v6h-5v6h-6v-6h-5v-6h5z M36 30c0-6 6-9 14-9s14 3 14 9l-4 8h-20z M37 38h26a2.5 2.5 0 0 1 0 5h-26a2.5 2.5 0 0 1 0-5z M40 43h20c0 12 3 22 9 33h-38c6-11 9-21 9-33z ${PIECE_FOOT}`,
  Q: `M50 6a4 4 0 1 1 0 8a4 4 0 1 1 0-8z M33 35l-3-17 8 8 4-11 6 10 2-9 2 9 6-10 4 11 8-8-3 17z M36 35h28a2.5 2.5 0 0 1 0 5h-28a2.5 2.5 0 0 1 0-5z M40 40h20c0 14 3 24 9 36h-38c6-12 9-22 9-36z ${PIECE_FOOT}`,
  R: `M30 18h9v6h6.5v-6h9v6h6.5v-6h9v14h-40z M35 32h30l-2 5v26l4 7h-34l4-7v-26z M31 70h38v6h-38z ${PIECE_FOOT}`,
  B: `M50 6a4 4 0 1 1 0 8a4 4 0 1 1 0-8z M50 15c9 7 14 15 14 23c0 7-6 11-14 11s-14-4-14-11c0-8 5-16 14-23z M53 24l4 3-8 11-4-3z M38 49h24a2.5 2.5 0 0 1 0 5h-24a2.5 2.5 0 0 1 0-5z M42 54h16c0 9 3 16 8 22h-32c5-6 8-13 8-22z ${PIECE_FOOT}`,
  N: `M31 76c0-10 4-16 11-21c-5 1-10 0-14-3c-4-3-4-8 0-11l12-9c1-6 4-10 9-13l1-8 6 7c11 4 17 17 16 31c-1 11-5 19-3 27z M51 26a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z M60 30c5 9 6 20 3 30l-3-1c3-10 2-19-2-27z ${PIECE_FOOT}`,
  P: `M50 20a10 10 0 1 1 0 20a10 10 0 1 1 0-20z M40 42h20a2.5 2.5 0 0 1 0 5h-20a2.5 2.5 0 0 1 0-5z M43 47h14c0 10 3 20 9 29h-32c6-9 9-19 9-29z ${PIECE_FOOT}`,
};
let chessPaths = null; // Path2D는 처음 그릴 때 만듭니다
const chessPath = (k) => (chessPaths ??= Object.fromEntries(Object.entries(CHESS_PATHS).map(([key, d]) => [key, new Path2D(d)])))[k];

/** 직접 정의한 기물: 목록 순서대로 이 색의 원에 이름 앞 두 글자 */
const CUSTOM_COLORS = ['#e0524f', '#4a7fdc', '#3a9a6b', '#d0942f', '#8f5bc4', '#0c969b', '#cc5f8c', '#6b7f93'];

/**
 * 글자 패의 방향 표시. n은 패 주인이 볼 때 앞(상대 쪽)이고 시계 방향으로 돕니다.
 * sdk/check.js, web/engine.js, 서버의 thumbnail.go와 같은 목록입니다.
 */
export const TILE_ARROWS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const ARROW_VEC = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };
const TILE_FACE = '#fbf7ee';
const TILE_FONT = '"Noto Serif KR", "Noto Serif CJK KR", Batang, "Songti SC", SimSun, serif';

/** 기물 목록의 한 항목 → 이름. 이름 문자열이거나 글자 패 { name, text, player, arrows } 입니다 */
export const pieceName = (p) => (typeof p === 'string' ? p : p?.name);
const COL_LABELS = 'abcdefghijklmnopqrstuvwxyzABCDEF';

/** frame 테두리와 선(lines)의 두께. 칸 한 변에 대한 %입니다 (sdk/check.js, web/engine.js와 같은 범위) */
export const FRAME_WIDTH = { min: 1, max: 30 };
export const LINE_WIDTH = { min: 1, max: 50, default: 20 };
const validWidth = (w, range) => Number.isFinite(w) && w >= range.min && w <= range.max;
/** 0 / 1이면 플레이어 색, 이름(green 등)이면 판 팔레트의 색, '#rrggbb'면 그 색 */
const colorOf = (c, fallback) => (typeof c === 'number' ? PLAYER_COLORS[c] : NAMED_COLORS[c] ?? c ?? fallback);

/** 바둑판 크기별 기본 화점 */
function defaultStars(rows, cols) {
  if (rows !== cols) return [];
  const n = rows;
  if (n === 19) {
    const d = [3, 9, 15];
    return d.flatMap((r) => d.map((c) => ({ row: r, col: c })));
  }
  if (n === 13 || n === 9) {
    const a = n === 13 ? 3 : 2;
    const b = n - 1 - a;
    const m = (n - 1) / 2;
    return [[a, a], [a, b], [b, a], [b, b], [m, m]].map(([row, col]) => ({ row, col }));
  }
  return [];
}

export class BoardView {
  constructor(canvas, board, pieceSet) {
    this.canvas = canvas;
    this.board = board;
    this.pieceSet = pieceSet;
    // 직접 정의한 기물: 이름 → 목록 순서(원의 색)와 글자 패 정의
    this.custom = new Map();
    if (Array.isArray(pieceSet)) {
      pieceSet.forEach((p, index) => {
        const name = pieceName(p);
        if (!this.custom.has(name)) this.custom.set(name, { index, tile: typeof p === 'object' ? p : null });
      });
    }
    // 글자 패를 쓰는 게임. 패는 칸을 거의 채우고 가장자리에 방향 삼각형이 있어서, 마지막 수와 고른 기물 표시를 패 바깥에 그립니다
    this.tiled = [...this.custom.values()].some((c) => c.tile);
    this.flip = false;
    this.ctx = canvas.getContext('2d');
    this.points = board.places === 'points';
  }

  /**
   * 판 전체(좌표 글자, 여백 포함)가 maxPx × maxPx 안에 들어가도록 칸 크기를 정합니다.
   * 칸 크기와 여백은 화면의 실제 픽셀(devicePixelRatio를 곱한 것) 단위의 정수로 맞춥니다.
   * 그래야 화면 배율이 125%, 150%여도 줄이 칸마다 같은 굵기로 또렷하게 그려집니다.
   */
  resize(maxPx) {
    const { rows, cols, labels } = this.board;
    const dpr = window.devicePixelRatio || 1;
    const span = (n) => (this.points ? n - 1 + 1.2 : n); // 교차점 모드는 양옆에 0.6칸씩 여백
    const lines = (n) => (this.points ? n - 1 : n);
    // 칸 크기(화면 픽셀)를 큰 것부터 줄여 가며 판 전체가 maxPx에 들어가는 첫 값을 찾습니다
    const layout = (sd) => {
      const lab = labels ? Math.round(Math.max(14, (sd / dpr) * 0.35) * dpr) : 0;
      const m = this.points ? Math.round(sd * 0.6) : Math.round(2 * dpr);
      return { sd, lab, m, w: lab + m * 2 + lines(cols) * sd, h: lab + m * 2 + lines(rows) * sd };
    };
    const limit = maxPx * dpr;
    const smallest = Math.ceil(16 * dpr);
    const sd = Math.floor(Math.min(limit / span(cols), limit / span(rows), 110 * dpr));
    let L = layout(Math.max(sd, smallest));
    while (L.sd > smallest && (L.w > limit || L.h > limit)) L = layout(L.sd - 1);

    this.dpr = dpr;
    this.S = L.sd / dpr;
    this.lab = L.lab / dpr;
    this.m = L.m / dpr;
    this.x0 = this.lab + this.m;
    this.y0 = this.m;
    this.width = L.w / dpr;
    this.height = L.h / dpr;
    // 줄 굵기: 화면 픽셀로 정수 (보통 1, 배율이 2배쯤이면 2)
    this.lw = Math.max(1, Math.round(dpr));

    this.canvas.width = L.w;
    this.canvas.height = L.h;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 칸 경계(CSS 픽셀) → 그 경계에서 시작하는 줄의 가운데. 줄이 화면 픽셀에 딱 맞게 */
  edge(v) {
    return (Math.round(v * this.dpr) + this.lw / 2) / this.dpr;
  }

  /** 논리 좌표 → 화면상의 중심점 (뒤집기 반영) */
  center(row, col, flip) {
    const { rows, cols } = this.board;
    const dr = flip ? rows - 1 - row : row;
    const dc = flip ? cols - 1 - col : col;
    const half = this.points ? 0 : this.S / 2;
    return [this.x0 + dc * this.S + half, this.y0 + dr * this.S + half];
  }

  /** 마우스 이벤트 → 논리 좌표. 보드 밖이면 null */
  cellAt(event, flip) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * this.width) / rect.width - this.x0;
    const y = ((event.clientY - rect.top) * this.height) / rect.height - this.y0;
    const pick = this.points ? Math.round : Math.floor;
    const dc = pick(x / this.S);
    const dr = pick(y / this.S);
    const { rows, cols } = this.board;
    if (dr < 0 || dr >= rows || dc < 0 || dc >= cols) return null;
    return flip ? { row: rows - 1 - dr, col: cols - 1 - dc } : { row: dr, col: dc };
  }

  draw(view, { flip = false, hover = null } = {}) {
    // attachInput이 봅니다: 미리보기가 있는지, 지금 그려진 호버
    this.view = view;
    this.hover = hover;
    this.flip = flip; // 글자 패가 어느 쪽을 보고 서는지 정할 때 씁니다
    const { ctx, S, board } = this;
    const { rows, cols } = board;
    const look = LOOKS[board.look] ?? LOOKS.plain;
    const at = (r, c) => this.center(r, c, flip);

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = look.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    // 판 (체크무늬)
    if (!this.points && look.dark) {
      ctx.fillStyle = look.dark;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if ((r + c) % 2 === 1) {
            const [x, y] = at(r, c);
            ctx.fillRect(x - S / 2, y - S / 2, S, S);
          }
        }
      }
    }

    if (board.labels) this.drawLabels(flip);

    const marks = view.marks ?? [];
    const marksOf = (type) => marks.filter((m) => m.type === type);

    // 칸 칠하기와 바닥 표시 (말 아래).
    // hover가 있는 칠하기는 마우스가 그 칸에 있을 때만, 그 칸의 원래 칠하기 대신 연하게 그립니다 ("두면 이 칸이 이 색이 됨")
    const onHover = (c) => hover !== null && hover.row === c.row && hover.col === c.col;
    const previewed = new Set((view.tint ?? []).filter((t) => t.hover && onHover(t.hover)).map((t) => t.row * cols + t.col));
    for (const t of view.tint ?? []) {
      if (t.hover ? !onHover(t.hover) : previewed.has(t.row * cols + t.col)) continue;
      const color = colorOf(t.color, MARK.ink);
      const [x, y] = at(t.row, t.col);
      ctx.globalAlpha = t.hover ? 0.28 : 0.55;
      ctx.fillStyle = color;
      if (this.points) {
        this.circle(x, y, S * 0.48);
        ctx.fill();
      } else {
        ctx.fillRect(x - S / 2, y - S / 2, S, S);
      }
      ctx.globalAlpha = 1;
    }
    for (const m of marksOf('danger')) {
      const [x, y] = at(m.row, m.col);
      const g = ctx.createRadialGradient(x, y, 0, x, y, S * 0.5);
      g.addColorStop(0, `rgba(${MARK.danger}, 0.75)`);
      g.addColorStop(1, `rgba(${MARK.danger}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - S / 2, y - S / 2, S, S);
    }
    for (const m of marksOf('blocked')) {
      const [x, y] = at(m.row, m.col);
      ctx.fillStyle = MARK.blocked;
      ctx.fillRect(x - S / 2, y - S / 2, S, S);
    }
    // 줄은 칸 색칠 위에 그립니다. 칠한 칸이 옆 줄을 덮어 줄마다 진하기가 달라 보이지 않게
    this.drawGrid(look, flip);
    // 테두리: 칸 가장자리를 따라 굵게. 교차점 모드는 점 둘레의 사각형입니다.
    // 두께는 width(칸 한 변의 %, 1~30)로 정하고, 없으면 칸의 9%(적어도 3px)입니다.
    const frameW = Math.max(3, Math.round(S * 0.09));
    for (const m of marksOf('frame')) {
      const [x, y] = at(m.row, m.col);
      const w = validWidth(m.width, FRAME_WIDTH) ? Math.max(1, (S * m.width) / 100) : frameW;
      ctx.strokeStyle = colorOf(m.color, MARK.ink);
      ctx.lineWidth = w;
      const half = this.points ? S * 0.42 : S / 2 - w / 2;
      ctx.strokeRect(x - half, y - half, half * 2, half * 2);
    }
    if (hover) {
      const [x, y] = at(hover.row, hover.col);
      ctx.fillStyle = MARK.hover;
      if (this.points) {
        this.circle(x, y, S * 0.4);
        ctx.fill();
      } else {
        ctx.fillRect(x - S / 2, y - S / 2, S, S);
      }
    }

    // 말
    for (const p of view.pieces ?? []) {
      const [x, y] = at(p.row, p.col);
      this.drawPiece(p.piece, x, y, 1);
    }
    for (const m of marksOf('ghost')) {
      const [x, y] = at(m.row, m.col);
      if (m.piece) this.drawPiece(m.piece, x, y, 0.4);
    }

    // 선: 두 칸의 가운데를 잇는 반투명한 선. hover가 있으면 마우스가 그 칸에 있을 때만 그립니다.
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.lineCap = 'round';
    for (const l of view.lines ?? []) {
      if (l.hover && !(hover && hover.row === l.hover.row && hover.col === l.hover.col)) continue;
      const [x1, y1] = at(l.from.row, l.from.col);
      const [x2, y2] = at(l.to.row, l.to.col);
      ctx.strokeStyle = colorOf(l.color, MARK.ink);
      ctx.lineWidth = Math.max(1, (S * (validWidth(l.width, LINE_WIDTH) ? l.width : LINE_WIDTH.default)) / 100);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();

    // 말 위 표시.
    // 글자 패는 칸의 84%를 채우고 가장자리 안쪽에 방향 삼각형, 가운데에 글자가 있습니다. 그래서 패 위에 겹쳐 그리면 가리므로,
    // 글자 패 게임의 마지막 수와 패 칸의 고른 기물·갈 수 있는 곳 표시는 패와 칸 경계 사이의 여백(칸 한 변의 45~50%)에 그립니다
    const outer = Math.max(2, S * 0.05); // 여백에 그리는 선의 굵기
    const tiled = new Set((view.pieces ?? []).filter((p) => this.custom.get(p.piece)?.tile).map((p) => p.row * cols + p.col));
    for (const m of marksOf('last-move')) {
      const [x, y] = at(m.row, m.col);
      if (this.points) {
        ctx.fillStyle = MARK.lastPoint;
        const d = S * 0.16;
        ctx.fillRect(x - d / 2, y - d / 2, d, d);
      } else if (this.tiled) {
        const half = S / 2 - outer / 2 - 1;
        ctx.strokeStyle = MARK.last;
        ctx.lineWidth = outer;
        ctx.strokeRect(x - half, y - half, half * 2, half * 2);
      } else {
        const inset = frameW + 3;
        ctx.strokeStyle = MARK.last;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x - S / 2 + inset, y - S / 2 + inset, S - inset * 2, S - inset * 2);
      }
    }
    for (const m of marksOf('ring')) {
      const [x, y] = at(m.row, m.col);
      ctx.strokeStyle = MARK.ring;
      if (!this.points && tiled.has(m.row * cols + m.col)) {
        const half = S / 2 - outer / 2 - 1;
        ctx.lineWidth = outer;
        this.roundSquare(x, y, half, S * 0.12);
        ctx.stroke();
        continue;
      }
      ctx.lineWidth = Math.max(2, S * 0.06);
      this.circle(x, y, S * 0.44);
      ctx.stroke();
    }
    for (const m of marksOf('dot')) {
      const [x, y] = at(m.row, m.col);
      ctx.fillStyle = MARK.dot;
      // 글자 패 위(잡을 수 있는 기물)에는 가운데 점이 글자를 가리므로, 패 바깥인 칸의 네 귀퉁이에 작은 삼각형을 그립니다
      if (!this.points && tiled.has(m.row * cols + m.col)) {
        const e = S / 2; // 칸 가운데에서 귀퉁이까지
        const l = S * 0.16; // 삼각형 두 변의 길이. 패의 둥근 모서리에 닿지 않을 만큼
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.moveTo(x + sx * e, y + sy * e);
          ctx.lineTo(x + sx * (e - l), y + sy * e);
          ctx.lineTo(x + sx * e, y + sy * (e - l));
          ctx.closePath();
        }
        ctx.fill();
        continue;
      }
      this.circle(x, y, S * 0.12);
      ctx.fill();
    }
    // 글자 패 위의 글자는 패 글자를 가리지 않게 칸의 오른쪽 아래 귀퉁이에 작게 씁니다 (손에 든 개수 같은 것)
    for (const t of view.text ?? []) {
      let [x, y] = at(t.row, t.col);
      const corner = tiled.has(t.row * cols + t.col);
      if (corner) {
        x += S * 0.34;
        y += S * 0.32;
      }
      ctx.font = `bold ${Math.round(S * (corner ? 0.24 : 0.32))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.strokeText(String(t.text), x, y);
      ctx.fillStyle = '#1d1d1d';
      ctx.fillText(String(t.text), x, y);
    }
    // 손가락으로 누르고 있는 칸: 손가락에 가려지므로 둘레에 큰 고리를 그립니다
    if (hover?.touch) {
      const [x, y] = at(hover.row, hover.col);
      ctx.strokeStyle = MARK.finger;
      ctx.lineWidth = Math.max(2, S * 0.08);
      this.circle(x, y, S * 1.05);
      ctx.stroke();
    }
  }

  /** 판의 줄 (칸 모드는 칸 경계, 교차점 모드는 놓는 줄과 화점). 줄은 화면 픽셀에 맞춰 모두 같은 굵기로 */
  drawGrid(look, flip) {
    const { ctx, S, board } = this;
    const { rows, cols } = board;
    const e = (v) => this.edge(v);
    const lw = this.lw / this.dpr;
    ctx.strokeStyle = look.line;
    ctx.lineWidth = lw;
    ctx.beginPath();
    if (this.points) {
      for (let i = 0; i < rows; i++) {
        ctx.moveTo(this.x0, e(this.y0 + i * S));
        ctx.lineTo(this.x0 + (cols - 1) * S + lw, e(this.y0 + i * S));
      }
      for (let i = 0; i < cols; i++) {
        ctx.moveTo(e(this.x0 + i * S), this.y0);
        ctx.lineTo(e(this.x0 + i * S), this.y0 + (rows - 1) * S + lw);
      }
    } else if (look.dark) {
      // 체크무늬 판은 테두리만
      ctx.rect(this.x0 + lw / 2, this.y0 + lw / 2, cols * S - lw, rows * S - lw);
    } else {
      // 마지막 줄은 판 안쪽에 오도록 줄 굵기만큼 앞에서
      for (let i = 0; i <= rows; i++) {
        const y = this.y0 + (i === rows ? rows * S - lw : i * S);
        ctx.moveTo(this.x0, e(y));
        ctx.lineTo(this.x0 + cols * S, e(y));
      }
      for (let i = 0; i <= cols; i++) {
        const x = this.x0 + (i === cols ? cols * S - lw : i * S);
        ctx.moveTo(e(x), this.y0);
        ctx.lineTo(e(x), this.y0 + rows * S);
      }
    }
    ctx.stroke();

    if (this.points && board.starPoints) {
      const stars = board.starPoints === true ? defaultStars(rows, cols) : board.starPoints;
      ctx.fillStyle = look.line;
      for (const p of stars) {
        const [x, y] = this.center(p.row, p.col, flip);
        this.circle(x, y, Math.max(2, S * 0.1));
        ctx.fill();
      }
    }
  }

  drawLabels(flip) {
    const { ctx, board } = this;
    const { rows, cols } = board;
    ctx.fillStyle = '#5a4a36';
    ctx.font = `${Math.round(this.lab * 0.7)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const bottom = this.height - this.lab / 2;
    for (let c = 0; c < cols; c++) {
      const [x] = this.center(0, c, flip);
      ctx.fillText(COL_LABELS[c], x, bottom);
    }
    for (let r = 0; r < rows; r++) {
      const [, y] = this.center(r, 0, flip);
      ctx.fillText(String(rows - r), this.lab / 2, y);
    }
  }

  drawPiece(piece, x, y, alpha) {
    const { ctx, S } = this;
    const set = this.pieceSet;
    ctx.save();
    ctx.globalAlpha = alpha;

    if (set === 'xo' && (piece === 'x' || piece === 'o')) {
      ctx.lineWidth = S * 0.1;
      ctx.lineCap = 'round';
      if (piece === 'x') {
        const d = S * 0.28;
        ctx.strokeStyle = PLAYER_COLORS[0];
        ctx.beginPath();
        ctx.moveTo(x - d, y - d);
        ctx.lineTo(x + d, y + d);
        ctx.moveTo(x + d, y - d);
        ctx.lineTo(x - d, y + d);
        ctx.stroke();
      } else {
        ctx.strokeStyle = PLAYER_COLORS[1];
        this.circle(x, y, S * 0.3);
        ctx.stroke();
      }
    } else if (set === 'go-stones' && (piece === 'black' || piece === 'white')) {
      // 돌: 체스 기물과 같은 흰 · 검은 면과 테두리
      const ink = PIECE_INK[piece === 'black' ? 'b' : 'w'];
      this.circle(x, y, S * 0.44);
      ctx.fillStyle = ink.fill;
      ctx.fill();
      ctx.strokeStyle = ink.stroke;
      ctx.lineWidth = Math.max(1, S * 0.035);
      ctx.stroke();
    } else if (set === 'chess' && /^[wb][KQRBNP]$/.test(piece)) {
      // 그림(100×100, 기물은 세로 4~90)을 칸의 88% 크기로 칸 가운데에
      const k = (S * 0.88) / 100;
      const ink = PIECE_INK[piece[0]];
      const path = chessPath(piece[1]);
      ctx.translate(x - 50 * k, y - 47 * k);
      ctx.scale(k, k);
      ctx.fillStyle = ink.fill;
      ctx.fill(path, 'evenodd');
      ctx.strokeStyle = ink.stroke;
      ctx.lineWidth = 3.5;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
    } else if (this.custom.get(piece)?.tile) {
      this.drawTile(this.custom.get(piece).tile, x, y);
    } else {
      // 직접 정의한 기물: 목록 순서대로 색을 정하고 이름 앞 두 글자를 씁니다.
      const idx = this.custom.get(piece)?.index ?? -1;
      this.circle(x, y, S * 0.38);
      ctx.fillStyle = idx >= 0 ? CUSTOM_COLORS[idx % CUSTOM_COLORS.length] : '#888';
      ctx.fill();
      ctx.strokeStyle = 'rgb(15 18 24 / 0.55)';
      ctx.lineWidth = Math.max(1, S * 0.035);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(S * 0.28)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(idx >= 0 ? String(piece).slice(0, 2) : '?', x, y);
    }
    ctx.restore();
  }

  /**
   * 글자 패: 장기 · 쇼기 말처럼 네모난 패에 글자를 쓰고, 갈 수 있는 방향마다 가장자리에 작은 삼각형을 그립니다.
   * 주인(player)이 있으면 주인 색으로 칠하고 주인 쪽을 보고 섭니다: 화면 아래쪽 플레이어의 패는 바로, 위쪽 플레이어의 패는 거꾸로.
   */
  drawTile(tile, x, y) {
    const { ctx, S } = this;
    const owned = tile.player === 0 || tile.player === 1;
    const ink = owned ? PLAYER_COLORS[tile.player] : MARK.ink;
    const top = this.board.flipForPlayer ?? 1; // 뒤집지 않은 화면에서 위쪽에 앉는 플레이어
    const bottom = this.flip ? top : 1 - top;
    ctx.translate(x, y);
    if (owned && tile.player !== bottom) ctx.rotate(Math.PI);

    const h = S * 0.42; // 패 한 변의 반
    const r = S * 0.09;
    ctx.beginPath();
    ctx.moveTo(-h + r, -h);
    ctx.arcTo(h, -h, h, h, r);
    ctx.arcTo(h, h, -h, h, r);
    ctx.arcTo(-h, h, -h, -h, r);
    ctx.arcTo(-h, -h, h, -h, r);
    ctx.closePath();
    ctx.fillStyle = TILE_FACE;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, S * 0.045);
    ctx.strokeStyle = ink;
    ctx.stroke();

    // 방향: 앞뒤좌우는 변 가운데의 삼각형, 대각선은 모서리를 채운 직각삼각형. 모두 바깥을 가리킵니다
    ctx.fillStyle = ink;
    const d = S * 0.365; // 삼각형 끝이 닿는 곳 (패 테두리 바로 안)
    const t = S * 0.085; // 삼각형 크기
    for (const a of new Set(Array.isArray(tile.arrows) ? tile.arrows : [])) {
      const v = ARROW_VEC[a];
      if (!v) continue;
      const [dx, dy] = v;
      ctx.beginPath();
      if (dx && dy) {
        ctx.moveTo(dx * d, dy * d);
        ctx.lineTo(dx * (d - t), dy * d);
        ctx.lineTo(dx * d, dy * (d - t));
      } else {
        // 끝 (dx, dy) * d, 밑변은 안쪽으로 t만큼
        const w = t * 0.8;
        ctx.moveTo(dx * d, dy * d);
        ctx.lineTo(dx * (d - t) + dy * w, dy * (d - t) + dx * w);
        ctx.lineTo(dx * (d - t) - dy * w, dy * (d - t) - dx * w);
      }
      ctx.closePath();
      ctx.fill();
    }

    const text = String(tile.text ?? '');
    ctx.font = `bold ${Math.round(S * ([...text].length > 1 ? 0.27 : 0.4))}px ${TILE_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, S * 0.02);
  }

  circle(x, y, r) {
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
  }

  /** (x, y)가 가운데이고 한 변의 반이 h, 모서리 반지름이 r인 둥근 사각형 경로. ctx.roundRect가 없는 옛 브라우저도 그립니다 */
  roundSquare(x, y, h, r) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x - h + r, y - h);
    ctx.arcTo(x + h, y - h, x + h, y + h, r);
    ctx.arcTo(x + h, y + h, x - h, y + h, r);
    ctx.arcTo(x - h, y + h, x - h, y - h, r);
    ctx.arcTo(x - h, y - h, x + h, y - h, r);
    ctx.closePath();
  }
}

/**
 * 요소의 안쪽(패딩을 뺀) 폭과 높이. 판은 이 크기로 resize해서 CSS가 늘이거나 줄이지 않게 합니다
 * (캔버스를 CSS로 소수배 줄이면 1픽셀 줄이 칸마다 다른 굵기로 보입니다).
 */
export function innerSize(el) {
  const cs = getComputedStyle(el);
  return {
    w: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    h: el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
  };
}

const sameCell = (a, b) => !!a && !!b && a.row === b.row && a.col === b.col;

/**
 * 판의 마우스와 터치 입력. 대국, AI 대국, 등록 화면, 플레이그라운드가 같이 씁니다.
 *
 * 마우스: 칸에 올리면 호버(미리보기), 누르면 그 칸을 클릭합니다.
 * 터치(펜): 손가락에는 호버가 없어서 리체스처럼 "끌어서 놓기"로 미리보기를 보여 줍니다.
 *   - 톡 치면 바로 클릭합니다 (확인 탭 없음).
 *   - 누른 채로 밀면 손가락 아래 칸이 호버가 되고(미리보기, 둘레에 큰 고리), 손을 뗀 칸을 클릭합니다.
 *     판 밖에서 떼거나 둘 수 없는 칸에서 떼면 아무것도 하지 않습니다.
 *   - 미리보기가 없는 말을 누르면 누르는 순간 클릭합니다 (스플체스의 기물 고르기).
 *     그 클릭으로 갈 칸의 미리보기가 생기면, 그대로 끌어서 갈 칸에 놓을 수 있습니다.
 *     빈칸이나 미리보기가 있는 칸은 손을 뗄 때 클릭합니다 (개척 오목처럼 미리 보고 두기).
 *
 * opts
 *   flip(): 판이 뒤집혔는지
 *   canHover(cell): 이 칸에 호버를 보여도 되는지 (지금 둘 수 있는 칸. legal()이 있으면 그 안에 있는지)
 *   click(cell): 칸 클릭 (보낼 수 있는지는 여기서 봅니다)
 *   hover(cell | null): 호버가 바뀜. 손가락이면 cell.touch가 true입니다. board.draw의 hover로 넘기고 다시 그리면 됩니다
 */
export function attachInput(board, canvas, { flip, canHover, click, hover }) {
  let press = null; // 누르고 있는 손가락 { id, start, clicked }
  let touchedAt = -Infinity; // 터치 뒤에 브라우저가 따라 보내는 마우스 이벤트와 click은 버립니다
  const fromTouch = (e) => e.timeStamp - touchedAt < 800;
  const at = (e) => board.cellAt(e, flip());
  const ok = (cell) => (cell && canHover(cell) ? cell : null);
  // 지금 그려진 호버(board.hover)와 다를 때만 알립니다. 화면이 호버를 지우고 다시 그렸으면 같은 칸이라도 다시 알립니다
  const show = (cell, touch = false) => {
    const next = cell ? { row: cell.row, col: cell.col, ...(touch ? { touch: true } : {}) } : null;
    const now = board.hover ?? null;
    if (next === null ? now === null : sameCell(next, now) && !!next.touch === !!now.touch) return;
    hover(next);
  };
  // 지금 화면에서 그 칸을 위한 미리보기가 있는지, 그 칸에 말이 있는지
  const previewed = (cell) => {
    const v = board.view ?? {};
    return (v.tint ?? []).some((t) => sameCell(t.hover, cell)) || (v.lines ?? []).some((l) => sameCell(l.hover, cell));
  };
  const hasPiece = (cell) => (board.view?.pieces ?? []).some((p) => sameCell(p, cell));

  // 판 위에서 끌어도 페이지가 스크롤되지 않고, 길게 눌러도 메뉴나 글자 선택이 뜨지 않도록
  canvas.style.touchAction = 'none';
  canvas.style.userSelect = 'none';
  canvas.style.webkitUserSelect = 'none';
  canvas.style.webkitTouchCallout = 'none';

  canvas.addEventListener('mousemove', (e) => {
    if (press || fromTouch(e)) return;
    const cell = ok(at(e));
    canvas.style.cursor = cell ? 'pointer' : 'default';
    show(cell);
  });
  canvas.addEventListener('mouseleave', () => {
    if (!press) show(null);
  });
  canvas.addEventListener('click', (e) => {
    if (fromTouch(e) || (e.pointerType && e.pointerType !== 'mouse')) return;
    const cell = at(e);
    if (cell) click(cell);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || press) return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId); // 손가락은 원래 누른 곳에 잡히지만, 펜도 판 밖까지 따라가게
    } catch {
      // 이미 떼었거나 잡을 수 없는 포인터: 판 안에서만 따라갑니다
    }
    const start = at(e);
    const clicked = !!start && hasPiece(start) && !previewed(start);
    press = { id: e.pointerId, start, clicked };
    if (clicked) click(start);
    show(ok(start), true);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (press?.id === e.pointerId) show(ok(at(e)), true);
  });
  const release = (e, cancelled) => {
    if (press?.id !== e.pointerId) return;
    const { start, clicked } = press;
    press = null;
    touchedAt = e.timeStamp;
    show(null);
    const cell = cancelled ? null : at(e);
    if (!cell) return;
    // 누른 칸에서 그대로 떼면 톡 친 것: 아직 클릭하지 않았으면 클릭 (둘 수 없는 칸도. 고른 기물 취소 같은 것)
    if (sameCell(cell, start)) {
      if (!clicked) click(cell);
    } else if (canHover(cell)) {
      click(cell);
    }
  };
  canvas.addEventListener('pointerup', (e) => release(e, false));
  canvas.addEventListener('pointercancel', (e) => release(e, true));
}
