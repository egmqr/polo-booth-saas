import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagePhotoTaskQueue } from '../dashboard/manage-photo-task-queue.mjs';

test('runs queued tasks in order and continues after failure', async () => {
  const order = [];
  const queue = new ManagePhotoTaskQueue({ onChange() {} });
  const first = queue.enqueue({ label: 'Upload', total: 1, run: async () => { throw new Error('failed'); } });
  const second = queue.enqueue({ label: 'Delete', total: 1, run: async () => { order.push('delete'); } });
  await assert.rejects(first, /failed/);
  await second;
  assert.deepEqual(order, ['delete']);
});
