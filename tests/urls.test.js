import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {safeXPostUrl} from '../src/shared/urls.js';

test('Grok post links only allow HTTPS links to X or Twitter', () => {
  assert.equal(safeXPostUrl('https://x.com/user/status/123'), 'https://x.com/user/status/123');
  assert.equal(safeXPostUrl('https://twitter.com/user/status/123'), 'https://twitter.com/user/status/123');
  for (const value of ['javascript:alert(1)', 'http://x.com/user', 'https://x.com.evil.test/user', 'https://evil.test/user', '']) {
    assert.equal(safeXPostUrl(value), '');
  }
});

test('profile list renders Grok text as text nodes rather than markup', () => {
  const panel = readFileSync(new URL('../src/entries/panel/panel.js', import.meta.url), 'utf8');
  assert.match(panel, /grokNote\.append\(grokLabel, document\.createTextNode/);
  assert.doesNotMatch(panel, /grokNote\.innerHTML\s*=/);
  assert.doesNotMatch(panel, /(?:statsBar|enqRow)\.innerHTML\s*=/);
});
