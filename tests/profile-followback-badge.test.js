import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../src/entries/content/profile-followback-badge.js', import.meta.url), 'utf8'), context);
const {profileHandle, countFromText, assess, describe} = context.__xefProfileFollowbackBadge;

test('profile route excludes posts, system routes and unrelated lists', () => {
  assert.equal(profileHandle('/lngw110835'), 'lngw110835');
  assert.equal(profileHandle('/SomeUser/with_replies'), 'SomeUser');
  for (const path of ['/home', '/search', '/notifications', '/i/grok', '/user/status/123', '/user/lists', '/user/unknown']) assert.equal(profileHandle(path), null, path);
});
test('reads zero, comma counts, English and Chinese compact numbers without guessing missing data', () => {
  for (const [text, count] of [['7,404 正在关注', 7404], ['4,050 关注者', 4050], ['0 Following', 0], ['1.2K Followers', 1200], ['2.3万 位关注者', 23000], ['1.2萬 跟隨者', 12000], ['12 Followers', 12]]) assert.equal(countFromText(text), count, text);
  for (const text of ['', '关注者', '--', '未知', null]) assert.equal(countFromText(text), null);
});
test('risk changes exactly at agreed ratio boundaries, high ratios are not the safest tier', () => {
  for (const [following, expected] of [[0, 'high'], [199, 'high'], [200, 'elevated'], [499, 'elevated'], [500, 'medium'], [799, 'medium'], [800, 'lower'], [1199, 'lower'], [1200, 'observe']]) assert.equal(assess(following, 1000).level, expected);
  const actual = assess(7404, 4050);
  assert.equal(actual.level, 'observe');
  assert.equal((actual.ratio * 100).toFixed(1), '182.8');
});
test('missing and zero denominators are unknown, not high-risk accounts', () => {
  for (const [following, followers] of [[null, 20], [1, null], [10, 0], [-1, 10], [Infinity, 10], [10, NaN]]) assert.equal(assess(following, followers).level, 'unknown');
});
test('hover explains counts, uncertainty and limits without a personal probability claim', () => {
  const text = describe(assess(1200, 1000), 1200, 1000, '1.2K Following', '1K Followers');
  assert.match(text, /120\.0%/);
  assert.match(text, /近似值/);
  assert.match(text, /单账号858人/);
  assert.match(text, /不是全平台结论或个人回关概率/);
  assert.match(text, /不代表对方是否已回关/);
});
