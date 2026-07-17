import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');

test('preserves critical operator controls', () => {
  for (const id of ['eventSelect', 'eventName', 'eventId', 'boothCount', 'boothTemplateList', 'pageTitle', 'boothList', 'manageModal', 'dashboardWindowsDownload', 'dashboardAndroidDownload']) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
});

test('includes dashboard accessibility and responsive safeguards', () => {
  assert.match(page, /:focus-visible/);
  assert.match(page, /prefers-reduced-motion: reduce/);
  assert.match(page, /command-center/);
});

test('uses restrained section styling', () => {
  assert.match(page, /\.dashboard-segment \{[^}]*border-top: 1px solid var\(--border\);/);
  assert.match(page, /#editFormFields \{ display: grid; gap: 0;/);
});

test('groups the workspace into Event, Web Gallery, and Manage', () => {
  for (const segment of ['Event', 'Web Gallery', 'Manage']) {
    assert.match(page, new RegExp(`data-dashboard-segment="${segment}"`));
  }
  assert.doesNotMatch(page, /class="work-zone-rail"/);
});

test('uses one event workspace instead of visible setup modes', () => {
  assert.match(page, />\s*New event\s*</);
  assert.doesNotMatch(page, />\s*New Setup\s*<\/button>/);
  assert.doesNotMatch(page, />\s*Edit Setup\s*<\/button>/);
  assert.doesNotMatch(page, />\s*View Setup\s*<\/button>/);
});

test('renders Share live when an existing event opens', () => {
  assert.match(page, /if \(currentMode === 'view' \|\| currentMode === 'edit'\)/);
  assert.doesNotMatch(page, /else if \(currentMode === 'view' \|\| currentMode === 'edit'\)/);
});
