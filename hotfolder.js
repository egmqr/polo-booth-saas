import { Storage } from './cloud.js';
import { json } from './util.js';
import { verifyFirebaseToken, getServiceToken } from './auth.js';

export async function handleHotfolder(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // All hotfolder routes require Firebase auth
    const rawToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
    let currentUser;
    try { currentUser = await verifyFirebaseToken(env, rawToken); }
    catch (e) { return json({ error: 'Unauthorized' }, 401); }

    const access = await getHotfolderUserAccess(env, currentUser.uid);
    if (!access.ok) {
        return json({ success: false, error: access.reason || 'This account is not currently active.' }, 403);
    }

    const client = normalizeHotfolderClient(url.searchParams.get('client') || request.headers.get('x-hotfolder-client') || 'v3');
    const userHotfolderPrefix = `users/${currentUser.uid}/hotfolder/${client}/`;
    const fallbackHotfolderPrefix = `hotfolder/${client}/`;

    // POST /api/hotfolder/push — Dashboard or ProBooth pushes a config JSON
    if (path === '/api/hotfolder/push' && request.method === 'POST') {
        const { key, content, client: bodyClient } = await request.json();
        const keys = await putHotfolderTargets(env, currentUser.uid, key, content, hotfolderTargets(bodyClient || url.searchParams.get('target') || 'all'));
        return json({ success: true, key: keys[0], keys });
    }

    // DELETE /api/hotfolder/ack — ProBooth acknowledges it has received the config
    if (path === '/api/hotfolder/ack' && request.method === 'DELETE') {
        const { key } = await request.json();
        const cleanKey = cleanHotfolderKey(key);
        const safeKey = `${userHotfolderPrefix}${cleanKey}`;
        if (!safeKey.startsWith(userHotfolderPrefix)) {
            return json({ success: false, error: 'Invalid hotfolder key' }, 400);
        }
        if (client === 'android') {
            return json({ success: true, retained: true });
        }
        await Storage.delete(env, safeKey);
        return json({ success: true });
    }

    // GET /api/hotfolder — ProBooth pulls pending configs on startup
    if (request.method === 'GET') {
        const files = [];
        for (const prefix of [userHotfolderPrefix, fallbackHotfolderPrefix]) {
            const list = await Storage.list(env, { prefix, limit: 200 });
            for (const obj of list.objects) {
                if (!obj.key.endsWith('.json')) continue;
                try {
                    const r2obj = await Storage.get(env, obj.key);
                    if (r2obj) {
                        files.push({
                            name: obj.key.replace(prefix, ''),
                            content: await r2obj.text(),
                            hotfolderKey: obj.key
                        });
                    }
                } catch { }
            }
        }
        return json(files);
    }

    return json({ error: 'Method not allowed' }, 405);
}

function normalizeHotfolderClient(value) {
    const raw = String(value || '').toLowerCase();
    return raw === 'android' ? 'android' : 'v3';
}

function hotfolderTargets(value) {
    const raw = String(value || '').toLowerCase();
    if (raw === 'android') return ['android'];
    if (raw === 'v3') return ['v3'];
    return ['v3', 'android'];
}

function cleanHotfolderKey(key = '') {
    return String(key)
        .replace(/^users\/[^/]+\/hotfolder\/(?:v3\/|android\/)?/, '')
        .replace(/^hotfolder\/(?:v3\/|android\/)?/, '');
}

async function getHotfolderUserAccess(env, uid) {
    const serviceToken = await getServiceToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${serviceToken}` } });
    if (res.status === 404 || !res.ok) return { ok: true };

    const doc = await res.json();
    const status = doc.fields?.status?.stringValue || 'active';
    return {
        ok: status !== 'suspended' && status !== 'disabled',
        reason: doc.fields?.suspensionReason?.stringValue || ''
    };
}

async function putHotfolderTargets(env, uid, key, content, targets = ['v3', 'android']) {
    const cleanKey = cleanHotfolderKey(key);
    const keys = targets.map(target => `users/${uid}/hotfolder/${target}/${cleanKey}`);
    await Promise.all(keys.map(hotKey =>
        Storage.put(env, hotKey, content, { httpMetadata: { contentType: 'application/json' } })
    ));
    return keys;
}

export { putHotfolderTargets };
