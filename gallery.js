import { Storage } from './cloud.js';
import { json, decodeBase64, safePrefix } from './util.js';

const streamCache = new Map();

export async function handleGalleryRoutes(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/gallery' && request.method === 'GET') {
        const prefix = safePrefix(url.searchParams.get('prefix'));
        if (!prefix) return json({ status: 'error', message: 'Invalid prefix' }, 400);

        const limit = Math.min(parseInt(url.searchParams.get('limit') || '1000', 10), 1000);
        const items = await listAllObjects(env, prefix + '/', limit);
        const cdn = env.PUBLIC_CDN_BASE.replace(/\/$/, '');

        const data = items
            .filter(o => !o.key.slice(prefix.length + 1).includes('/') && /\.(jpe?g|png|webp)$/i.test(o.key))
            .map(o => [o.key, o.key.split('/').pop(), `${cdn}/${o.key}`, o.uploaded.getTime()])
            .sort((a, b) => b[3] - a[3]);

        return json({ status: 'success', data });
    }

    if (path === '/api/template' && request.method === 'GET') {
        const prefix = safePrefix(url.searchParams.get('prefix'));
        if (!prefix) return json({ success: false, error: 'Invalid prefix' }, 400);

        let config = await findTemplateConfig(env, prefix);
        if (!config) {
            const parent = prefix.split('/').slice(0, -1).join('/');
            if (parent && parent !== prefix) config = await findTemplateConfig(env, parent);
        }
        if (!config) {
            const eventConfigPrefix = getEventConfigPrefix(prefix);
            if (eventConfigPrefix) config = await findTemplateConfig(env, eventConfigPrefix);
        }
        if (!config?.Templates?.length) return json({ success: false, error: 'No valid configuration file found.' });

        return json({ success: true, data: config.Templates });
    }

    if (path === '/api/stream' && request.method === 'GET') {
        const prefix = safePrefix(url.searchParams.get('prefix'));
        if (!prefix) return json({ status: 'error', message: 'Invalid prefix' }, 400);

        const { readable, writable } = new TransformStream();
        streamLiveUpdates(env, prefix, writable.getWriter(), new TextEncoder());

        return new Response(readable, {
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' }
        });
    }

    if (path === '/api/upload-community' && request.method === 'POST') {
        const body = await request.json();
        const prefix = safePrefix(body.prefix);
        if (!prefix) return json({ success: false, error: 'Invalid prefix' }, 400);

        const filename = (body.filename || `Community_${Date.now()}.jpg`).replace(/[^A-Za-z0-9._-]/g, '_');
        const fullKey = `${prefix}/${filename}`;

        await Storage.put(env, fullKey, decodeBase64(body.base64Data), { httpMetadata: { contentType: body.mimeType || 'image/jpeg' } });
        return json({ success: true, url: `${env.PUBLIC_CDN_BASE.replace(/\/$/, '')}/${fullKey}`, key: fullKey });
    }

    return json({ error: 'Not found' }, 404);
}

// ── INTERNAL HELPERS ──
async function listAllObjects(env, prefix, limit) {
    const out = []; let cursor;
    while (out.length < limit) {
        const page = await Storage.list(env, { prefix, limit: Math.min(1000, limit - out.length), cursor });
        out.push(...page.objects);
        if (!page.truncated) break;
        cursor = page.cursor;
    }
    return out;
}

async function findTemplateConfig(env, prefix) {
    const list = await Storage.list(env, { prefix: prefix + '/' });
    for (const obj of list.objects) {
        if (!obj.key.toLowerCase().endsWith('.json')) continue;
        try {
            const body = await Storage.get(env, obj.key);
            if (body) { const data = JSON.parse(await body.text()); if (data?.Templates?.length > 0) return data; }
        } catch { }
    }
    return null;
}

function getEventConfigPrefix(prefix) {
    const parts = prefix.split('/').filter(Boolean);
    const eventIdx = parts.lastIndexOf('events');
    if (eventIdx === -1 || !parts[eventIdx + 1]) return '';
    return parts.slice(0, eventIdx + 2).concat('config').join('/');
}

async function streamLiveUpdates(env, prefix, writer, encoder) {
    let lastKnownKeys = new Set();
    let isFirstRun = true;
    try {
        while (true) {
            const now = Date.now();
            let cache = streamCache.get(prefix);
            let items = [];

            if (!cache || now - cache.time > 5000) {
                items = await listAllObjects(env, prefix + '/', 1000);
                streamCache.set(prefix, { time: now, items });
            } else { items = cache.items; }

            const files = items.filter(o => !o.key.slice(prefix.length + 1).includes('/') && /\.(jpe?g|png|webp)$/i.test(o.key));
            const currentKeys = new Set(files.map(f => f.key));

            if (!isFirstRun) {
                for (const file of files) {
                    if (!lastKnownKeys.has(file.key)) {
                        const data = { id: file.key, name: file.key.split('/').pop(), baseUrl: `${env.PUBLIC_CDN_BASE.replace(/\/$/, '')}/${file.key}`, time: file.uploaded.getTime() };
                        await writer.write(encoder.encode(`event: new_photo\ndata: ${JSON.stringify(data)}\n\n`));
                    }
                }
                for (const oldKey of lastKnownKeys) {
                    if (!currentKeys.has(oldKey)) await writer.write(encoder.encode(`event: deleted_photo\ndata: ${JSON.stringify({ id: oldKey })}\n\n`));
                }
            }
            await writer.write(encoder.encode(`: heartbeat\n\n`));
            lastKnownKeys = currentKeys; isFirstRun = false;
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    } catch (err) { await writer.close().catch(() => { }); }
}
