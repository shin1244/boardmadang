// 약관과 개인정보: 본문은 legal.html에 한국어와 영어로 함께 있고, 화면 언어에 맞는 쪽만 보여 줍니다.

import { applyStatic, detectLang, lang, setLang, setupLangButtons } from './i18n.js';
import { loadMe, renderMe } from './me.js';

let me = null;

function render() {
  applyStatic('legal.title');
  renderMe(me);
  for (const el of document.querySelectorAll('.legal [lang]')) el.hidden = el.lang !== lang;
}

async function main() {
  setupLangButtons(render);
  setLang(await detectLang());
  render();
  // 본문을 화면 언어로 바꾸면 높이가 달라지므로, 그 뒤에 #terms, #privacy로 갑니다
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  me = await loadMe();
  render();
}

main();
