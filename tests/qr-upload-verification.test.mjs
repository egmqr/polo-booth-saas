import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import worker from '../index.js';
import { handleQRRoutes } from '../qr.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

function userStorage() {
  return {
    async get(key) { return key === 'users/user-1/events/e/prints/p.jpg' ? {} : null; },
    async list() { return { objects: [], truncated: false }; }
  };
}

function verifiedUserRequest(body) {
  return new Request('https://worker.example/api/verify-upload', {
    method: 'POST',
    headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function workerFetch(request) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url).includes('accounts:lookup')) {
      return Response.json({ users: [{ localId: 'user-1', email: 'user@example.com' }] });
    }
    if (String(url).includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'service-token' });
    if (String(url).includes('/documents/users/user-1')) return new Response(null, { status: 404 });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    return await worker.fetch(request, {
      PHOTOS: userStorage(),
      FIREBASE_API_KEY: 'test-key',
      FIREBASE_CLIENT_EMAIL: 'service@example.com',
      FIREBASE_PRIVATE_KEY: privateKeyPem
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function photoRequest(id) {
  return new Request(`https://worker.example/api/photo?prefix=users%2Fuser-1%2Fevents%2Fe%2Fprints&id=${id}`);
}

function pagedUserStorage() {
  const firstPage = Array.from({ length: 200 }, (_, index) => ({
    key: `users/user-1/events/e/prints/archive/p${String(index + 1).padStart(4, '0')}.jpg`
  }));
  const secondPage = [{ key: 'users/user-1/events/e/prints/p0201.jpg' }];
  return {
    async list(_options) {
      return _options.cursor
        ? { objects: secondPage, truncated: false }
        : { objects: firstPage, truncated: true, cursor: 'next-page' };
    }
  };
}

test('verify upload rejects another user key', async () => {
  const response = await workerFetch(verifiedUserRequest({ key: 'users/other/events/e/prints/p.jpg' }));

  assert.equal(response.status, 403);
});

test('photo QR finds second-page object', async () => {
  const response = await handleQRRoutes(photoRequest('p0201'), {
    PHOTOS: pagedUserStorage(),
    PUBLIC_CDN_BASE: 'https://cdn.example.com'
  });

  assert.equal((await response.json()).status, 'success');
});
