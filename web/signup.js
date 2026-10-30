// 이름 정하기: 처음 로그인한 사람이 보드마당에서 쓸 이름을 정합니다 (docs/identity.md).
// 서버가 가입 정보를 쿠키에 넣고 이리로 보냅니다. GET /auth/signup으로 기본 이름을 받고, POST /auth/signup으로 계정을 만듭니다.
// 이름 규칙은 서버(internal/account)가 확인합니다. 여기서는 글자 수만 미리 봅니다.

import { applyStatic, detectLang, setLang, setupLangButtons, t } from './i18n.js';
import { loadMe, renderMe } from './me.js';

const $ = (sel) => document.querySelector(sel);

let me = null;
let info = null; // { provider, suggested, min, max }. null이면 불러오는 중
let expired = false;
let error = null; // 서버가 알려 준 이유 (name length, name chars, name reserved, expired …)

const PROVIDER_NAMES = { google: 'Google', github: 'GitHub', dev: 'dev' };
const ERRORS = { 'name length': 'signup.error.length', 'name chars': 'signup.error.chars', 'name reserved': 'signup.error.reserved' };

function render() {
  applyStatic('signup.title');
  renderMe(me);
  $('#expired').hidden = !expired;
  $('#form').hidden = expired || !info;
  if (!info) return;
  $('#lead').textContent = t('signup.lead', { provider: PROVIDER_NAMES[info.provider] ?? info.provider });
  $('#rules').textContent = t('signup.rules', { min: info.min, max: info.max });
  $('#name').maxLength = info.max;
  const msg = error && (ERRORS[error] ? t(ERRORS[error]) : t('signup.error.server', { msg: error }));
  $('#error').hidden = !msg;
  $('#error').textContent = msg ?? '';
}

async function submit(e) {
  e.preventDefault();
  const name = $('#name').value.trim();
  if ([...name].length < info.min || [...name].length > info.max) {
    error = 'name length';
    return render();
  }
  $('#submit').disabled = true;
  let res = null;
  let body = {};
  try {
    res = await fetch('/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    body = await res.json().catch(() => ({}));
  } catch {
    // 아래에서 알립니다
  }
  $('#submit').disabled = false;
  if (res?.ok) {
    location.replace(body.next || '/web/');
    return;
  }
  if (body.error === 'expired') expired = true;
  error = body.error ?? String(res?.status ?? '-');
  render();
}

async function main() {
  setupLangButtons(render);
  setLang(await detectLang());
  render();
  $('#form').addEventListener('submit', submit);
  $('#name').addEventListener('input', () => {
    error = null;
    render();
  });
  const [m, res] = await Promise.all([loadMe(), fetch('/auth/signup').catch(() => null)]);
  me = m;
  if (res?.ok) {
    info = await res.json();
    $('#name').value = info.suggested ?? '';
  } else {
    expired = true;
  }
  render();
  if (info) $('#name').focus();
}

main();
