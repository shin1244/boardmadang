import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeListing, quickRuleLines, timerOf, validDemo, validateListing } from './listing.js';

const base = () => ({
  languages: { ko: 'full' },
  difficulty: 'easy',
  timer: { minutes: 10, custom: true },
  name: { ko: '이름' },
  description: { ko: '소개' },
  rulebook: { ko: '룰북' },
});

const codes = (l) => validateListing(l).map((p) => p.code);

test('올바른 등록 정보는 문제 없음', () => {
  assert.deepEqual(codes(base()), []);
});

test('타이머 없음(null)도 됩니다', () => {
  assert.deepEqual(codes({ ...base(), timer: { minutes: null, custom: false } }), []);
});

test('타이머 범위와 모양 검사', () => {
  for (const timer of [undefined, null, { minutes: 0, custom: true }, { minutes: 181, custom: true },
    { minutes: 2.5, custom: true }, { minutes: '10', custom: true }, { minutes: 10 }]) {
    assert.deepEqual(codes({ ...base(), timer }), ['timer.invalid'], JSON.stringify(timer));
  }
});

test('저장할 때 타이머도 남깁니다', () => {
  assert.deepEqual(normalizeListing({ ...base(), timer: { minutes: 5, custom: false, extra: 1 } }).timer, { minutes: 5, custom: false });
});

test('예전 등록 정보(timer 없음)는 타이머 없음으로 봅니다', () => {
  assert.deepEqual(timerOf({}), { minutes: null, custom: false });
  assert.deepEqual(timerOf(null), { minutes: null, custom: false });
});

test('빠른 규칙은 비워도 되고, 쓴 언어만 저장합니다', () => {
  assert.deepEqual(codes({ ...base(), quickRules: { ko: '' } }), []);
  assert.equal('quickRules' in normalizeListing({ ...base(), quickRules: { ko: '  ' } }), false);
  assert.deepEqual(normalizeListing({ ...base(), quickRules: { ko: ' 한 줄\n두 줄 ', en: 'dropped' } }).quickRules, { ko: '한 줄\n두 줄' });
  assert.deepEqual(validateListing({ ...base(), quickRules: { ko: 'x'.repeat(501) } }),
    [{ code: 'text.tooLong', field: 'quickRules', lang: 'ko', max: 500 }]);
});

test('빠른 규칙의 항목: 빈 줄과 목록 기호를 뺍니다', () => {
  assert.deepEqual(quickRuleLines('- 하나\r\n\n2. 둘\n • 셋\n넷-다섯'), ['하나', '둘', '셋', '넷-다섯']);
  assert.deepEqual(quickRuleLines(undefined), []);
});

test('시연: 모양을 보고, 저장할 때 아는 칸만 남기고 뒤쪽 빈 자리를 뗍니다', () => {
  const move = (player, row) => ({ player, action: { kind: 'click', row, col: 1, extra: 1 } });
  const demo = { seed: 7, moves: [move(0, 0), move(1, 2), { player: 0, action: { kind: 'pass', row: 0, col: 0 } }], from: 1, view: 1, extra: 1 };
  assert.equal(validDemo(demo), true);
  assert.deepEqual(codes({ ...base(), demos: [null, demo, null] }), []);
  assert.deepEqual(normalizeListing({ ...base(), demos: [null, demo, null] }).demos, [null, {
    seed: 7,
    moves: [{ player: 0, action: { kind: 'click', row: 0, col: 1 } }, { player: 1, action: { kind: 'click', row: 2, col: 1 } }, { player: 0, action: { kind: 'pass' } }],
    from: 1,
    view: 1,
  }]);
  assert.equal('demos' in normalizeListing({ ...base(), demos: [null, null] }), false);
  assert.equal('demos' in normalizeListing(base()), false);

  const bad = [
    {}, 'gif', [{ ...demo, moves: [] }], [{ ...demo, from: 3 }], [{ ...demo, view: 2 }], [{ ...demo, seed: 1.5 }],
    [{ ...demo, moves: [move(0, 32)] , from: 0 }], [{ ...demo, moves: [move(2, 0)], from: 0 }],
    [{ ...demo, moves: Array.from({ length: 31 }, () => move(0, 0)), from: 0 }],
    [null, null, null, null, null, null, demo],
  ];
  for (const demos of bad) assert.deepEqual(codes({ ...base(), demos }), ['demos.invalid'], JSON.stringify(demos).slice(0, 80));
});
