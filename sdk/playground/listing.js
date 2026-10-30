// 등록 정보 (listing): 게임 이름, 소개, 룰북, 난이도, 지원 언어, 타이머.
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

export const LIMITS = { name: 40, description: 200, rulebook: 20000 };

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
 *   text.tooLong          글자 수 초과
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
  return out;
}
