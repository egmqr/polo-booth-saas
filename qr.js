import { Storage, Sessions } from './cloud.js';
import { json, safePrefix } from './util.js';

export async function handleQRRoutes(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const prefix = safePrefix(url.searchParams.get('prefix'));
    if (!prefix) return json({ status: 'error', message: 'Missing prefix' }, 400);

    if (path === '/api/photo' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        const photo = await findPhotoByTagOrName(env, prefix, id);
        if (!photo) {
            const numMatch = id?.match(/[ps](\d+)/i);
            if (numMatch) {
                const n = parseInt(numMatch[1], 10);
                const all = await listAll(env, prefix + '/');
                const sorted = all.filter(o => !o.key.slice(prefix.length + 1).includes('/')).sort((a, b) => a.uploaded - b.uploaded);
                if (sorted.length >= n && n > 0) return json({ status: 'success', data: [photoUrls(env, prefix, sorted[n - 1].key)] });
            }
            return json({ status: 'error', message: 'Photo not found yet' });
        }
        return json({ status: 'success', data: [photoUrls(env, prefix, photo.key)] });
    }

    if (path === '/api/photo' && request.method === 'DELETE') {
        if (request.headers.get('authorization') !== `Bearer ${env.BOOTH_AUTH_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
        const key = url.searchParams.get('key');
        if (!key?.startsWith('events/')) return json({ error: 'Invalid key' }, 400);

        await Storage.delete(env, key);
        return json({ success: true, deleted: key });
    }

    if (path === '/api/session-gallery' && request.method === 'GET') {
        const session = url.searchParams.get('session');
        const list = await listAll(env, prefix + '/');
        const re = new RegExp(`-${session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.[A-Za-z0-9]+)?$`);
        const photos = list.filter(o => !o.key.slice(prefix.length + 1).includes('/') && re.test(o.key))
            .sort((a, b) => b.uploaded - a.uploaded)
            .map(o => { const u = photoUrls(env, prefix, o.key); u.displayTime = new Date(o.uploaded).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return u; });
        return photos.length === 0 ? json({ status: 'error', message: 'No photos in session yet' }) : json({ status: 'success', data: photos });
    }

    if (path === '/api/toggle-session' && request.method === 'POST') {
        const body = await request.json();
        if (body.isStarting) {
            const sessionStr = await nextId(env, 's', prefix);
            await Sessions.put(env, `active:${prefix}`, sessionStr);
            return json({ sessionNum: sessionStr });
        } else {
            const current = await Sessions.get(env, `active:${prefix}`);
            await Sessions.delete(env, `active:${prefix}`);
            return json({ sessionNum: current });
        }
    }

    if (path === '/api/next-photo-id' && request.method === 'GET') {
        return json({ photoId: await nextId(env, 'p', prefix) });
    }

    return json({ error: 'Not found' }, 404);
}

// ── INTERNAL HELPERS ──
async function nextId(env, kind, prefix) {
    const key = `counter:${kind}:${prefix}`;
    const cur = parseInt((await Sessions.get(env, key)) || '0', 10);
    await Sessions.put(env, key, String(cur + 1));
    return kind + String(cur + 1).padStart(4, '0');
}
async function findPhotoByTagOrName(env, prefix, id) {
    const list = await listAll(env, prefix + '/', 200);
    const hit = list.find(o => !o.key.slice(prefix.length + 1).includes('/') && o.key.includes(id));
    return hit ? { key: hit.key } : null;
}
async function listAll(env, prefix, limit = 1000) {
    const out = []; let cursor;
    while (out.length < limit) {
        const page = await Storage.list(env, { prefix, limit: Math.min(1000, limit - out.length), cursor });
        out.push(...page.objects);
        if (!page.truncated) break;
        cursor = page.cursor;
    }
    return out;
}
function photoUrls(env, prefix, key) {
    const cdn = env.PUBLIC_CDN_BASE.replace(/\/$/, '');
    return { baseUrl: `${cdn}/${key}`, previewUrl: `${cdn}/${key}`, downloadUrl: `${cdn}/${key}` };
}