import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCount, normalizeHandle, assess, csv} from '../scoring.js';

test('parse public profile count formats without turning missing values into zero', () => {
  for (const [text, expected] of [['1,234 Followers',1234],['1.2K Followers',1200],['2.5M',2500000],['1.3万 位关注者',13000],['2萬',20000],['1\u202f234 Followers',1234],['0 Following',0],['Followers',null],['',null]]) assert.equal(parseCount(text),expected,text);
});
test('accept handles and supported profile URLs, reject path injection', () => {
  assert.equal(normalizeHandle('https://x.com/alice_1/'),'alice_1');
  assert.equal(normalizeHandle('@alice'),'alice');
  for (const value of ['foo/following','https://evil.com/foo','foo?x=1','']) assert.throws(() => normalizeHandle(value));
});
const options = {minRatio:0.7,maxRatio:1.4,minCount:50,requirePromise:true};
const base = {name:'Alice',bio:'互关，欢迎交流',followers:100,following:110,status:'ok'};
test('candidate requires readable counts, sufficient population and optional promise', () => {
  assert.equal(assess(base, options).verdict,'候选');
  assert.equal(assess({...base,followers:10000}, options).verdict,'承诺与比例不符');
  assert.equal(assess({...base,followers:null}, options).verdict,'需复核');
  assert.equal(assess({...base,following:0}, options).verdict,'需复核');
  assert.equal(assess({...base,status:'unreadable'}, options).verdict,'需复核');
  assert.equal(assess({...base,followers:10,following:10}, options).verdict,'未命中');
  assert.equal(assess({...base,bio:'hello'}, options).verdict,'未命中');
  assert.equal(assess({...base,bio:'hello'}, {...options,requirePromise:false}).verdict,'候选');
  assert.equal(assess({...base,bio:'I follow back'}, options).promise,true);
});
test('CSV quotes untrusted profile data and neutralizes spreadsheet formulas', () => {
  const output = csv([{handle:'alice',name:'=CMD()',bio:'text,"quoted"\nnext'}]);
  assert.ok(output.includes('"\'=CMD()"'));
  assert.ok(output.includes('"text,""quoted""\nnext"'));
});
