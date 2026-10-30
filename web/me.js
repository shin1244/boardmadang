// 지금 신원 (게스트 또는 계정)과 상단의 로그인 · 로그아웃. 설계는 docs/identity.md에 있습니다.
// /api/me를 부르면 서버가 세션 쿠키를 주거나 새로 발급합니다. 웹소켓에 붙기 전에 꼭 한 번 불러 둡니다.
// 개발 서버는 가짜 신원을 돌려줍니다 (DEV_AS=guest면 게스트). 진짜로 로그인하면 그 계정을 그대로 돌려줍니다.

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

/** 서버에 켜진 로그인 방법 (google, github). 없으면 로그인 버튼이 "준비 중"입니다. */
let providers = null;
let lastMe = null;
/** 로그인에 실패하고 돌아왔으면 그 이유 (서버가 주소에 ?login_error=를 붙입니다). 한 번 보여주고 주소에서 뗍니다. */
let loginError = null;
let setUp = false;

const PROVIDERS = ['google', 'github'];
const ERRORS = ['cancelled', 'expired', 'state', 'provider', 'server'];

function setup() {
  setUp = true;
  const url = new URL(location.href);
  loginError = url.searchParams.get('login_error');
  if (loginError) {
    url.searchParams.delete('login_error');
    history.replaceState(history.state, '', url);
  }
  fetch('/api/auth/providers')
    .then((res) => (res.ok ? res.json() : { providers: [] }))
    .catch(() => ({ providers: [] }))
    .then((body) => {
      providers = (body.providers ?? []).filter((p) => PROVIDERS.includes(p));
      renderMe(lastMe);
      if (loginError && !isMember(lastMe)) openMenu(true);
    });

  const button = document.querySelector('.login');
  button.addEventListener('click', () => openMenu(document.querySelector('.login-menu').hidden));
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.login-box')) openMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('.login-menu').hidden) {
      openMenu(false);
      button.focus();
    }
  });
  document.querySelector('.logout').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } finally {
      location.reload();
    }
  });
}

function openMenu(open) {
  const menu = document.querySelector('.login-menu');
  if (open && !providers?.length) return;
  menu.hidden = !open;
  document.querySelector('.login').setAttribute('aria-expanded', String(open));
  if (!open) loginError = null;
}

/** 로그인 메뉴: 로그인 방법마다 링크 하나. 로그인하고 나면 지금 화면으로 돌아옵니다. */
function renderMenu() {
  const menu = document.querySelector('.login-menu');
  const next = location.pathname + location.search;
  menu.replaceChildren();
  if (loginError) {
    const p = document.createElement('p');
    p.className = 'login-error';
    p.setAttribute('role', 'alert');
    p.textContent = t(ERRORS.includes(loginError) ? `login.error.${loginError}` : 'login.error.server');
    menu.append(p);
  }
  for (const name of providers ?? []) {
    const a = document.createElement('a');
    a.href = `/auth/${name}?next=${encodeURIComponent(next)}`;
    a.className = `login-${name}`;
    a.setAttribute('role', 'menuitem');
    a.textContent = t(`login.${name}`);
    menu.append(a);
  }
  const hint = document.createElement('p');
  hint.className = 'login-hint';
  hint.textContent = t('login.hint');
  menu.append(hint);
}

/** 상단 메뉴의 신원 표시 (누르면 내 대국 목록)와 로그인 · 로그아웃. 화면 언어가 바뀌면 다시 부릅니다. */
export function renderMe(me) {
  lastMe = me;
  if (!setUp) setup();
  const el = document.querySelector('.me');
  el.hidden = !me;
  el.textContent = displayName(me);
  el.title = isMember(me) ? '' : t('guest.hint');

  const member = isMember(me);
  document.querySelector('.logout').hidden = !member;
  const button = document.querySelector('.login');
  button.hidden = member;
  button.disabled = !providers?.length;
  // 서버에 로그인 방법이 하나도 없으면 "준비 중"
  button.title = providers?.length === 0 ? t('soon') : '';
  if (member) openMenu(false);
  renderMenu();
}
