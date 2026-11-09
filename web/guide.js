// 서버가 만든 페이지(게임 페이지와 소개 페이지)의 스크립트입니다. HTML은 server/internal/site/pages/에 있습니다.
// 글은 서버가 이 페이지의 언어로 다 적어 두었습니다. 여기서는 로비와 같은 코드로 로그인과 화면 언어 메뉴를 붙이고 게임 그림을 그립니다.
// 화면 언어 메뉴에서 다른 언어를 고르면 그 언어의 같은 페이지(<link rel="alternate" hreflang>)로 갑니다.

import { BoardView, innerSize } from '/sdk/playground/board.js';
import { loadGame } from './engine.js';
import { applyStatic, lang, setLang, setupLangButtons } from './i18n.js';
import { loadMe, renderMe } from './me.js';

// 탭 제목은 서버가 정한 것(검색 결과와 같은 제목)을 그대로 둡니다. applyStatic은 사이트 이름으로 바꿉니다
const title = document.title;
let me = null;

function render() {
  applyStatic();
  document.title = title;
  renderMe(me);
}

/** 썸네일이 없는 게임의 시작 판에 쓸 고정 시드 (web/lobby.js의 THUMB_SEED와 같음) */
const THUMB_SEED = 1;

/**
 * 그릴 판: 썸네일(판 설정, 기물 세트, 화면 데이터)이 있으면 그것, 없으면 로비처럼 게임 코드를 실행기의 샌드박스에 불러
 * 시작 판을 받습니다. 그릴 수 없으면 null
 */
async function shotOf(canvas) {
  if (canvas.dataset.thumb) {
    try {
      return JSON.parse(canvas.dataset.thumb);
    } catch {
      return null;
    }
  }
  let runner = null;
  try {
    runner = await loadGame({ module: canvas.dataset.module });
    const { look } = await runner.start(THUMB_SEED, { players: [0], lang: canvas.dataset.lang });
    const view = look.views[0] ?? { pieces: [] };
    return { board: runner.info.board, pieces: runner.info.pieces, view: { ...view, marks: (view.marks ?? []).filter((m) => m.type !== 'last-move') } };
  } catch {
    return null;
  } finally {
    runner?.close();
  }
}

/** 게임 그림을 로비의 카드처럼 보드 렌더러로 그립니다. 그릴 수 없으면 그림 칸을 뺍니다 */
async function drawThumb() {
  const canvas = document.querySelector('.gp-thumb canvas');
  if (!canvas) return;
  const box = canvas.parentElement;
  const shot = await shotOf(canvas);
  if (!shot) {
    box.hidden = true;
    return;
  }
  const draw = () => {
    const { w, h } = innerSize(box);
    const size = Math.floor(Math.min(w, h));
    if (size <= 0) return;
    try {
      const board = new BoardView(canvas, shot.board, shot.pieces);
      board.resize(size);
      board.draw(shot.view, { flip: shot.board.flipForPlayer === shot.player });
    } catch {
      box.hidden = true; // 깨진 썸네일이면 그림 칸을 뺍니다
    }
  };
  draw();
  let timer = 0;
  addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 120);
  });
}

setupLangButtons(() => {
  const other = document.querySelector(`link[rel="alternate"][hreflang="${lang}"]`);
  if (other) location.href = other.href;
  else render();
});
setLang(document.documentElement.lang);
render();
drawThumb();
me = await loadMe();
render();
