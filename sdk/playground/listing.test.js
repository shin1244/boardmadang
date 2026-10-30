import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeListing, timerOf, validateListing } from './listing.js';

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
