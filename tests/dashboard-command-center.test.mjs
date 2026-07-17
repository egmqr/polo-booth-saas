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
