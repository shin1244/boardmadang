// 게임 실행기의 iframe 쪽 (web/engine.js가 띄웁니다).
//
// 이 문서는 sandbox="allow-scripts" iframe 안에서 돌아서 출처가 없습니다(opaque origin).
// 사이트의 쿠키, 저장소, 부모 화면에 손댈 수 없고, 서버가 붙인 CSP 때문에 네트워크(fetch, 웹소켓)도 못 씁니다.
// 게임 코드는 게임마다 Worker를 하나씩 띄워 그 안에서 돌립니다 (worker.js → host.js).
// 무한 루프가 돌아도 사이트 화면은 멈추지 않고, 부모가 그 Worker만 끝낼 수 있습니다.
//
// Worker를 띄울 수 없는 브라우저에서는 이 iframe 안에서 바로 돌립니다 (host.js를 직접 불러옴).
// 그래도 출처가 없고 CSP에 갇혀 있어 사이트 권한은 막히지만, 무한 루프에 화면이 멈추는 것은 막지 못합니다.
// 주소 끝에 #inline을 붙이면 시험용으로 늘 이 방식을 씁니다.
//
// 이 파일은 부모와 게임 사이에서 메시지를 나르기만 합니다.
//   부모 → 여기   { type: 'open' | 'close' | 'call', session, data }
//   여기 → 부모   { type: 'ready' } 한 번, 그 뒤로 { session, data } (게임 쪽이 보낸 것 그대로) 또는 { session, crashed }
// 부모는 게임 쪽이 보낸 것을 믿지 않고 모양과 크기를 검사합니다.
'use strict';

(() => {
  const HELLO_MS = 3000; // Worker가 이 안에 hello를 보내지 않으면 iframe 안에서 돌립니다
  const sessions = new Map(); // session → { worker, host, queue }
  const here = location.href.split('#')[0];
  const workerUrl = new URL('worker.js', here).href;
  const hostUrl = new URL('host.js', here).href;
  const forceInline = location.hash === '#inline';

  const tell = (msg) => parent.postMessage(msg, '*'); // 부모의 출처는 알 수 없지만 비밀은 보내지 않습니다

  // 출처가 없는 문서는 주소로 Worker를 만들 수 없어서, worker.js를 불러오기만 하는 data: 모듈로 만듭니다.
  // (blob: 주소는 Chromium이 출처 없는 문서에서 막습니다.) data: Worker는 이 문서의 CSP를 그대로 물려받습니다.
  function spawn() {
    const src = `import ${JSON.stringify(workerUrl)};\n`;
    return new Worker(`data:text/javascript,${encodeURIComponent(src)}`, { type: 'module' });
  }

  /** Worker 없이 이 iframe 안에서 돌립니다. */
  async function inline(session, s) {
    if (s.worker) s.worker.terminate();
    s.worker = null;
    try {
      const { createHost } = await import(hostUrl);
      s.host = createHost();
    } catch (err) {
      tell({ session, crashed: String(err?.message ?? err) });
      return;
    }
    for (const data of s.queue.splice(0)) call(session, s, data);
  }

  async function call(session, s, data) {
    const reply = await s.host(data);
    if (reply && sessions.get(session) === s) tell({ session, data: reply });
  }

  function open(session) {
    // ready: Worker가 hello를 보냈는지. 그 전에 온 호출은 queue에 모았다가 넘깁니다
    const s = { worker: null, host: null, ready: false, queue: [] };
    sessions.set(session, s);
    if (forceInline) return inline(session, s);
    try {
      s.worker = spawn();
    } catch {
      return inline(session, s);
    }
    const giveUp = setTimeout(() => { if (!s.ready) inline(session, s); }, HELLO_MS);
    s.worker.addEventListener('message', (ev) => {
      if (!s.ready && ev.data?.hello === true) {
        s.ready = true;
        clearTimeout(giveUp);
        for (const data of s.queue.splice(0)) s.worker.postMessage(data);
        return;
      }
      tell({ session, data: ev.data });
    });
    s.worker.addEventListener('error', (ev) => {
      if (!s.ready) {
        // 뜨지도 못했으면 (브라우저가 막았으면) iframe 안에서 돌립니다
        clearTimeout(giveUp);
        inline(session, s);
      } else {
        tell({ session, crashed: ev.message || 'worker error' });
      }
    });
  }

  addEventListener('message', (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || !Number.isInteger(m.session)) return;
    const s = sessions.get(m.session);
    if (m.type === 'open' && !s) {
      open(m.session);
    } else if (m.type === 'close' && s) {
      s.worker?.terminate();
      sessions.delete(m.session);
    } else if (m.type === 'call' && s) {
      if (s.host) call(m.session, s, m.data);
      else if (s.ready) s.worker.postMessage(m.data);
      else s.queue.push(m.data);
    }
  });

  tell({ type: 'ready' });
})();
