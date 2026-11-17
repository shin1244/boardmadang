// 소리 켜고 끄기: 판이 내는 기물 놓는 소리(sdk/playground/board.js의 playPlace)를 상단의 스피커 버튼으로 끄고 켭니다.
// 판은 소리를 낼 때마다 저장된 값을 읽으므로 여기서는 값만 바꿉니다 (board.js의 SOUND_KEY와 같은 이름, 기본은 켬).
// 판이 있는 화면(대국, AI 대국, 관전, 다시보기, 게임 등록)에만 넣습니다. theme.js처럼 <head>에서 바로 도는 스크립트입니다.
(() => {
  const KEY = 'boardmadang.sound';
  const root = document.documentElement;
  let on = true;
  try {
    on = localStorage.getItem(KEY) !== '0';
  } catch {
    // 저장소를 못 쓰는 브라우저면 기본(켬)
  }

  // 버튼에는 지금 상태를 그립니다: 켜져 있으면 소리 나는 스피커, 꺼져 있으면 빗금 친 스피커
  const SPEAKER = 'M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z';
  const ON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${SPEAKER}"/><path d="M10.5 6a3 3 0 0 1 0 4M12.3 4.2a5.5 5.5 0 0 1 0 7.6"/></svg>`;
  const OFF = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${SPEAKER}"/><path d="M10.8 6.2l3.4 3.6M14.2 6.2l-3.4 3.6"/></svg>`;
  // 화면 언어(i18n.js가 <html lang>에 둠)에 맞춘 버튼 이름. 한국어가 아니면 영어
  const LABEL = {
    ko: { on: '소리 끄기', off: '소리 켜기' },
    en: { on: 'Turn sound off', off: 'Turn sound on' },
  };

  function addButton() {
    const bar = document.querySelector('.topbar');
    if (!bar || bar.querySelector('.sound-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sound-btn';
    const paint = () => {
      btn.innerHTML = on ? ON : OFF;
      const label = (LABEL[root.lang] ?? LABEL.en)[on ? 'on' : 'off'];
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-pressed', String(on));
      btn.title = label;
    };
    btn.addEventListener('click', () => {
      on = !on;
      try {
        localStorage.setItem(KEY, on ? '1' : '0');
      } catch {
        // 저장 못 하면 판이 읽을 값이 없어 소리는 켜진 채입니다. 버튼만 바뀌지 않게 되돌립니다
        on = true;
      }
      paint();
    });
    new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['lang'] });
    paint();
    // 테마 버튼 앞에 (theme.js가 먼저 돌아 넣어 둡니다). 없으면 언어 버튼 앞에
    bar.insertBefore(btn, bar.querySelector('.theme-btn') ?? bar.querySelector('.langs'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addButton);
  else addButton();
})();
