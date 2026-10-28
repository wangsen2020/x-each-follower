import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('followback header text-button padding excludes shared icon buttons', () => {
  const css = readFileSync(new URL('../src/entries/panel/styles/brand-layout.css', import.meta.url), 'utf8');
  const textButtonRule = css.match(/#unreciprocatedSection\s+\.unreciprocated-head\s+button([^{}]*)\{([^{}]*padding:\s*0\s+10px[^{}]*)\}/);
  assert.ok(textButtonRule, 'text-button padding rule must be present');
  assert.match(textButtonRule[1], /:not\(\.panel-icon-button\)/);
});

test('sidebar system settings button and its icon cannot shrink', () => {
  const component = readFileSync(new URL('../src/entries/panel/components/SystemSettingsDialog.vue', import.meta.url), 'utf8');
  assert.match(component, /\.local-data-entry\{[^}]*flex:0 0 30px;[^}]*min-width:30px/);
  assert.match(component, /\.local-data-entry>svg\{[^}]*flex:0 0 20px/);
});
