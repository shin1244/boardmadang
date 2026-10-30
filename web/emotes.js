// 대국 중에 상대와 주고받는 이모티콘. 채팅 대신 정해진 그림만 보냅니다 (욕설, 개인정보가 오갈 수 없게).
// 바둑돌과 체스 기물을 작고 귀엽게 그린 SVG입니다. 색은 테마와 상관없이 고정이고, 밝은 화면과 어두운 화면에서 다 보이게 테두리를 둡니다.
// id 목록은 서버(protocol.Emotes)와 같아야 합니다. 이모티콘을 더하면 둘 다 고칩니다.

import { t } from './i18n.js';

const INK = '#33313f'; // 흰 것의 테두리와 얼굴
const BLACK = '#2d2f3a';
const RIM = '#8d92a8'; // 검은 돌의 테두리 (어두운 화면에서도 보이게)
const WHITE = '#fbfaf6';
const WOOD = '#f6e5c3'; // 체스 기물
const WOOD_LINE = '#6b4a2b';
const CHEEK = '#ff8fa3';
const DROP = '#7ec8ff';
const DROP_LINE = '#3b7fb3';

const cheeks = (x1, x2, y) =>
  `<ellipse cx="${x1}" cy="${y}" rx="3.6" ry="2.2" fill="${CHEEK}" opacity=".75"/><ellipse cx="${x2}" cy="${y}" rx="3.6" ry="2.2" fill="${CHEEK}" opacity=".75"/>`;
/** 웃는 눈 (^ ^) */
const happyEyes = (x1, x2, y, color) =>
  `<path d="M${x1 - 3.5} ${y + 1.5} Q${x1} ${y - 3} ${x1 + 3.5} ${y + 1.5} M${x2 - 3.5} ${y + 1.5} Q${x2} ${y - 3} ${x2 + 3.5} ${y + 1.5}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`;
/** 감은 눈 (꾸벅) */
const closedEyes = (x1, x2, y, color) =>
  `<path d="M${x1 - 3.5} ${y} Q${x1} ${y + 3} ${x1 + 3.5} ${y} M${x2 - 3.5} ${y} Q${x2} ${y + 3} ${x2 + 3.5} ${y}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round"/>`;
/** 동그란 눈 (반짝이 하나) */
const dotEyes = (x1, x2, y, color, r = 2.8) =>
  `<circle cx="${x1}" cy="${y}" r="${r}" fill="${color}"/><circle cx="${x2}" cy="${y}" r="${r}" fill="${color}"/>` +
  `<circle cx="${x1 + 0.9}" cy="${y - 0.9}" r="${r * 0.35}" fill="#fff"/><circle cx="${x2 + 0.9}" cy="${y - 0.9}" r="${r * 0.35}" fill="#fff"/>`;
const whiteStone = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${WHITE}" stroke="${INK}" stroke-width="2.4"/>` +
  `<path d="M${cx - r * 0.62} ${cy + r * 0.5} A${r * 0.8} ${r * 0.8} 0 0 0 ${cx + r * 0.62} ${cy + r * 0.5}" fill="none" stroke="#e6e1d3" stroke-width="3" stroke-linecap="round"/>`;
const blackStone = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${BLACK}" stroke="${RIM}" stroke-width="2.4"/>` +
  `<ellipse cx="${cx - r * 0.38}" cy="${cy - r * 0.45}" rx="${r * 0.3}" ry="${r * 0.16}" fill="#666b80" transform="rotate(-30 ${cx - r * 0.38} ${cy - r * 0.45})"/>`;
const piece = (d) => `<path d="${d}" fill="${WOOD}" stroke="${WOOD_LINE}" stroke-width="2.4" stroke-linejoin="round"/>`;

/** @type {{ id: string, svg: string }[]} 팔레트에 이 순서로 나옵니다 */
export const EMOTES = [
  {
    // 흰 돌이 손을 흔들며 인사
    id: 'hello',
    svg: whiteStone(29, 36, 21) + happyEyes(22, 36, 35, INK) + cheeks(18, 40, 41) +
      `<path d="M25.5 42 Q29 46 32.5 42" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>` +
      `<circle cx="52" cy="24" r="5" fill="${WHITE}" stroke="${INK}" stroke-width="2.2"/>` +
      `<path d="M56 11 Q60 14 60 19 M51 9 Q53 10 54 12" fill="none" stroke="${RIM}" stroke-width="2.2" stroke-linecap="round"/>`,
  },
  {
    // 검은 돌이 두 손을 모으고 꾸벅
    id: 'please',
    svg: `<g transform="rotate(-14 32 38)">${blackStone(32, 36, 21)}${closedEyes(25, 39, 36, '#fff')}${cheeks(21, 43, 41)}` +
      `<path d="M30 43 Q32 45 34 43" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></g>` +
      `<circle cx="27" cy="56.5" r="4.6" fill="${BLACK}" stroke="${RIM}" stroke-width="2"/><circle cx="36" cy="56.5" r="4.6" fill="${BLACK}" stroke="${RIM}" stroke-width="2"/>` +
      `<path d="M54 8 L55.4 12.6 L60 14 L55.4 15.4 L54 20 L52.6 15.4 L48 14 L52.6 12.6 Z" fill="#ffd166" stroke="#b9822b" stroke-width="1.2" stroke-linejoin="round"/>`,
  },
  {
    // 폰이 위를 보며 고민
    id: 'think',
    svg: piece('M32 9 a8.5 8.5 0 1 1 -0.01 0 Z') +
      piece('M21 29.5 Q32 25 43 29.5 Q32 34 21 29.5 Z') +
      piece('M25 32 C25 41 18 46 16 52 L48 52 C46 46 39 41 39 32 Z') +
      `<rect x="12" y="51" width="40" height="8" rx="4" fill="${WOOD}" stroke="${WOOD_LINE}" stroke-width="2.4"/>` +
      `<circle cx="27.5" cy="41" r="2.8" fill="${INK}"/><circle cx="36.5" cy="41" r="2.8" fill="${INK}"/>` +
      `<circle cx="28.4" cy="39.8" r="1" fill="#fff"/><circle cx="37.4" cy="39.8" r="1" fill="#fff"/>` +
      `<path d="M29.5 47 L34.5 46" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>` +
      `<g fill="${WOOD}" stroke="${WOOD_LINE}" stroke-width="1.4"><circle cx="47" cy="17" r="2"/><circle cx="52" cy="11.5" r="2.6"/><circle cx="58" cy="5.5" r="3.2"/></g>`,
  },
  {
    // 나이트가 깜짝
    id: 'wow',
    svg: piece('M19 52 C21 45 23 41 26 37 L19 38.5 C14 39.5 11 35 13 31 C16 23 23 17 31 15.5 L35 8 L39 15 C47 19 50 30 47 40 C46 44 46 48 47 52 Z') +
      `<path d="M38 18 C42 22 43 27 42 32" fill="none" stroke="${WOOD_LINE}" stroke-width="2" stroke-linecap="round"/>` +
      `<rect x="13" y="51" width="38" height="8" rx="4" fill="${WOOD}" stroke="${WOOD_LINE}" stroke-width="2.4"/>` +
      `<circle cx="30" cy="25" r="5.2" fill="#fff" stroke="${INK}" stroke-width="2"/><circle cx="29.5" cy="25.5" r="2.6" fill="${INK}"/>` +
      `<ellipse cx="18.5" cy="34" rx="2.4" ry="3" fill="${INK}"/>` +
      `<ellipse cx="25" cy="33" rx="3" ry="1.9" fill="${CHEEK}" opacity=".75"/>` +
      `<path d="M7 6 L8 18" stroke="#ef5350" stroke-width="3.4" stroke-linecap="round"/><circle cx="8.6" cy="24" r="2" fill="#ef5350"/>`,
  },
  {
    // 킹이 배를 잡고 웃음
    id: 'haha',
    svg: `<rect x="29" y="2.5" width="6" height="15" rx="2" fill="${WOOD}" stroke="${WOOD_LINE}" stroke-width="2.2"/>` +
      `<rect x="24.5" y="6.5" width="15" height="5.5" rx="2" fill="${WOOD}" stroke="${WOOD_LINE}" stroke-width="2.2"/>` +
      piece('M19 18 Q32 13 45 18 Q46 23 44 25 C45 35 49 45 51 52 L13 52 C15 45 19 35 20 25 Q18 23 19 18 Z') +
      `<rect x="10" y="51" width="44" height="8" rx="4" fill="${WOOD}" stroke="${WOOD_LINE}" stroke-width="2.4"/>` +
      happyEyes(25.5, 38.5, 32, INK) +
      `<path d="M25 37.5 Q32 49 39 37.5 Z" fill="#9b3f4b" stroke="${INK}" stroke-width="2" stroke-linejoin="round"/>` +
      `<path d="M28.5 43 Q32 40.5 35.5 43 Q32 46 28.5 43 Z" fill="#ff8fa3"/>` +
      `<path d="M19 33 C17.5 36 17 38 18.5 39.5 C20 40.5 21.5 38.5 19 33 Z M45 33 C47.5 38.5 46 40.5 45.5 39.5 C47 38 46.5 36 45 33 Z" fill="${DROP}" stroke="${DROP_LINE}" stroke-width="1"/>`,
  },
  {
    // 검은 돌이 식은땀
    id: 'oops',
    svg: blackStone(30, 36, 21) +
      `<circle cx="23" cy="34" r="4.6" fill="#fff"/><circle cx="37" cy="34" r="4.6" fill="#fff"/>` +
      `<circle cx="23.6" cy="34.6" r="2.2" fill="${BLACK}"/><circle cx="37.6" cy="34.6" r="2.2" fill="${BLACK}"/>` +
      `<path d="M23 45 q2 -2.6 4 0 t4 0 t4 0 t4 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M53 7 C56.5 13 58.5 16.5 58.5 19 A5.5 5.5 0 0 1 47.5 19 C47.5 16.5 49.5 13 53 7 Z" fill="${DROP}" stroke="${DROP_LINE}" stroke-width="1.6"/>`,
  },
  {
    // 룩이 눈물을 글썽
    id: 'sad',
    svg: piece('M15 8 H23 V14 H28 V8 H36 V14 H41 V8 H49 V24 H15 Z') +
      piece('M18.5 24 H45.5 L47.5 51 H16.5 Z') +
      `<rect x="12" y="50" width="40" height="9" rx="4" fill="${WOOD}" stroke="${WOOD_LINE}" stroke-width="2.4"/>` +
      `<path d="M21.5 29.5 L27.5 31.5 M42.5 29.5 L36.5 31.5" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>` +
      dotEyes(25, 39, 36, INK, 3.1) +
      `<path d="M28 45.5 Q32 41.5 36 45.5" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>` +
      `<path d="M23.5 40 C21.5 44 21 46.5 22.8 47.8 C24.6 48.8 26.2 46.8 23.5 40 Z" fill="${DROP}" stroke="${DROP_LINE}" stroke-width="1.2"/>`,
  },
  {
    // 흰 돌과 검은 돌이 나란히, 하트
    id: 'gg',
    svg: whiteStone(21, 40, 16) + blackStone(44, 41, 16) +
      happyEyes(16, 26, 40, INK) + happyEyes(39, 49, 41, '#fff') +
      `<ellipse cx="13" cy="45" rx="2.8" ry="1.7" fill="${CHEEK}" opacity=".75"/><ellipse cx="52" cy="46" rx="2.8" ry="1.7" fill="${CHEEK}" opacity=".75"/>` +
      `<path d="M19 46 Q21 48.5 23 46" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>` +
      `<path d="M42 47 Q44 49.5 46 47" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>` +
      `<path d="M32.5 22 C23 15.5 24.5 6.5 29.5 7 C31.3 7.2 32.5 8.8 32.5 10.2 C32.5 8.8 33.7 7.2 35.5 7 C40.5 6.5 42 15.5 32.5 22 Z" fill="#ff6b8a" stroke="#c23b5a" stroke-width="1.6" stroke-linejoin="round"/>`,
  },
];

export const emoteIds = EMOTES.map((e) => e.id);

/** id의 그림을 <svg>로 만듭니다. 없는 id면 null. 글은 화면 언어로 붙입니다 (aria-label). */
export function emoteSvg(id, label) {
  const e = EMOTES.find((x) => x.id === id);
  if (!e) return null;
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg viewBox="0 0 64 64" role="img" aria-label="">${e.svg}</svg>`;
  const svg = tpl.content.firstElementChild;
  svg.setAttribute('aria-label', label);
  return svg;
}

/** 말풍선을 띄워 두는 시간 (ms). 서버가 받는 간격(EmoteEvery 2초)보다 조금 깁니다 */
const SHOW_MS = 3000;
/** 보낸 뒤 버튼을 잠그는 시간 (ms). 서버의 EmoteEvery와 같습니다 */
export const EMOTE_EVERY = 2000;

export const emoteLabel = (id) => t(`emote.${id}`);

const timers = new WeakMap();

/** 말풍선 el에 id 그림을 잠깐 띄웁니다. 띄워 둔 사이에 또 오면 새 그림으로 바꿔 처음부터 띄웁니다. */
export function popEmote(el, id) {
  const svg = emoteSvg(id, emoteLabel(id));
  if (!svg) return;
  el.replaceChildren(svg);
  el.hidden = false;
  el.classList.remove('pop');
  void el.offsetWidth; // 애니메이션을 처음부터 다시
  el.classList.add('pop');
  clearTimeout(timers.get(el));
  timers.set(el, setTimeout(() => {
    el.hidden = true;
  }, SHOW_MS));
}

const MUTE_KEY = 'boardmadang.emotes.muted';

/** 상대 이모티콘을 끈 상태인지 (이 브라우저에 저장) */
export function emotesMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setEmotesMuted(muted) {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    // 저장하지 못해도 이번 화면에는 적용됩니다
  }
}
