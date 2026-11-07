// 화면 테마: 어두운 화면(Night Owl)이 기본이고, 상단의 해·달 버튼으로 밝은 화면(Light Owl)으로 바꿉니다.
// 색은 lobby.css의 :root(어두운 화면)와 :root[data-theme="light"](밝은 화면)에 있습니다.
// CSS가 그리기 전에 테마를 정해야 깜빡이지 않으므로, 모듈이 아니라 <head>에서 바로 도는 스크립트입니다.
// 고른 테마는 이 브라우저에만 저장합니다.
(() => {
  const KEY = 'boardmadang.theme';
  const root = document.documentElement;
  let theme = 'dark';
  try {
    if (localStorage.getItem(KEY) === 'light') theme = 'light';
  } catch {
    // 저장소를 못 쓰는 브라우저면 기본(어두운 화면)
  }
  root.dataset.theme = theme;

  // 버튼에는 바꿀 테마를 그립니다: 어두운 화면이면 해, 밝은 화면이면 달
  const SUN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></svg>';
  const MOON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.5 5.5 0 1 0 6.6 6.6z"/></svg>';
  // 화면 언어(i18n.js가 <html lang>에 둠)에 맞춘 버튼 이름. 한국어가 아니면 영어
  const LABEL = {
    ko: { dark: '밝은 화면으로 바꾸기', light: '어두운 화면으로 바꾸기' },
    en: { dark: 'Switch to light mode', light: 'Switch to dark mode' },
  };

  function addButton() {
    const bar = document.querySelector('.topbar');
    if (!bar || bar.querySelector('.theme-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-btn';
    const paint = () => {
      btn.innerHTML = theme === 'dark' ? SUN : MOON;
      const label = (LABEL[root.lang] ?? LABEL.en)[theme];
      btn.setAttribute('aria-label', label);
      btn.title = label;
    };
    btn.addEventListener('click', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      root.dataset.theme = theme;
      try {
        localStorage.setItem(KEY, theme);
      } catch {
        // 저장 못 해도 지금 화면에는 적용됩니다
      }
      paint();
      // 캔버스(판, 그래프)처럼 CSS 변수를 직접 읽지 않는 그림이 다시 그릴 수 있게 알립니다
      window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
    });
    new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['lang'] });
    paint();
    bar.insertBefore(btn, bar.querySelector('.langs'));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addButton);
  else addButton();
})();
