import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('system settings and its mask appear above the queue settings drawer', () => {
  const settings = readFileSync(new URL('../src/entries/panel/components/SystemSettingsDialog.vue', import.meta.url), 'utf8');
  const queue = readFileSync(new URL('../src/entries/panel/styles/follow-queue-panel.css', import.meta.url), 'utf8');
  const layer = (source, selector) => {
    const rule = source.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `missing ${selector} rule`);
    const z = rule[1].match(/z-index\s*:\s*(\d+)/);
    assert.ok(z, `missing ${selector} layer`);
    return Number(z[1]);
  };
  const queueLayer = layer(queue, '\\.fq-drawer-backdrop');
  const maskLayer = layer(settings, '\\.system-settings-mask');
  const dialogLayer = layer(settings, '\\.system-settings');
  assert.ok(queueLayer < maskLayer && maskLayer < dialogLayer);
});
