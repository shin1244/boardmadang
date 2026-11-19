// 빠른 규칙의 시연 재생 (등록 정보의 demos, sdk/playground/listing.js).
// 시연은 그림 파일이 아니라 수순입니다. 실행기에서 한 번 끝까지 둬서 수마다의 화면(view)을 받아 두고(demoFrames),
// 그 화면들을 판에 차례로 그리며 되풀이합니다(DemoLoop). 받아 둔 뒤로는 실행기를 쓰지 않습니다.
// 규칙 카드(rules.js)와 등록 화면의 미리보기(register.js)가 같이 씁니다.

import { BoardView } from '/sdk/playground/board.js';
import { validDemo } from '/sdk/playground/listing.js';

const FIRST_MS = 900; // 시작 판을 보여주는 시간
const STEP_MS = 950; // 수 하나
const LAST_MS = 2200; // 마지막 판을 보여주고 처음으로

/**
 * 시연의 화면들: 보여주기 시작하는 판부터 마지막 수 뒤의 판까지 (보여줄 수 + 1개).
 * 지금 게임 코드에서 수순이 그대로 두어지지 않으면 null입니다 (코드를 고친 뒤의 옛 시연).
 * 실행기 하나는 판이 하나라서 여러 시연을 한꺼번에 부르지 말고 하나씩 기다립니다.
 * @param {object} runner engine.js의 loadGame()
 * @param {object} demo { seed, moves, from, view }
 * @param {string} lang 게임에 넘길 언어
 * @returns {Promise<object[] | null>}
 */
export async function demoFrames(runner, demo, lang) {
  if (!validDemo(demo)) return null;
  await runner.start(demo.seed, { players: [] }, true);
  const { steps } = await runner.play(demo.moves.map((m) => ({ player: m.player, action: m.action })), { players: [] });
  if (steps.some((s) => !s.changed)) return null;
  const frames = [];
  for (let at = demo.from; at <= demo.moves.length; at++) {
    const look = await runner.look({ players: [demo.view], lang }, at);
    frames.push(look.views[demo.view] ?? { pieces: [] });
  }
  return frames;
}

/** 화면들을 판에 되풀이해 그립니다. 보이지 않을 때는 stop()으로 멈춥니다 */
export class DemoLoop {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} info runner.info
   * @param {object[]} frames demoFrames()의 결과
   * @param {object} demo
   * @param {number} px 판이 들어갈 크기
   */
  constructor(canvas, info, frames, demo, px) {
    this.frames = frames;
    this.flip = info.board.flipForPlayer === demo.view;
    this.board = new BoardView(canvas, info.board, info.pieces);
    this.board.quiet = true;
    this.board.resize(px);
    this.timer = null;
    this.at = 0;
    this.draw(false);
  }

  draw(animate) {
    this.board.draw(this.frames[this.at], { flip: this.flip, animate });
  }

  start() {
    if (this.timer !== null) return;
    this.at = 0;
    this.draw(false);
    this.wait(FIRST_MS);
  }

  wait(ms) {
    this.timer = setTimeout(() => {
      const last = this.frames.length - 1;
      this.at = this.at >= last ? 0 : this.at + 1;
      this.draw(this.at > 0); // 처음으로 돌아갈 때는 움직임 없이
      this.wait(this.at === 0 ? FIRST_MS : this.at === last ? LAST_MS : STEP_MS);
    }, ms);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
