// 빠른 규칙의 시연 녹화 (등록 화면). 판에서 양쪽을 직접 둬서 수순을 남깁니다 (등록 정보의 demos).
// 보여줄 장면의 판을 만드는 수(준비 수)를 먼저 두고 "여기부터 보여주기"를 누른 뒤, 보여줄 수를 둡니다.
// 직접 깨기(register.js의 2단계)처럼 상태를 바꾼 행동만 남기고, 무르면 처음부터 다시 둡니다.

import { BoardView, attachInput, buttonsOf, paintPlayerDot } from '/sdk/playground/board.js';
import { DEMO_LIMITS } from '/sdk/playground/listing.js';
import { sameAction } from '/sdk/check.js';
import { loadGame } from './engine.js';
import { t } from './i18n.js';

const BOARD_PX = 380;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * 녹화 창을 띄웁니다. 저장하면 시연 { seed, moves, from, view }를, 취소하면 null을 돌려줍니다.
 * @param {{ module: string }} source 게임 코드 (loadGame에 넘길 것)
 * @param {string} lang 게임 안 글자의 언어
 * @param {string} line 이 시연이 붙을 규칙 한 줄
 * @returns {Promise<object | null>}
 */
export function recordDemo(source, lang, line) {
  return new Promise((resolve) => {
    const dialog = el('dialog', 'demo-rec');
    const canvas = el('canvas', '');
    const message = el('p', 'play-message');
    const status = el('p', 'play-status');
    const count = el('p', 'hint');
    const note = el('p', 'hint');
    const seats = el('div', 'seats');
    const specials = el('div', 'play-buttons');
    const mk = (cls, key, onClick) => {
      const b = el('button', cls, t(key));
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    };

    const s = { runner: null, board: null, seed: crypto.getRandomValues(new Uint32Array(1))[0], moves: [], from: null, seat: 0, look: null, ended: false, busy: true, error: '' };
    let hover = null;
    let result = null;
    const canPlay = () => !!s.runner && !s.busy && !s.ended && !s.error && !full();
    const shown = () => (s.from === null ? 0 : s.moves.length - s.from);
    const full = () => s.moves.length >= DEMO_LIMITS.moves || shown() >= DEMO_LIMITS.shown;
    const flipped = () => s.runner.info.board.flipForPlayer === s.seat;

    async function work(fn) {
      s.busy = true;
      note.textContent = '';
      hover = null;
      render();
      try {
        await fn();
      } catch (err) {
        s.error = err.message;
      }
      s.busy = false;
      render();
    }

    async function refresh() {
      s.look = await s.runner.look({ players: [s.seat], lang, legalFor: s.seat });
      s.ended = !!s.look.result;
    }

    /** 시드와 지금까지의 행동으로 처음부터 다시 둡니다 (무르기, 새로 하기) */
    async function rebuild() {
      let { turn } = await s.runner.start(s.seed, { players: [] });
      if (s.moves.length) turn = (await s.runner.play(s.moves, { players: [] })).steps.at(-1).turn;
      if (turn !== null) s.seat = turn;
      else if (s.moves.length === 0) s.seat = 0;
      await refresh();
    }

    async function load() {
      s.runner?.close();
      s.runner = await loadGame(source);
      if (!dialog.isConnected) return s.runner.close();
      s.board = new BoardView(canvas, s.runner.info.board, s.runner.info.pieces);
      s.board.quiet = true;
      s.board.resize(Math.min(BOARD_PX, (dialog.clientWidth || 780) - 44));
      await rebuild();
    }

    function act(action) {
      if (!canPlay()) return;
      work(async () => {
        const player = s.seat;
        const [step] = (await s.runner.play([{ player, action }], { players: [] })).steps;
        if (step.changed) {
          s.moves.push({ player, action });
          if (step.turn !== null) s.seat = step.turn;
        }
        await refresh();
        if (!step.changed) note.textContent = t('register.play.ignored');
      });
    }

    const undo = mk('btn ghost', 'register.play.undo', () => {
      if (s.busy || !s.moves.length) return;
      s.moves.pop();
      if (s.from !== null && s.from > s.moves.length) s.from = null;
      work(rebuild);
    });
    const restart = mk('btn ghost', 'register.play.restart', () => {
      if (s.busy) return;
      if (s.error) {
        // 게임 코드가 멈췄으면 실행기부터 다시 불러옵니다
        s.error = '';
        s.moves = [];
        s.from = null;
        return work(load);
      }
      s.seed = crypto.getRandomValues(new Uint32Array(1))[0];
      s.moves = [];
      s.from = null;
      work(rebuild);
    });
    const mark = mk('btn', 'demo.rec.mark', () => {
      s.from = s.moves.length;
      render();
    });
    const save = mk('btn', 'demo.rec.save', () => {
      if (!shown()) return;
      result = { seed: s.seed, moves: s.moves.map((m) => ({ player: m.player, action: { ...m.action } })), from: s.from, view: s.moves[s.from].player };
      dialog.close();
    });
    const cancel = mk('btn ghost', 'demo.rec.cancel', () => dialog.close());

    function render() {
      const info = s.runner?.info;
      status.textContent = s.error ? t('register.play.failed', { msg: s.error })
        : !s.look ? t('register.play.loading')
          : s.ended ? t('demo.rec.ended')
            : t(s.from === null ? 'demo.rec.setup' : 'demo.rec.showing');
      count.textContent = t('demo.rec.count', { setup: s.from ?? s.moves.length, shown: shown(), max: DEMO_LIMITS.shown });
      if (full() && !s.ended) note.textContent = t('demo.rec.full');

      if (s.board) {
        const view = s.look?.views[s.seat] ?? { pieces: [] };
        s.board.draw(view, { flip: flipped(), hover: canPlay() ? hover : null, myTurn: canPlay() });
        message.textContent = view.message ?? '';
      }
      // turn()이 없는 게임은 두는 쪽을 직접 고릅니다
      seats.hidden = !info || info.turn;
      for (const b of seats.querySelectorAll('button')) {
        const seat = Number(b.dataset.seat);
        b.setAttribute('aria-pressed', String(s.seat === seat));
        b.disabled = !canPlay();
        paintPlayerDot(b.querySelector('.dot'), info?.pieces, info?.playerPieces, seat);
      }
      const buttons = buttonsOf(info?.specialActions ?? [], s.look?.views[s.seat], s.look?.legal ?? null);
      const key = JSON.stringify(buttons.map((b) => [b.kind, b.label]));
      if (specials.dataset.kinds !== key) {
        specials.dataset.kinds = key;
        specials.replaceChildren(...buttons.map(({ kind, label }) => {
          const b = el('button', 'btn ghost', label);
          b.type = 'button';
          b.addEventListener('click', () => act({ kind }));
          return b;
        }));
      }
      buttons.forEach((x, i) => {
        specials.children[i].disabled = !canPlay() || x.disabled;
      });
      undo.disabled = s.busy || !s.moves.length || !!s.error;
      restart.disabled = s.busy;
      mark.disabled = s.busy || !!s.error || s.ended || s.from === s.moves.length;
      mark.textContent = t(s.from === null ? 'demo.rec.mark' : 'demo.rec.remark');
      mark.className = s.from === null ? 'btn' : 'btn ghost';
      save.disabled = s.busy || !shown();
    }

    for (const seat of [0, 1]) {
      const b = el('button', 'chip seat');
      b.type = 'button';
      b.dataset.seat = String(seat);
      b.append(el('i', 'dot'), ' ', t(seat === 0 ? 'match.first' : 'match.second'));
      b.addEventListener('click', () => {
        if (!canPlay() || s.seat === seat) return;
        s.seat = seat;
        work(refresh);
      });
      seats.append(b);
    }

    const head = el('header', '');
    head.append(el('h2', '', t('demo.rec.title')));
    const lineBox = el('p', 'demo-rec-line', line);
    const boardBox = el('div', 'play-board');
    boardBox.append(canvas, message);
    const side = el('div', 'play-side');
    const row1 = el('div', 'play-buttons');
    row1.append(mark);
    const row2 = el('div', 'play-buttons');
    row2.append(undo, restart);
    side.append(status, el('p', 'hint', t('demo.rec.lead')), count, seats, specials, row1, row2, note);
    const play = el('div', 'play');
    play.append(boardBox, side);
    const foot = el('footer', '');
    foot.append(cancel, save);
    dialog.append(head, lineBox, play, foot);
    document.body.append(dialog);

    // 판은 실행기가 준비된 뒤에 만들므로 그때그때의 판을 씁니다 (register.js의 setupPlay와 같음)
    attachInput({
      cellAt: (e, flip) => s.board?.cellAt(e, flip) ?? null,
      get view() {
        return s.board?.view;
      },
      get hover() {
        return s.board?.hover;
      },
    }, canvas, {
      flip: () => !!s.runner && flipped(),
      canHover: (cell) => {
        if (!s.board || !canPlay()) return false;
        const legal = s.look?.legal;
        return !legal || legal.some((a) => sameAction(a, { kind: 'click', ...cell }));
      },
      click: (cell) => {
        if (s.board && canPlay()) act({ kind: 'click', ...cell });
      },
      hover: (cell) => {
        hover = cell;
        if (s.board && !s.busy) render();
      },
    });

    dialog.addEventListener('close', () => {
      s.runner?.close();
      dialog.remove();
      resolve(result);
    });
    dialog.showModal();
    render();

    work(load);
  });
}
