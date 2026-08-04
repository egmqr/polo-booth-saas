import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSignedUpload } from '../dashboard.js';

const key = 'users/user-1/events/event-1/photo.jpg';
const body = { prefix: 'users/user-1/events/event-1', filename: 'photo.jpg' };

function envWithTombstone(tombstoneKey) {
    const tombstones = new Map([[`deleted:${tombstoneKey}`, '1']]);
    const deletedTombstones = [];

    return {
        R2_ACCOUNT_ID: 'account-id',
        BUCKET_NAME: 'test-bucket',
        R2_ACCESS_KEY_ID: 'access-key',
        R2_SECRET_ACCESS_KEY: 'secret-key',
        PUBLIC_CDN_BASE: 'https://cdn.example.com',
        SESSIONS: {
            async get(keyToGet) { return tombstones.get(keyToGet) ?? null; },
            async delete(keyToDelete) {
                deletedTombstones.push(keyToDelete);
                tombstones.delete(keyToDelete);
            }
        },
        deletedTombstones
    };
}

test('signed upload keeps dashboard-deleted photo rejected by default', async () => {
    const env = envWithTombstone(key);

    assert.deepEqual(await handleSignedUpload(env, body, { uid: 'user-1' }), {
        error: 'This photo was deleted from the dashboard and will not be re-uploaded automatically.'
    });
    assert.deepEqual(env.deletedTombstones, []);
});

test('signed upload restores tombstoned photo only when explicitly requested', async () => {
    const env = envWithTombstone(key);

    const restored = await handleSignedUpload(env, { ...body, restoreDeleted: true }, { uid: 'user-1' });

    assert.equal(restored.key, key);
    assert.equal(await env.SESSIONS.get(`deleted:${key}`), '1');
    assert.deepEqual(env.deletedTombstones, []);
});

test('signed upload cannot restore another user tombstone', async () => {
    const env = envWithTombstone(key);

    const crossUser = await handleSignedUpload(env, {
        ...body,
        prefix: 'users/user-2/events/event-1',
        restoreDeleted: true
    }, { uid: 'user-1' });

    assert.equal(crossUser.error, 'Prefix must be within your user namespace');
    assert.deepEqual(env.deletedTombstones, []);
});
