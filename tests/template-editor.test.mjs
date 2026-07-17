import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editor = await readFile(new URL('../template-editor.html', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');

test('uses a snapped rotation puller without duplicate corner layer buttons', () => {
  assert.match(editor, /id="canvasRotationHandle"/);
  assert.match(editor, /Math\.abs\(rawRotation - snappedRotation\) <= 5/);
  assert.match(editor, /function handleRotationStart\(/);
  assert.doesNotMatch(editor, /id="canvasLayerBack"/);
  assert.doesNotMatch(editor, /id="canvasLayerForward"/);
  assert.doesNotMatch(editor, /id="sldRotation"/);
});

test('supports undo history and dragging layers to reorder', () => {
  assert.match(editor, /id="undoBtn"/);
  assert.match(editor, /function recordUndo\(/);
  assert.match(editor, /function undo\(/);
  assert.match(editor, /div\.draggable = true;/);
  assert.match(editor, /div\.addEventListener\('drop'/);
});

test('keeps layer actions inline and inherits dashboard theme', () => {
  assert.match(editor, /Drag a layer to reorder/);
  assert.match(editor, /\.layer-item\.drag-over/);
  assert.match(editor, /function toggleLayerLock\(/);
  assert.match(editor, /function deleteLayerById\(/);
  assert.match(editor, /window\.opener\.document\.body\.classList\.contains\('dark-mode'\)/);
  assert.doesNotMatch(editor, /dm-toggle/);
});

test('uses an exact fill action and accurate layer drop cues', () => {
  assert.match(editor, /class="btn btn-secondary btn-icon" id="undoBtn"/);
  assert.match(editor, /layer\.Width = templateState\.CanvasWidth;\s*layer\.Height = templateState\.CanvasHeight;/);
  assert.match(editor, /drag-over-before/);
  assert.match(editor, /drag-over-after/);
  assert.match(editor, /const insertionIndex = dropAfter \? targetIndex \+ 1 : targetIndex;/);
});

test('leaves room for the event selector arrow', () => {
  assert.match(dashboard, /#eventSelect \{[^}]*appearance: none;/);
  assert.match(dashboard, /#eventSelect \{[^}]*background-position: right 16px center;/);
  assert.match(dashboard, /#eventSelect \{[^}]*padding-right: 42px;/);
});
