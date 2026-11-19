// 등록 정보 (listing): 게임 이름, 소개, 룰북, 빠른 규칙, 난이도, 지원 언어, 타이머.
// 게임 코드에는 규칙만 두고, 이 정보는 등록창에서 입력해 플랫폼이 저장합니다.
// 개발 서버는 games/<id>/listing.json 에 저장합니다.
// 등록창, 로비, 플레이그라운드, 개발 서버가 같이 쓰므로 브라우저와 Node 양쪽에서 돌아가야 합니다.

/**
 * 플랫폼이 지원하는 언어. 나라가 아니라 많이 쓰는 언어 10개입니다.
 * 앞에 있을수록 대체 언어로 먼저 고릅니다 (ko, en이 먼저).
 */
export const LANGS = ['ko', 'en', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'ar'];

/** 언어 이름은 화면 언어와 상관없이 그 언어로 씁니다. */
export const LANG_NAMES = {
  ko: '한국어',
  en: 'English',
  ja: '日本語',
  zh: '中文',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية',
};

/** 오른쪽에서 왼쪽으로 쓰는 언어. 입력칸과 룰북에 dir="rtl"을 붙입니다. */
const RTL = new Set(['ar']);

/** @param {string} lang */
export function isRtl(lang) {
  return RTL.has(lang);
}

/** 난이도. 순서대로 하, 중, 상입니다. */
export const DIFFICULTIES = ['easy', 'normal', 'hard'];

/**
 * 언어별 지원 수준.
 *   full     = 완전 번역: 소개, 룰북, 게임 안 글자(view의 message, result의 reason)까지 그 언어로 나옵니다.
 *   rulebook = 일부 번역: 소개와 룰북만 그 언어로 쓰고, 게임 안 글자는 완전 번역 언어로 나옵니다.
 */
export const SUPPORTS = ['full', 'rulebook'];

export const LIMITS = { name: 40, description: 200, rulebook: 20000, quickRules: 500 };

/** 타이머 시간(분)의 범위. 기본 타이머와 방장이 정하는 커스텀 타이머 모두 이 안이어야 합니다. */
export const TIMER_MINUTES = { min: 1, max: 180 };

/**
 * 타이머. 각 플레이어가 자기 차례에 쓸 수 있는 총 시간입니다 (체스 시계).
 *   minutes = 기본 타이머 (분). null이면 타이머 없음. 빠른 매칭은 이 시간으로 합니다.
 *   custom  = 방 만들기에서 방장이 시간을 정할 수 있는지. false면 방도 기본 타이머를 씁니다.
 * 타이머를 쓰려면 게임 코드에 turn()이 있어야 합니다 (누구 시계가 가는지 알아야 하므로).
 * 예전에 저장한 등록 정보에는 timer가 없을 수 있습니다. 그때는 타이머 없음으로 봅니다.
 */
export const NO_TIMER = { minutes: null, custom: false };

export const timerOf = (listing) => listing?.timer ?? NO_TIMER;

/** 타이머 시간 하나가 올바른지. null(없음)도 됩니다. */
export const validMinutes = (m) => m === null || (Number.isInteger(m) && m >= TIMER_MINUTES.min && m <= TIMER_MINUTES.max);

const TEXT_FIELDS = ['name', 'description', 'rulebook'];
/**
 * 비워도 되는 글.
 *   quickRules = 빠른 규칙: 대국 화면에 처음 들어온 사람에게 뜨는 규칙 카드. 한 줄이 한 항목이고, 서너 줄이 알맞습니다.
 *                안 쓰면 카드는 뜨지 않고 대국 화면의 규칙 버튼이 룰북을 보여줍니다.
 */
const OPTIONAL_FIELDS = ['quickRules'];

/**
 * 빠른 규칙의 시연 (listing.demos, 없어도 됩니다). 그림 파일이 아니라 판에서 둔 수순입니다.
 * i번째 시연은 빠른 규칙의 i번째 줄 옆에서 실제 판으로 되풀이해 보여줍니다 (모든 언어가 같이 씁니다).
 *   { seed, moves: [{ player, action }], from, view }
 *   seed, moves = 시작 판에서 여기까지 두는 수순 (제작자 클리어 기보와 같은 모양. 상태를 바꾼 행동만)
 *   from        = 앞의 from개는 보여주지 않고 바로 둔 판에서 시작합니다 (판을 만드는 준비 수)
 *   view        = 누구의 화면으로 보여줄지 (0 또는 1)
 * 시연이 없는 줄은 null입니다. 게임 코드를 고쳐 수순이 맞지 않게 되면 그 시연은 화면에서 빠집니다.
 */
export const DEMO_LIMITS = { count: 6, moves: 200, shown: 30 };

const validDemoAction = (a) => !!a && typeof a === 'object' && typeof a.kind === 'string' && a.kind.length > 0 && a.kind.length <= 32
  && (a.kind === 'click'
    ? Number.isInteger(a.row) && a.row >= 0 && a.row < 32 && Number.isInteger(a.col) && a.col >= 0 && a.col < 32
    : true); // 특수 행동은 이름만 봅니다 (저장할 때 다른 칸은 버립니다)

/** 시연 하나가 올바른 모양인지 */
export function validDemo(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (!Number.isInteger(d.seed) || d.seed < 0 || d.seed > 0xffffffff) return false;
  if (d.view !== 0 && d.view !== 1) return false;
  if (!Array.isArray(d.moves) || !d.moves.length || d.moves.length > DEMO_LIMITS.moves) return false;
  if (!Number.isInteger(d.from) || d.from < 0 || d.from >= d.moves.length || d.moves.length - d.from > DEMO_LIMITS.shown) return false;
  return d.moves.every((m) => !!m && (m.player === 0 || m.player === 1) && validDemoAction(m.action));
}

/** 저장할 모양의 시연 하나 (아는 칸만) */
const cleanDemo = (d) => ({
  seed: d.seed,
  moves: d.moves.map((m) => ({ player: m.player, action: m.action.kind === 'click' ? { kind: 'click', row: m.action.row, col: m.action.col } : { kind: m.action.kind } })),
  from: d.from,
  view: d.view,
});

/** 빠른 규칙의 항목들: 빈 줄을 빼고 줄 앞의 목록 기호(-, *, •, 1.)를 지웁니다. */
export function quickRuleLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•·]|\d+[.)])\s+/, ''))
    .filter(Boolean);
}

/**
 * 원하는 언어의 글자를 고릅니다. 그 언어가 없으면 LANGS 순서대로 있는 것을 씁니다.
 * @param {Record<string, string> | undefined} value
 * @param {string} lang
 * @returns {{ text: string, lang: string | null }} lang은 실제로 고른 언어
 */
export function localize(value, lang) {
  if (!value) return { text: '', lang: null };
  for (const l of [lang, ...LANGS]) {
    if (typeof value[l] === 'string' && value[l]) return { text: value[l], lang: l };
  }
  return { text: '', lang: null };
}

/** 완전 번역 언어들 (LANGS 순서) */
export function fullLangs(listing) {
  return LANGS.filter((l) => listing?.languages?.[l] === 'full');
}

/**
 * 게임에 넘길 언어. 유저 화면 언어를 완전 번역하면 그 언어, 아니면 첫 번째 완전 번역 언어입니다.
 * 그래서 게임의 view(), result()는 자기가 완전 번역한다고 등록한 언어만 받습니다.
 */
export function gameLang(listing, uiLang) {
  const full = fullLangs(listing);
  if (!full.length) return uiLang;
  return full.includes(uiLang) ? uiLang : full[0];
}

/**
 * 등록 정보 검사. 문제를 { code, field?, lang?, max? } 목록으로 돌려줍니다 (글자는 화면 쪽에서 번역).
 * 지원하지 않는 언어로 쓴 글은 문제로 보지 않고 normalizeListing()이 버립니다.
 *   languages.none        지원 언어를 하나도 고르지 않음
 *   languages.needFull    완전 번역 언어가 하나도 없음 (게임 안 글자를 쓸 언어가 필요)
 *   languages.invalid     모르는 언어나 지원 수준
 *   difficulty.invalid    난이도를 고르지 않음
 *   timer.invalid         타이머 모양이 틀림 (분은 1~180 또는 null, custom은 true/false)
 *   text.missing          지원 언어인데 이름/소개/룰북이 비어 있음
 *   text.tooLong          글자 수 초과 (빠른 규칙은 비워도 되지만 길이는 봅니다)
 *   demos.invalid         시연의 모양이 틀리거나 너무 많음
 */
export function validateListing(listing) {
  const problems = [];
  if (!listing || typeof listing !== 'object') return [{ code: 'languages.none' }];

  const langs = listing.languages;
  const entries = langs && typeof langs === 'object' ? Object.entries(langs) : [];
  if (entries.some(([l, s]) => !LANGS.includes(l) || !SUPPORTS.includes(s))) problems.push({ code: 'languages.invalid' });
  const supported = entries.filter(([l, s]) => LANGS.includes(l) && SUPPORTS.includes(s)).map(([l]) => l);
  if (!supported.length) problems.push({ code: 'languages.none' });
  else if (!entries.some(([, s]) => s === 'full')) problems.push({ code: 'languages.needFull' });

  if (!DIFFICULTIES.includes(listing.difficulty)) problems.push({ code: 'difficulty.invalid' });

  const timer = listing.timer;
  if (!timer || typeof timer !== 'object' || !validMinutes(timer.minutes) || typeof timer.custom !== 'boolean') {
    problems.push({ code: 'timer.invalid', ...TIMER_MINUTES });
  }

  for (const field of TEXT_FIELDS) {
    for (const lang of supported) {
      const v = listing[field]?.[lang];
      if (typeof v !== 'string' || !v.trim()) problems.push({ code: 'text.missing', field, lang });
      else if (v.length > LIMITS[field]) problems.push({ code: 'text.tooLong', field, lang, max: LIMITS[field] });
    }
  }
  for (const field of OPTIONAL_FIELDS) {
    for (const lang of supported) {
      const v = listing[field]?.[lang];
      if (typeof v === 'string' && v.length > LIMITS[field]) problems.push({ code: 'text.tooLong', field, lang, max: LIMITS[field] });
    }
  }
  const demos = listing.demos;
  if (demos !== undefined && demos !== null
    && (!Array.isArray(demos) || demos.length > DEMO_LIMITS.count || demos.some((d) => d !== null && !validDemo(d)))) {
    problems.push({ code: 'demos.invalid', max: DEMO_LIMITS.count });
  }
  return problems;
}

/** 저장할 모양으로 정리합니다: 지원하는 언어의 글만 남기고 앞뒤 공백을 지웁니다. 검사를 통과한 값에만 씁니다. */
export function normalizeListing(listing) {
  const languages = {};
  for (const l of LANGS) if (SUPPORTS.includes(listing.languages[l])) languages[l] = listing.languages[l];
  const out = { languages, difficulty: listing.difficulty, timer: { minutes: listing.timer.minutes, custom: listing.timer.custom } };
  for (const field of TEXT_FIELDS) {
    out[field] = {};
    for (const l of Object.keys(languages)) out[field][l] = listing[field][l].trim();
  }
  for (const field of OPTIONAL_FIELDS) {
    const kept = {};
    for (const l of Object.keys(languages)) {
      const v = listing[field]?.[l];
      if (typeof v === 'string' && v.trim()) kept[l] = v.trim();
    }
    if (Object.keys(kept).length) out[field] = kept;
  }
  // 시연: 뒤쪽의 빈 자리는 떼고, 하나도 없으면 칸을 두지 않습니다
  const demos = (listing.demos ?? []).map((d) => (d ? cleanDemo(d) : null));
  while (demos.length && !demos.at(-1)) demos.pop();
  if (demos.length) out.demos = demos;
  return out;
}
