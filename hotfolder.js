import { Storage } from './cloud.js';
import { json } from './util.js';
import { verifyFirebaseToken } from './auth.js';

export async function handleHotfolder(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // All hotfolder routes require Firebase auth
    const rawToken = (request.headers.get('authorization') || '').replace('Bearer ', '');
    let currentUser;
    try { currentUser = await verifyFirebaseToken(env, rawToken); }
    catch (e) { return json({ error: 'Unauthorized' }, 401); }

    const userHotfolderPrefix = `users/${currentUser.uid}/hotfolder/`;

    // POST /api/hotfolder/push — Dashboard or ProBooth pushes a config JSON
    if (path === '/api/hotfolder/push' && request.method === 'POST') {
        const { key, content } = await request.json();
        const safeKey = `${userHotfolderPrefix}${key.replace(/^hotfolder\//, '')}`;
        await Storage.put(env, safeKey, content, { httpMetadata: { contentType: 'application/json' } });
        return json({ success: true, key: safeKey });
    }

    // DELETE /api/hotfolder/ack — ProBooth acknowledges it has received the config
    if (path === '/api/hotfolder/ack' && request.method === 'DELETE') {
        const { key } = await request.json();
        const safeKey = key.startsWith('users/') ? key : `${userHotfolderPrefix}${key.replace(/^hotfolder\//, '')}`;
        await Storage.delete(env, safeKey);
        return json({ success: true });
    }

    // GET /api/hotfolder — ProBooth pulls pending configs on startup
    if (request.method === 'GET') {
        const list = await Storage.list(env, { prefix: userHotfolderPrefix, limit: 200 });
        const files = [];
        for (const obj of list.objects) {
            if (!obj.key.endsWith('.json')) continue;
            try {
                const r2obj = await Storage.get(env, obj.key);
                if (r2obj) {
                    files.push({
                        name: obj.key.replace(userHotfolderPrefix, ''),
                        content: await r2obj.text(),
                        hotfolderKey: obj.key
                    });
                }
            } catch { }
        }
        return json(files);
    }

    return json({ error: 'Method not allowed' }, 405);
}