// auth.js

// ── VERIFY USER TOKEN ─────────────────────────────────────────────────
// Called on every API request. Returns { uid, email } or throws.

// Cache verified tokens for 5 minutes (Firebase ID tokens are valid for 1 hour)
const _verifiedTokenCache = new Map(); // token -> { uid, email, exp }

export async function verifyFirebaseToken(env, idToken) {
    if (!idToken) throw new Error('No token provided');

    const now = Math.floor(Date.now() / 1000);

    // Return cached result if still valid
    const cached = _verifiedTokenCache.get(idToken);
    if (cached && now < cached.exp) return { uid: cached.uid, email: cached.email };

    const resp = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken })
        }
    );

    if (!resp.ok) throw new Error('Token verification failed');

    const data = await resp.json();
    const user = data.users?.[0];
    if (!user) throw new Error('User not found');

    const result = { uid: user.localId, email: user.email };

    // Cache for 5 min; evict stale entries to keep the Map small
    _verifiedTokenCache.set(idToken, { ...result, exp: now + 300 });
    if (_verifiedTokenCache.size > 50) {
        for (const [k, v] of _verifiedTokenCache) {
            if (now >= v.exp) _verifiedTokenCache.delete(k);
        }
    }

    return result;
}

// ── SERVICE ACCOUNT TOKEN ─────────────────────────────────────────────
// Used by the Worker to write user profiles and read tiers as admin.
// Cached for 50 minutes, auto-refreshes.

let _serviceToken = null;
let _serviceTokenExp = 0;

export async function getServiceToken(env) {
    const now = Math.floor(Date.now() / 1000);
    if (_serviceToken && now < _serviceTokenExp - 60) return _serviceToken;

    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iss: env.FIREBASE_CLIENT_EMAIL,
        sub: env.FIREBASE_CLIENT_EMAIL,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
        scope: 'https://www.googleapis.com/auth/datastore'
    };

    const enc = obj =>
        btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const signingInput = `${enc(header)}.${enc(payload)}`;

    const pemBody = env.FIREBASE_PRIVATE_KEY
        .replace(/\\n/g, '\n')  // ← ADD THIS LINE FIRST
        .replace(/-----BEGIN RSA PRIVATE KEY-----|-----BEGIN PRIVATE KEY-----/g, '')
        .replace(/-----END RSA PRIVATE KEY-----|-----END PRIVATE KEY-----/g, '')
        .replace(/\s/g, '');

    const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
        'pkcs8', keyBytes,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['sign']
    );

    const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)
    );
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signingInput}.${sigB64}`
    });

    const tokenData = await tokenResp.json();
    _serviceToken = tokenData.access_token;
    _serviceTokenExp = now + 3600;
    return _serviceToken;
}