import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');

test('exposes command-center work zones without removing critical controls', () => {
  for (const zone of ['Event Setup', 'Booth', 'Sharing', 'Gallery']) {
    assert.match(page, new RegExp(`data-work-zone="${zone}"`));
  }
  for (const id of ['eventSelect', 'eventName', 'eventId', 'manageModal', 'dashboardWindowsDownload', 'dashboardAndroidDownload']) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
});

test('includes dashboard accessibility and responsive safeguards', () => {
  assert.match(page, /:focus-visible/);
  assert.match(page, /prefers-reduced-motion: reduce/);
  assert.match(page, /command-center/);
});

test('uses restrained section styling instead of stacked card borders', () => {
  assert.match(page, /\.work-zone-card \{[^}]*border: 0;/);
  assert.match(page, /\.command-header \{[^}]*border: 0;/);
});

test('uses one event workspace instead of visible setup modes', () => {
  assert.match(page, />\s*New event\s*</);
  assert.match(page, />\s*Configure\s*</);
  assert.match(page, />\s*Share live\s*</);
  assert.doesNotMatch(page, />\s*New Setup\s*<\/button>/);
  assert.doesNotMatch(page, />\s*Edit Setup\s*<\/button>/);
  assert.doesNotMatch(page, />\s*View Setup\s*<\/button>/);
});

test('renders Share live when an existing event opens', () => {
  assert.match(page, /if \(currentMode === 'view' \|\| currentMode === 'edit'\)/);
  assert.doesNotMatch(page, /else if \(currentMode === 'view' \|\| currentMode === 'edit'\)/);
});
