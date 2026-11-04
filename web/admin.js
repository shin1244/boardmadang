// 운영자 화면: 신고를 대상(의견이나 게임)별로 묶어 보고 조치합니다. 설계는 docs/moderation.md에 있습니다.
// GET /api/admin으로 신고, 정지된 계정, 운영 기록을 한 번에 받고, 조치는 POST /api/admin/actions로 하나씩 보냅니다.
// 조치하고 나면 다시 불러옵니다. 운영자(서버의 ADMIN_IDS)가 아니면 서버가 403을 주고 안내만 보입니다.
// 맨 위의 통계(GET /api/admin/stats)는 admin-stats.js가 불러오고 그립니다. 새로고침하면 같이 다시 불러옵니다.
// "AI 모델" 칸에서는 운영자가 학습한 모델(trainer/train.py --export-onnx의 model.onnx, model.json)을 올리고 지웁니다
// (PUT, DELETE /api/admin/ai/<게임>, server/internal/ai). 올린 모델은 /api/games의 ai로 나가고 로비에 "AI와 두기"가 생깁니다.

import { localize } from '/sdk/playground/listing.js';
import { applyStatic, detectLang, lang, setLang, setupLangButtons, t } from './i18n.js';
import { displayName, loadMe, renderMe } from './me.js';
import { loadStats, renderStats, setupStats } from './admin-stats.js';

const $ = (sel) => document.querySelector(sel);

let me = null;
/** GET /api/admin의 응답 { targets, users, suspended, log, days } */
let state = null;
/** 불러오지 못한 이유: 'login' | 'admin' | 'missing' | 오류 글 */
let denied = '';
let games = new Map(); // 게임 id → /api/games 항목 (레포 게임과 로비에 있는 올린 게임의 이름)
let busy = false;
/** 조치의 결과 글 { key, params, ok } */
let status = null;
/** AI 모델 칸의 결과 글 { key, params, ok } */
let aiStatus = null;
let showClosed = false;
/** 대상마다 적고 있는 메모와 고른 정지 기간. 다시 그려도 남게 따로 둡니다 */
const notes = new Map();
const picked = new Map();

const ERRORS = {
  'bad action': 'admin.error.bad',
  'not found': 'admin.error.notFound',
  'cannot suspend an admin': 'admin.error.admin',
  'too long': 'admin.error.tooLong',
  'admin only': 'admin.denied',
  'no session': 'admin.login',
};

const keyOf = (target) => `${target.game}/${target.comment ?? ''}`;
const when = (s) => new Date(s).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
const period = (days) => (days ? t('admin.days', { n: days }) : t('admin.forever'));

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text, onClick, cls = 'btn ghost') {
  const b = el('button', cls, text);
  b.type = 'button';
  b.disabled = busy;
  b.addEventListener('click', onClick);
  return b;
}

function gameName(id, info) {
  const listing = info?.listing ?? games.get(id)?.listing;
  return localize(listing?.name, lang).text || id;
}

/** 계정 id의 이름. 운영자 화면이라 지금 이름 옆에 id도 보입니다 */
function userName(id) {
  const u = state.users[id];
  if (!u || u.gone) return t('admin.user.gone');
  if (u.guest) return t('admin.user.guest');
  return u.name;
}

function userLine(id) {
  const u = state.users[id] ?? { id, gone: true };
  const span = el('span', 'admin-user', userName(id));
  const tags = [];
  if (u.admin) tags.push(t('admin.user.admin'));
  if (u.suspended) tags.push(t('admin.user.suspended', { until: untilText(u) }));
  for (const text of tags) span.append(' ', el('small', 'mine-tag', text));
  span.append(' ', el('small', 'admin-id', id));
  return span;
}

const untilText = (u) => (u.suspendedUntil ? t('admin.until', { date: when(u.suspendedUntil) }) : t('admin.forever'));

// ---- 불러오기와 조치 ----

async function load({ fresh = false } = {}) {
  try {
    const [res, gamesRes] = await Promise.all([
      fetch('/api/admin', { cache: 'no-store' }),
      games.size && !fresh ? null : fetch('/api/games', { cache: 'no-store' }).catch(() => null),
      loadStats(),
    ]);
    if (gamesRes?.ok) games = new Map((await gamesRes.json()).map((g) => [g.id, g]));
    if (res.status === 401) denied = 'login';
    else if (res.status === 403) denied = 'admin';
    else if (res.status === 404) denied = 'missing'; // 개발 서버(serve.js)에는 운영자 API가 없습니다
    else if (!res.ok) throw new Error(res.status);
    else {
      state = await res.json();
      denied = '';
    }
  } catch (e) {
    denied = t('admin.failed', { msg: e.message });
  }
}

/**
 * 조치 하나를 보내고 다시 불러옵니다.
 * @param {object} action POST /api/admin/actions의 본문 (action, game, comment, user, days)
 * @param {string} [ask] 먼저 물어볼 글
 */
async function act(action, ask) {
  if (busy || (ask && !confirm(ask))) return;
  const key = action.game ? `${action.game}/${action.comment ?? ''}` : null;
  const note = key ? (notes.get(key) ?? '').trim() : '';
  busy = true;
  status = null;
  render();
  try {
    const res = await fetch('/api/admin/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...action, note: note || undefined }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      status = ERRORS[body.error]
        ? { key: ERRORS[body.error] }
        : { key: 'admin.actionFailed', params: { msg: body.error ?? res.status } };
    } else {
      status = { key: 'admin.done', ok: true };
      if (key) notes.delete(key);
      await load();
    }
  } catch (e) {
    status = { key: 'admin.actionFailed', params: { msg: e.message } };
  }
  busy = false;
  render();
}

// ---- 신고 ----

function renderTarget(target) {
  const key = keyOf(target);
  const li = el('li', 'admin-target');
  li.classList.toggle('open', target.open);
  const comment = !!target.comment;

  const head = el('div', 'admin-head');
  head.append(el('span', `admin-badge${target.open ? ' open' : ''}`, t(target.open ? 'admin.open' : 'admin.closed')));
  const title = el('b', 'admin-title', `${t(comment ? 'admin.kind.comment' : 'admin.kind.game')} · `);
  const link = el('a', '', gameName(target.game, target.gameInfo));
  link.href = `/web/?game=${encodeURIComponent(target.game)}`;
  title.append(link);
  head.append(title, el('span', 'admin-when', t('admin.reports', { n: target.reports.length, date: when(target.latest) })));
  li.append(head);

  // 신고받은 것
  let subject = null; // 정지할 수 있는 사람 (의견을 쓴 사람이나 게임을 올린 사람)
  if (comment) {
    const c = target.commentInfo;
    if (!c) {
      li.append(el('p', 'admin-meta', t('admin.comment.gone')));
    } else {
      li.append(el('blockquote', 'admin-quote', c.text));
      const meta = el('p', 'admin-meta');
      if (c.author.kind === 'member') {
        subject = c.author.id;
        meta.append(t('admin.comment.author'), ' ', userLine(c.author.id));
      } else {
        meta.append(t('admin.comment.author'), ' ', displayName(c.author));
      }
      meta.append(' · ', commentState(c));
      li.append(meta);
    }
  } else if (target.gameInfo) {
    const g = target.gameInfo;
    subject = g.owner;
    const meta = el('p', 'admin-meta');
    meta.append(t('admin.game.owner'), ' ', userLine(g.owner), ' · ',
      t('admin.game.meta', { id: g.id, version: g.version.slice(0, 8), date: when(g.published) }), ' · ',
      t(g.blocked ? 'admin.game.blocked' : g.hidden ? 'admin.game.hidden' : 'admin.game.listed'));
    li.append(meta);
  } else {
    li.append(el('p', 'admin-meta', t('admin.game.repo')));
  }

  // 신고들 (최근 것부터)
  const reports = el('ul', 'admin-reports');
  for (const r of target.reports) {
    const item = el('li');
    item.append(el('b', '', t(`report.reason.${r.reason}`)));
    if (r.detail) item.append(' ', el('q', 'admin-detail', r.detail));
    const by = el('span', 'admin-by');
    by.append(' — ', userName(r.by), ' · ', when(r.at));
    item.append(by);
    reports.append(item);
  }
  li.append(reports);

  const last = target.lastAction;
  if (last) {
    li.append(el('p', 'admin-last', t('admin.last', {
      who: userName(last.by), what: actionText(last), date: when(last.at),
    }) + (last.note ? ` — ${last.note}` : '')));
  }

  // 조치
  const actions = el('div', 'admin-actions');
  const base = { game: target.game, comment: target.comment || undefined };
  const c = target.commentInfo;
  if (comment && c && !c.deleted) {
    actions.append(c.hidden
      ? button(t('admin.do.show'), () => act({ ...base, action: 'comment.show' }))
      : button(t('admin.do.hide'), () => act({ ...base, action: 'comment.hide' })));
  }
  const g = target.gameInfo;
  if (!comment && g) {
    const name = gameName(g.id, g);
    actions.append(g.blocked
      ? button(t('admin.do.unblock'), () => act({ ...base, action: 'game.unblock' }))
      : button(t('admin.do.block'), () => act({ ...base, action: 'game.block' }, t('admin.confirm.block', { name }))));
  }
  const u = subject && state.users[subject];
  if (u && !u.gone && !u.guest && !u.admin) {
    if (u.suspended) {
      actions.append(button(t('admin.do.unsuspend', { name: u.name }),
        () => act({ ...base, action: 'user.unsuspend', user: u.id }, t('admin.confirm.unsuspend', { name: u.name }))));
    } else {
      actions.append(suspendControl(key, u, base));
    }
  }
  if (target.open) {
    actions.append(button(t('admin.do.dismiss'), () => act({ ...base, action: 'dismiss' })));
  }
  const note = el('input', 'admin-note');
  note.type = 'text';
  note.maxLength = 300;
  note.placeholder = t('admin.note');
  note.setAttribute('aria-label', t('admin.note'));
  note.value = notes.get(key) ?? '';
  note.disabled = busy;
  note.addEventListener('input', () => notes.set(key, note.value));
  li.append(note, actions);
  return li;
}

/** 정지 기간 고르기와 정지 버튼 */
function suspendControl(key, u, base) {
  const box = el('span', 'admin-suspend');
  const select = el('select');
  select.setAttribute('aria-label', t('admin.period'));
  for (const days of state.days) {
    const option = el('option', '', period(days));
    option.value = String(days);
    select.append(option);
  }
  select.value = picked.get(key) ?? String(state.days[1] ?? state.days[0]);
  select.disabled = busy;
  select.addEventListener('change', () => picked.set(key, select.value));
  const go = button(t('admin.do.suspend', { name: u.name }), () => {
    const days = Number(select.value);
    act({ ...base, action: 'user.suspend', user: u.id, days },
      t('admin.confirm.suspend', { name: u.name, period: period(days) }));
  }, 'btn danger');
  box.append(select, go);
  return box;
}

function commentState(c) {
  if (c.deleted) return t('admin.comment.deleted');
  if (c.mod === 'hidden') return t('admin.comment.modHidden');
  if (c.mod === 'shown') return t('admin.comment.modShown', { n: c.reporters });
  return c.hidden ? t('admin.comment.hidden', { n: c.reporters }) : t('admin.comment.visible', { n: c.reporters });
}

function actionText(a) {
  const params = { name: a.user ? userName(a.user) : '', period: a.until ? t('admin.until', { date: when(a.until) }) : t('admin.forever') };
  return t(`admin.action.${a.action}`, params);
}

// ---- 정지된 계정과 운영 기록 ----

function renderSuspended(id) {
  const u = state.users[id];
  const li = el('li', 'room');
  const info = el('div', 'room-info');
  info.append(el('b', 'room-game', u.name), el('span', 'room-sub', `${untilText(u)} · ${id}`));
  li.append(info, button(t('admin.do.unsuspend', { name: u.name }),
    () => act({ action: 'user.unsuspend', user: id }, t('admin.confirm.unsuspend', { name: u.name }))));
  return li;
}

function renderLog(a) {
  const li = el('li');
  li.append(el('time', 'admin-when', when(a.at)), ' ', el('b', '', userName(a.by)), ' · ', actionText(a));
  if (a.game) {
    // 내린 게임은 /api/games에 없으므로 신고 목록에 있는 그 게임의 정보로 이름을 찾습니다
    const info = state.targets.find((x) => x.game === a.game && x.gameInfo)?.gameInfo;
    const name = gameName(a.game, info);
    const target = a.comment ? `${name} · ${t('admin.kind.comment')} ${a.comment}` : name;
    li.append(' · ', el('span', 'admin-by', target));
  }
  if (a.note) li.append(' — ', el('q', 'admin-detail', a.note));
  return li;
}

// ---- AI 모델 ----

/** 파일을 base64로 (data: 주소의 앞부분을 뗌) */
function base64Of(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** 고른 파일에서 model.onnx와 model.json을 찾습니다 */
function pickedFiles() {
  const files = [...$('#ai-files').files];
  return { onnx: files.find((f) => f.name.endsWith('.onnx')), json: files.find((f) => f.name.endsWith('.json')) };
}

/** model.json을 고르면 그 게임을 골라 둡니다 */
async function onFiles() {
  aiStatus = null;
  const { json } = pickedFiles();
  if (json) {
    try {
      const meta = JSON.parse(await json.text());
      if (games.has(meta.game)) $('#ai-game').value = meta.game;
    } catch {
      aiStatus = { key: 'admin.ai.badJson' };
    }
  }
  render();
}

async function uploadModel(e) {
  e.preventDefault();
  if (busy) return;
  const { onnx, json } = pickedFiles();
  if (!onnx || !json) {
    aiStatus = { key: 'admin.ai.needBoth' };
    render();
    return;
  }
  const game = $('#ai-game').value;
  busy = true;
  aiStatus = null;
  render();
  try {
    const meta = JSON.parse(await json.text());
    const res = await fetch(`/api/admin/ai/${encodeURIComponent(game)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta, model: await base64Of(onnx) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      aiStatus = ERRORS[body.error] ? { key: ERRORS[body.error] } : { key: 'admin.ai.failed', params: { msg: body.error ?? res.status } };
    } else {
      aiStatus = { key: 'admin.ai.uploaded', params: { name: gameName(game) }, ok: true };
      $('#ai-form').reset();
      await load({ fresh: true });
    }
  } catch (err) {
    aiStatus = { key: 'admin.ai.failed', params: { msg: err.message } };
  }
  busy = false;
  render();
}

async function deleteModel(game) {
  if (busy || !confirm(t('admin.ai.confirmDelete', { name: gameName(game) }))) return;
  busy = true;
  aiStatus = null;
  render();
  try {
    const res = await fetch(`/api/admin/ai/${encodeURIComponent(game)}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) aiStatus = { key: 'admin.ai.failed', params: { msg: body.error ?? res.status } };
    else {
      aiStatus = { key: 'admin.ai.deleted', params: { name: gameName(game) }, ok: true };
      await load({ fresh: true });
    }
  } catch (err) {
    aiStatus = { key: 'admin.ai.failed', params: { msg: err.message } };
  }
  busy = false;
  render();
}

/** 모델이 있는 게임 한 줄: 이름, 탐색 횟수, 학습한 버전이 지금과 같은지, 올린 때 */
function renderModel(g) {
  const li = el('li', 'room');
  const info = el('div', 'room-info');
  info.append(el('b', '', gameName(g.id)), ' ', el('small', 'admin-id', g.id));
  const version = g.ai.version === null ? t('admin.ai.versionUnknown')
    : g.ai.version === g.version ? t('admin.ai.versionSame') : t('admin.ai.versionOld');
  info.append(el('small', 'room-meta', t('admin.ai.meta', { sims: g.ai.sims, version, date: when(g.ai.updated) })));
  li.append(info, button(t('admin.ai.delete'), () => deleteModel(g.id)));
  return li;
}

function renderModels() {
  const select = $('#ai-game');
  const chosen = select.value;
  const list = [...games.values()];
  select.replaceChildren(...list.map((g) => {
    const o = el('option', '', `${gameName(g.id)} (${g.id})`);
    o.value = g.id;
    return o;
  }));
  if (games.has(chosen)) select.value = chosen;
  const withAI = list.filter((g) => g.ai);
  $('#ai-count').textContent = `${withAI.length}`;
  $('#ai-list').replaceChildren(...withAI.map(renderModel));
  $('#ai-empty').hidden = withAI.length > 0;
  $('#ai-empty').textContent = t('admin.ai.none');
  $('#ai-upload').disabled = busy;
  const s = $('#ai-status');
  s.textContent = aiStatus ? t(aiStatus.key, aiStatus.params) : '';
  s.classList.toggle('good', !!aiStatus?.ok);
}

// ---- 그리기 ----

function render() {
  applyStatic('admin.title');
  renderMe(me);
  const deniedEl = $('#denied');
  deniedEl.hidden = !denied;
  deniedEl.textContent = {
    login: t('admin.login'), admin: t('admin.denied'), missing: t('admin.missing'),
  }[denied] ?? denied;
  $('#body').hidden = !!denied || !state;
  if ($('#body').hidden) return;
  renderStats((id) => gameName(id));

  const open = state.targets.filter((x) => x.open);
  const shown = showClosed ? state.targets : open;
  $('#queue-count').textContent = `${open.length}`;
  $('#targets').replaceChildren(...shown.map(renderTarget));
  const empty = $('#queue-empty');
  empty.hidden = shown.length > 0;
  empty.textContent = t(showClosed ? 'admin.queue.none' : 'admin.queue.empty');
  const statusEl = $('#status');
  statusEl.textContent = status ? t(status.key, status.params) : '';
  statusEl.classList.toggle('good', !!status?.ok);
  $('#refresh').disabled = busy;

  $('#suspended-count').textContent = `${state.suspended.length}`;
  $('#suspended').replaceChildren(...state.suspended.map(renderSuspended));
  $('#suspended-empty').hidden = state.suspended.length > 0;
  $('#suspended-empty').textContent = t('admin.suspended.empty');

  renderModels();

  $('#log').replaceChildren(...state.log.map(renderLog));
  $('#log-empty').hidden = state.log.length > 0;
  $('#log-empty').textContent = t('admin.log.empty');
}

async function main() {
  setupLangButtons(render);
  setLang(await detectLang());
  setupStats(render);
  $('#show-closed').addEventListener('change', (e) => {
    showClosed = e.target.checked;
    render();
  });
  $('#ai-files').addEventListener('change', onFiles);
  $('#ai-form').addEventListener('submit', uploadModel);
  $('#refresh').addEventListener('click', async () => {
    if (busy) return;
    status = null;
    busy = true;
    render();
    await load();
    busy = false;
    render();
  });
  render();
  me = await loadMe();
  await load();
  render();
}

main();
