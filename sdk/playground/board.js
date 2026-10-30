// 범용 보드 렌더러. 게임의 board 설정과 view() 결과만 보고 그립니다.
// 게임 제작자는 이 파일을 몰라도 됩니다.

export const PLAYER_COLORS = ['#d94f4f', '#3f7fd9'];

const LOOKS = {
  plain: { bg: '#f7f4ee', line: '#555' },
  checker: { bg: '#f0d9b5', dark: '#b58863', line: '#7a5a3a' },
  wood: { bg: '#dcb36c', line: '#3b2a14' },
};

const CHESS_GLYPHS = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
const CUSTOM_COLORS = ['#d94f4f', '#3f7fd9', '#3a9a5b', '#c98a1b', '#8a55c9', '#2a9aa8', '#c9558a', '#6b6b6b'];
const COL_LABELS = 'abcdefghijklmnopqrstuvwxyzABCDEF';

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
    this.ctx = canvas.getContext('2d');
    this.points = board.places === 'points';
  }

  /** maxPx 안에 들어가도록 칸 크기를 정합니다. */
  resize(maxPx) {
    const { rows, cols, labels } = this.board;
    const span = (n) => (this.points ? n - 1 + 1.2 : n); // 교차점 모드는 양옆에 0.6칸씩 여백
    const S = Math.max(16, Math.min(110, Math.floor(Math.min(maxPx / span(cols), maxPx / span(rows)))));
    this.S = S;
    this.lab = labels ? Math.max(14, Math.round(S * 0.35)) : 0;
    this.m = this.points ? Math.round(S * 0.6) : 2;
    this.x0 = this.lab + this.m;
    this.y0 = this.m;
    const w = (n) => (this.points ? (n - 1) * S : n * S);
    this.width = this.lab + this.m * 2 + w(cols);
    this.height = this.lab + this.m * 2 + w(rows);

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    const { ctx, S, board } = this;
    const { rows, cols } = board;
    const look = LOOKS[board.look] ?? LOOKS.plain;
    const at = (r, c) => this.center(r, c, flip);

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = look.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    // 판
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
    ctx.strokeStyle = look.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (this.points) {
      for (let i = 0; i < rows; i++) {
        ctx.moveTo(this.x0, this.y0 + i * S + 0.5);
        ctx.lineTo(this.x0 + (cols - 1) * S, this.y0 + i * S + 0.5);
      }
      for (let i = 0; i < cols; i++) {
        ctx.moveTo(this.x0 + i * S + 0.5, this.y0);
        ctx.lineTo(this.x0 + i * S + 0.5, this.y0 + (rows - 1) * S);
      }
    } else if (look.dark) {
      ctx.rect(this.x0 + 0.5, this.y0 + 0.5, cols * S - 1, rows * S - 1);
    } else {
      for (let i = 0; i <= rows; i++) {
        ctx.moveTo(this.x0, this.y0 + i * S + 0.5);
        ctx.lineTo(this.x0 + cols * S, this.y0 + i * S + 0.5);
      }
      for (let i = 0; i <= cols; i++) {
        ctx.moveTo(this.x0 + i * S + 0.5, this.y0);
        ctx.lineTo(this.x0 + i * S + 0.5, this.y0 + rows * S);
      }
    }
    ctx.stroke();

    if (this.points && board.starPoints) {
      const stars = board.starPoints === true ? defaultStars(rows, cols) : board.starPoints;
      ctx.fillStyle = look.line;
      for (const p of stars) {
        const [x, y] = at(p.row, p.col);
        this.circle(x, y, Math.max(2, S * 0.1));
        ctx.fill();
      }
    }

    if (board.labels) this.drawLabels(flip);

    const marks = view.marks ?? [];
    const marksOf = (type) => marks.filter((m) => m.type === type);

    // 칸 칠하기와 바닥 표시 (말 아래)
    for (const t of view.tint ?? []) {
      const color = typeof t.color === 'number' ? PLAYER_COLORS[t.color] : t.color;
      const [x, y] = at(t.row, t.col);
      ctx.globalAlpha = 0.3;
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
      g.addColorStop(0, 'rgba(220, 40, 40, 0.75)');
      g.addColorStop(1, 'rgba(220, 40, 40, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - S / 2, y - S / 2, S, S);
    }
    for (const m of marksOf('blocked')) {
      const [x, y] = at(m.row, m.col);
      ctx.fillStyle = 'rgba(25, 25, 25, 0.55)';
      ctx.fillRect(x - S / 2, y - S / 2, S, S);
    }
    if (hover) {
      const [x, y] = at(hover.row, hover.col);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
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

    // 말 위 표시
    for (const m of marksOf('last-move')) {
      const [x, y] = at(m.row, m.col);
      if (this.points) {
        ctx.fillStyle = '#e04848';
        const d = S * 0.16;
        ctx.fillRect(x - d / 2, y - d / 2, d, d);
      } else {
        ctx.strokeStyle = '#e0a800';
        ctx.lineWidth = 3;
        ctx.strokeRect(x - S / 2 + 3, y - S / 2 + 3, S - 6, S - 6);
      }
    }
    for (const m of marksOf('ring')) {
      const [x, y] = at(m.row, m.col);
      ctx.strokeStyle = '#2e9e5b';
      ctx.lineWidth = Math.max(2, S * 0.06);
      this.circle(x, y, S * 0.44);
      ctx.stroke();
    }
    for (const m of marksOf('dot')) {
      const [x, y] = at(m.row, m.col);
      ctx.fillStyle = 'rgba(20, 20, 20, 0.35)';
      this.circle(x, y, S * 0.12);
      ctx.fill();
    }
    for (const t of view.text ?? []) {
      const [x, y] = at(t.row, t.col);
      ctx.font = `bold ${Math.round(S * 0.32)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.strokeText(String(t.text), x, y);
      ctx.fillStyle = '#1d1d1d';
      ctx.fillText(String(t.text), x, y);
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
      this.circle(x, y, S * 0.46);
      ctx.fillStyle = piece === 'black' ? '#1b1b1b' : '#f7f7f7';
      ctx.fill();
      ctx.strokeStyle = '#444';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (set === 'chess' && /^[wb][KQRBNP]$/.test(piece)) {
      ctx.font = `${Math.round(S * 0.8)}px "Segoe UI Symbol", "Noto Sans Symbols 2", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const glyph = CHESS_GLYPHS[piece[1]];
      if (piece[0] === 'w') {
        ctx.lineWidth = Math.max(1.5, S * 0.035);
        ctx.strokeStyle = '#222';
        ctx.strokeText(glyph, x, y + S * 0.04);
        ctx.fillStyle = '#fff';
      } else {
        ctx.fillStyle = '#1b1b1b';
      }
      ctx.fillText(glyph, x, y + S * 0.04);
    } else {
      // 직접 정의한 기물: 목록 순서대로 색을 정하고 이름 앞 두 글자를 씁니다.
      const idx = Array.isArray(set) ? set.indexOf(piece) : -1;
      this.circle(x, y, S * 0.38);
      ctx.fillStyle = idx >= 0 ? CUSTOM_COLORS[idx % CUSTOM_COLORS.length] : '#888';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(S * 0.28)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(idx >= 0 ? String(piece).slice(0, 2) : '?', x, y);
    }
    ctx.restore();
  }

  circle(x, y, r) {
    this.ctx.beginPath();
    this.ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}
