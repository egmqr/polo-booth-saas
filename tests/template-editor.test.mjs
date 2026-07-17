import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editor = await readFile(new URL('../template-editor.html', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');

test('adds in-canvas layer and rotation controls for selected elements', () => {
  for (const id of ['canvasLayerBack', 'canvasLayerForward', 'canvasRotateLeft', 'canvasRotateRight']) {
    assert.match(editor, new RegExp(`id="${id}"`));
  }
  assert.match(editor, /function moveSelectedLayer\(/);
  assert.match(editor, /function rotateSelectedLayer\(/);
});

test('leaves room for the event selector arrow', () => {
  assert.match(dashboard, /#eventSelect \{[^}]*padding-right: 42px;/);
});
