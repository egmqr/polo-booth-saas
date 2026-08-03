import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTimeline, timelineForObject } from '../timeline.js';

test('late old upload keeps its original capture order', () => {
  const oldLate = { key: 'events/e/prints/c-1000-p1-photo-s1.jpg', uploaded: new Date(9000) };
  const newEarly = { key: 'events/e/prints/c-2000-p2-photo-s2.jpg', uploaded: new Date(3000) };

  assert.deepEqual([newEarly, oldLate].sort(compareTimeline), [oldLate, newEarly]);
  assert.equal(timelineForObject(oldLate).time, 1000);
});

test('same capture millisecond has stable key ordering', () => {
  const b = { key: 'events/e/c-1000-p2-photo.jpg', uploaded: new Date(10) };
  const a = { key: 'events/e/c-1000-p1-photo.jpg', uploaded: new Date(20) };

  assert.deepEqual([b, a].sort(compareTimeline), [a, b]);
});

test('legacy object falls back to its upload time', () => {
  const legacy = { key: 'events/e/old.jpg', uploaded: new Date(1234) };

  assert.deepEqual(timelineForObject(legacy), { time: 1234, id: legacy.key });
});
