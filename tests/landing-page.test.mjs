import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('keeps signup as primary operator CTA', () => {
  assert.match(page, /href="\/dashboard\/\?signup=true"[^>]*>\s*(?:<[^>]+>[^<]*<\/[^>]+>\s*)*Start free/s);
});

test('keeps app downloads as secondary path', () => {
  assert.match(page, /href="#apps"[^>]*>\s*(?:<[^>]+>[^<]*<\/[^>]+>\s*)*Download apps/s);
});

test('includes responsive navigation and safeguards', () => {
  assert.match(page, /class="menu-toggle"/);
  assert.match(page, /:focus-visible/);
  assert.match(page, /prefers-reduced-motion: reduce/);
});
