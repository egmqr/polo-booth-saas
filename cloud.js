// cloud.js - Single Source of Truth for Firebase, R2, and KV

// ── FIREBASE FIRESTORE ──────────────────────────────────────────────────
let _fbToken = null;
let _fbTokenExp = 0;

export const Firebase = {
    async getToken(env) {
        const now = Date.now();
        if (_fbToken && now < _fbTokenExp) return _fbToken;

        const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${env.FIREBASE_API_KEY}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: env.FIREBASE_EMAIL, password: env.FIREBASE_PASSWORD, returnSecureToken: true })
        });

        if (!res.ok) throw new Error('Firebase auth failed: ' + await res.text());
        const body = await res.json();
        _fbToken = body.idToken;
        _fbTokenExp = now + 50 * 60 * 1000; // Cache token for 50 minutes
        return _fbToken;
    },

    async fetch(env, pathOrUrl, init = {}) {
        const token = await this.getToken(env);
        const url = pathOrUrl.startsWith('http')
            ? pathOrUrl
            : `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents${pathOrUrl}`;

        const headers = { ...(init.headers || {}), authorization: `Bearer ${token}` };
        if (init.body && !headers['content-type']) headers['content-type'] = 'application/json';
        return fetch(url, { ...init, headers });
    }
};

// ── CLOUDFLARE R2 (STORAGE) ─────────────────────────────────────────────
export const Storage = {
    async put(env, key, data, options) { return await env.PHOTOS.put(key, data, options); },
    async get(env, key) { return await env.PHOTOS.get(key); },
    async delete(env, keys) { return await env.PHOTOS.delete(keys); },
    async list(env, options) { return await env.PHOTOS.list(options); },

    // AWS SigV4 Presigning Logic for R2 direct uploads
    async presignPut(env, key, expiresSec = 900) {
        const region = 'auto'; const service = 's3';
        const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
        const bucket = env.BUCKET_NAME;
        const encodedKey = key.split('/').map(encodeURIComponent).join('/');

        const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
        const dateStamp = amzDate.slice(0, 8);
        const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

        const params = new URLSearchParams({
            'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
            'X-Amz-Credential': `${env.R2_ACCESS_KEY_ID}/${credentialScope}`,
            'X-Amz-Date': amzDate,
            'X-Amz-Expires': String(expiresSec),
            'X-Amz-SignedHeaders': 'host'
        });

        const canonicalQuery = [...params.keys()].sort().map(k => `${k}=${encodeURIComponent(params.get(k))}`).join('&');
        const canonicalRequest = ['PUT', `/${bucket}/${encodedKey}`, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
        const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256Hex(canonicalRequest)].join('\n');

        const kDate = await hmac(`AWS4${env.R2_SECRET_ACCESS_KEY}`, dateStamp);
        const kRegion = await hmac(kDate, region);
        const kService = await hmac(kRegion, service);
        const kSigning = await hmac(kService, 'aws4_request');
        const signature = hex(await hmac(kSigning, stringToSign));

        return `https://${host}/${bucket}/${encodedKey}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    }
};

// ── CLOUDFLARE KV (SESSIONS) ────────────────────────────────────────────
export const Sessions = {
    async get(env, key) { return await env.SESSIONS.get(key); },
    async put(env, key, val) { return await env.SESSIONS.put(key, val); },
    async delete(env, key) { return await env.SESSIONS.delete(key); },
    async list(env, options) { return await env.SESSIONS.list(options); }
};

// ── Internal Crypto Helpers for R2 Presigning ──
async function hmac(key, msg) {
    const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? new TextEncoder().encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)));
}
async function sha256Hex(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }