import { Firebase, Storage } from './cloud.js';
import { json } from './util.js';

export async function handleHotfolder(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/hotfolder/push' && request.method === 'POST') {
        if (request.headers.get('authorization') !== `Bearer ${env.BOOTH_AUTH_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
        const { key, content } = await request.json();
        const safeKey = key.startsWith('hotfolder/') ? key : `hotfolder/${key}`;
        await Storage.put(env, safeKey, content, { httpMetadata: { contentType: 'application/json' } });
        return json({ success: true, key: safeKey });
    }

    if (path === '/api/hotfolder/ack' && request.method === 'DELETE') {
        if (request.headers.get('authorization') !== `Bearer ${env.BOOTH_AUTH_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
        const { key } = await request.json();
        const safeKey = key.startsWith('hotfolder/') ? key : `hotfolder/${key}`;
        await Storage.delete(env, safeKey);
        return json({ success: true });
    }

    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const pushSynced = await getPushSyncedConfigs(env);
    const scheduled = await getScheduledConfigs(env);

    const prefixSeen = new Set(pushSynced.map(f => extractPrefix(f.content)));
    const filteredScheduled = scheduled.filter(f => !prefixSeen.has(extractPrefix(f.content)));

    return json([...pushSynced, ...filteredScheduled]);
}

// ── HELPERS ──
async function getPushSyncedConfigs(env) {
    const list = await Storage.list(env, { prefix: 'hotfolder/', limit: 200 });
    const files = [];
    for (const obj of list.objects) {
        if (!obj.key.endsWith('.json')) continue;
        try {
            const r2obj = await Storage.get(env, obj.key);
            if (r2obj) files.push({ name: obj.key.replace('hotfolder/', ''), content: await r2obj.text(), hotfolderKey: obj.key });
        } catch { }
    }
    return files;
}

async function getScheduledConfigs(env) {
    const phtMs = Date.now() + (new Date().getTimezoneOffset() * 60_000) + (8 * 3_600_000);
    const pht = new Date(phtMs);
    const todayStr = `${pht.getUTCFullYear()}-${String(pht.getUTCMonth() + 1).padStart(2, '0')}-${String(pht.getUTCDate()).padStart(2, '0')}`;

    const res = await Firebase.fetch(env, ':runQuery', {
        method: 'POST', body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'dashboard_events' }], where: { fieldFilter: { field: { fieldPath: 'eventDate' }, op: 'EQUAL', value: { stringValue: todayStr } } } } })
    });

    const docs = await res.json();
    const ids = new Set();
    for (const r of docs) { if (r.document?.fields?.eventId) ids.add(r.document.fields.eventId.stringValue.toLowerCase()); }

    const files = [];
    for (const baseId of ids) {
        const daysRes = await Firebase.fetch(env, ':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'dashboard_events' }], where: { fieldFilter: { field: { fieldPath: 'eventId' }, op: 'EQUAL', value: { stringValue: baseId } } } } }) });
        const daysDocs = await daysRes.json();
        const days = daysDocs.filter(r => r.document?.fields).map(r => ({ date: r.document.fields.eventDate?.stringValue || '9999-99-99', startTime: r.document.fields.startTime?.stringValue || '99:99', callTime: r.document.fields.callTime?.stringValue || '99:99' }));

        days.sort((a, b) => a.date !== b.date ? a.date.localeCompare(b.date) : (a.startTime !== '99:99' ? a.startTime : a.callTime).localeCompare(b.startTime !== '99:99' ? b.startTime : b.callTime));

        let smartBoothId = null;
        days.forEach((d, idx) => { if (d.date === todayStr) smartBoothId = idx === 0 ? baseId : `${baseId}_D${idx + 1}`; });

        if (smartBoothId) {
            const eventDocRes = await Firebase.fetch(env, `/events/${smartBoothId}`);
            if (!eventDocRes.ok) continue;
            const eventDoc = await eventDocRes.json();

            if (eventDoc.fields?.communityOnly?.booleanValue === true) continue;
            const enableCommunity = eventDoc.fields?.enableCommunity?.booleanValue === true;

            const list = await Storage.list(env, { prefix: `events/${smartBoothId}/config/` });
            const boothConfigs = list.objects.filter(o => /\/Booth\d+\.json$/.test(o.key)).sort((a, b) => a.key.localeCompare(b.key));
            const toEmit = enableCommunity ? boothConfigs.slice(0, -1) : boothConfigs;

            for (let i = 0; i < toEmit.length; i++) {
                const obj = await Storage.get(env, toEmit[i].key);
                if (obj) files.push({ name: `${smartBoothId}_Booth${i + 1}.json`, content: await obj.text() });
            }
        }
    }
    return files;
}

function extractPrefix(content) { try { return JSON.parse(content)?.Settings?.R2KeyPrefix || ''; } catch { return ''; } }