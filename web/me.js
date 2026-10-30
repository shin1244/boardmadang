// 지금 신원 (게스트 또는 계정). 설계는 docs/identity.md에 있습니다.
// /api/me를 부르면 서버가 세션 쿠키를 주거나 새로 발급합니다. 웹소켓에 붙기 전에 꼭 한 번 불러 둡니다.
// 개발 서버는 가짜 신원을 돌려줍니다 (DEV_AS=guest면 게스트).

import { t } from './i18n.js';

/** @typedef {{ id: string, kind: 'guest' | 'member', tag: string, name?: string }} Me */

/** @type {Promise<Me | null> | null} */
let pending = null;

/** 한 페이지에서 여러 번 불러도 요청은 한 번입니다. 실패하면 null (화면은 게스트처럼 그립니다). */
export function loadMe() {
  pending ??= fetch('/api/me')
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  return pending;
}

export const isMember = (me) => me?.kind === 'member';

/** 화면에 보일 이름. 게스트 이름은 화면 언어로 만듭니다 ("게스트 4821" / "Guest 4821"). */
export function displayName(me) {
  if (!me) return '';
  return isMember(me) ? me.name : t('guest.name', { tag: me.tag });
}

/** 상단 메뉴의 신원 표시. 계정이면 로그인 버튼을 숨깁니다. */
export function renderMe(me) {
  const el = document.querySelector('.me');
  el.hidden = !me;
  el.textContent = displayName(me);
  el.title = isMember(me) ? '' : t('guest.hint');
  document.querySelector('.login').hidden = isMember(me);
}
