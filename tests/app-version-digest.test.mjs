import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { handleAdminRoutes, handleAppVersionsPublic } from '../admin.js';

const WINDOWS_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0xff, 0x7f]);
const WINDOWS_SHA256 = createHash('sha256').update(WINDOWS_BYTES).digest('hex');
const EXISTING_WINDOWS_SHA256 = 'a'.repeat(64);
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });

function environment(put) {
    return {
        ADMIN_SECRET: 'admin-secret',
        FIREBASE_PROJECT_ID: 'test-project',
        FIREBASE_CLIENT_EMAIL: 'service@example.com',
        FIREBASE_PRIVATE_KEY: PRIVATE_KEY,
        PUBLIC_CDN_BASE: 'https://cdn.example.com',
        PHOTOS: { put }
    };
}

async function withFetch(handler, run) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = handler;
    try {
        return await run();
    } finally {
        globalThis.fetch = originalFetch;
    }
}

test('Windows upload returns and persists SHA-256 of uploaded bytes', async () => {
    let uploadedBytes;
    let patchedFields;
    const form = new FormData();
    form.set('appType', 'windows');
    form.set('windowsVersion', '2.5.0');
    form.set('file', new File([WINDOWS_BYTES], 'PoloPro.exe', { type: 'application/octet-stream' }));

    const response = await withFetch(async (url, options = {}) => {
        const address = String(url);
        if (address.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'service-token' });
        if (options.method === 'PATCH') {
            patchedFields = JSON.parse(options.body).fields;
            return Response.json({ fields: patchedFields });
        }
        if (address.includes('/documents/app_settings/downloads')) return new Response(null, { status: 404 });
        throw new Error(`Unexpected fetch: ${address}`);
    }, () => handleAdminRoutes(new Request('https://worker.example/api/admin/upload-app', {
        method: 'POST',
        headers: { 'x-admin-secret': 'admin-secret' },
        body: form
    }), environment(async (_key, bytes) => {
        uploadedBytes = new Uint8Array(bytes);
    })));

    const body = await response.json();
    assert.equal(body.appVersions.windows.sha256, WINDOWS_SHA256);
    assert.equal(patchedFields.windowsSha256.stringValue, WINDOWS_SHA256);
    assert.deepEqual(uploadedBytes, WINDOWS_BYTES);
});

test('legacy app-version record returns empty Windows digest', async () => {
    const response = await withFetch(async url => {
        const address = String(url);
        if (address.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'service-token' });
        if (address.includes('/documents/app_settings/downloads')) {
            return Response.json({ fields: { windowsVersion: { stringValue: '1.0.0' } } });
        }
        throw new Error(`Unexpected fetch: ${address}`);
    }, () => handleAppVersionsPublic(new Request('https://worker.example/api/app-versions'), environment()));

    const { appVersions } = await response.json();
    assert.equal(appVersions.windows.sha256, '');
    assert.equal(appVersions.proboothWindows.sha256, '');
});

test('settings save preserves stored Windows digest and ignores payload digest', async () => {
    let patchedFields;
    const response = await withFetch(async (url, options = {}) => {
        const address = String(url);
        if (address.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'service-token' });
        if (options.method === 'PATCH') {
            patchedFields = JSON.parse(options.body).fields;
            return Response.json({ fields: patchedFields });
        }
        if (address.includes('/documents/app_settings/downloads')) {
            return Response.json({ fields: { windowsSha256: { stringValue: EXISTING_WINDOWS_SHA256 } } });
        }
        throw new Error(`Unexpected fetch: ${address}`);
    }, () => handleAdminRoutes(new Request('https://worker.example/api/admin/app-versions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-admin-secret': 'admin-secret' },
        body: JSON.stringify({ windowsVersion: '2.5.0', windowsSha256: 'b'.repeat(64) })
    }), environment()));

    assert.equal((await response.json()).appVersions.windows.sha256, EXISTING_WINDOWS_SHA256);
    assert.equal(patchedFields.windowsSha256.stringValue, EXISTING_WINDOWS_SHA256);
});

test('Android upload preserves stored Windows digest', async () => {
    let patchedFields;
    const form = new FormData();
    form.set('appType', 'android');
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'PoloPro-1.0.4-release.apk'));

    const response = await withFetch(async (url, options = {}) => {
        const address = String(url);
        if (address.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'service-token' });
        if (options.method === 'PATCH') {
            patchedFields = JSON.parse(options.body).fields;
            return Response.json({ fields: patchedFields });
        }
        if (address.includes('/documents/app_settings/downloads')) {
            return Response.json({ fields: { windowsSha256: { stringValue: EXISTING_WINDOWS_SHA256 } } });
        }
        throw new Error(`Unexpected fetch: ${address}`);
    }, () => handleAdminRoutes(new Request('https://worker.example/api/admin/upload-app', {
        method: 'POST',
        headers: { 'x-admin-secret': 'admin-secret' },
        body: form
    }), environment(async () => {})));

    assert.equal((await response.json()).appVersions.windows.sha256, EXISTING_WINDOWS_SHA256);
    assert.equal(patchedFields.windowsSha256.stringValue, EXISTING_WINDOWS_SHA256);
});

test('ProBooth Windows upload stores its own release and digest', async () => {
    let patchedFields;
    let uploadedBytes;
    const form = new FormData();
    form.set('appType', 'probooth-windows');
    form.set('proboothWindowsVersion', '3.2.1.0');
    form.set('file', new File([WINDOWS_BYTES], 'ProBooth.exe'));

    const response = await withFetch(async (url, options = {}) => {
        const address = String(url);
        if (address.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'service-token' });
        if (options.method === 'PATCH') {
            patchedFields = JSON.parse(options.body).fields;
            return Response.json({ fields: patchedFields });
        }
        if (address.includes('/documents/app_settings/downloads')) return new Response(null, { status: 404 });
        throw new Error(`Unexpected fetch: ${address}`);
    }, () => handleAdminRoutes(new Request('https://worker.example/api/admin/upload-app', {
        method: 'POST',
        headers: { 'x-admin-secret': 'admin-secret' },
        body: form
    }), environment(async (_key, bytes) => {
        uploadedBytes = new Uint8Array(bytes);
    })));

    const body = await response.json();
    assert.equal(body.key, 'ProBooth.exe');
    assert.equal(body.appVersions.proboothWindows.version, '3.2.1.0');
    assert.equal(body.appVersions.proboothWindows.sha256, WINDOWS_SHA256);
    assert.equal(patchedFields.proboothWindowsSha256.stringValue, WINDOWS_SHA256);
    assert.deepEqual(uploadedBytes, WINDOWS_BYTES);
});

test('ProBooth upload preserves PoloPro Windows digest', async () => {
    let patchedFields;
    const form = new FormData();
    form.set('appType', 'probooth-windows');
    form.set('file', new File([WINDOWS_BYTES], 'ProBooth.exe'));

    await withFetch(async (url, options = {}) => {
        const address = String(url);
        if (address.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'service-token' });
        if (options.method === 'PATCH') {
            patchedFields = JSON.parse(options.body).fields;
            return Response.json({ fields: patchedFields });
        }
        if (address.includes('/documents/app_settings/downloads')) {
            return Response.json({ fields: { windowsSha256: { stringValue: EXISTING_WINDOWS_SHA256 } } });
        }
        throw new Error(`Unexpected fetch: ${address}`);
    }, () => handleAdminRoutes(new Request('https://worker.example/api/admin/upload-app', {
        method: 'POST',
        headers: { 'x-admin-secret': 'admin-secret' },
        body: form
    }), environment(async () => {})));

    assert.equal(patchedFields.windowsSha256.stringValue, EXISTING_WINDOWS_SHA256);
});

test('ProBooth Windows upload rejects unnamed executable files', async () => {
    const form = new Map([
        ['appType', 'probooth-windows'],
        ['file', { name: '', arrayBuffer: async () => WINDOWS_BYTES.buffer }]
    ]);

    const response = await withFetch(async (url, options = {}) => {
        const address = String(url);
        if (address.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'service-token' });
        if (options.method === 'PATCH') return Response.json({ fields: {} });
        if (address.includes('/documents/app_settings/downloads')) return new Response(null, { status: 404 });
        throw new Error(`Unexpected fetch: ${address}`);
    }, () => handleAdminRoutes({
        url: 'https://worker.example/api/admin/upload-app',
        method: 'POST',
        headers: new Headers({ 'x-admin-secret': 'admin-secret' }),
        formData: async () => form
    }, environment(async () => {})));

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'Upload a .exe file for probooth-windows.');
});
