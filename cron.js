import { Firebase, Sessions, Storage } from './cloud.js';
import { json } from './util.js';

export async function runDailyTasks(env) {
    const out = { cleanedCounters: 0, cleanedHotfolder: 0, skippedCounters: false, errors: [] };

    if (env.FIREBASE_PROJECT_ID && env.FIREBASE_EMAIL && env.FIREBASE_PASSWORD) {
        try {
            const phtMs = Date.now() + (new Date().getTimezoneOffset() * 60_000) + (8 * 3_600_000);
            const pht = new Date(phtMs);
            const todayStr = `${pht.getUTCFullYear()}-${String(pht.getUTCMonth() + 1).padStart(2, '0')}-${String(pht.getUTCDate()).padStart(2, '0')}`;

            const outEvents = [];
            let pageToken;
            do {
                const url = `/dashboard_events?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
                const res = await Firebase.fetch(env, url);
                if (!res.ok) break;
                const data = await res.json();
                for (const d of (data.documents || [])) outEvents.push({ eventId: d.fields?.eventId?.stringValue || '', eventDate: d.fields?.eventDate?.stringValue || '' });
                pageToken = data.nextPageToken;
            } while (pageToken);

            const baseIdToMaxDate = new Map();
            for (const ev of outEvents) {
                const id = ev.eventId.toLowerCase();
                const cur = baseIdToMaxDate.get(id);
                if (!cur || ev.eventDate > cur) baseIdToMaxDate.set(id, ev.eventDate);
            }

            for (const [baseId, lastDate] of baseIdToMaxDate) {
                if (lastDate < todayStr) {
                    const pList = await Sessions.list(env, { prefix: `counter:p:events/${baseId}/` });
                    for (const k of pList.keys) { await Sessions.delete(env, k.name); out.cleanedCounters++; }

                    const sList = await Sessions.list(env, { prefix: `counter:s:events/${baseId}/` });
                    for (const k of sList.keys) { await Sessions.delete(env, k.name); out.cleanedCounters++; }
                }
            }
        } catch (e) {
            out.errors.push(e.message);
        }
    } else {
        out.skippedCounters = true;
    }

    try {
        out.cleanedHotfolder += await cleanupUserAndroidHotfolders(env, Date.now());
        out.cleanedHotfolder += await cleanupAndroidHotfolder(env, 'hotfolder/android/', Date.now());
    } catch (e) {
        out.errors.push(e.message);
    }

    return json(out);
}

const ANDROID_HOTFOLDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ANDROID_DELETE_TOMBSTONE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

async function cleanupAndroidHotfolder(env, prefix, nowMs) {
    let removed = 0;
    let cursor;
    do {
        const page = await Storage.list(env, { prefix, limit: 1000, cursor });
        const expired = (page.objects || [])
            .filter(obj => obj.key.includes('/hotfolder/android/') || obj.key.startsWith('hotfolder/android/'))
            .filter(obj => isExpiredHotfolderObject(obj, nowMs))
            .map(obj => obj.key);
        if (expired.length) {
            await Storage.delete(env, expired);
            removed += expired.length;
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return removed;
}

async function cleanupUserAndroidHotfolders(env, nowMs) {
    let removed = 0;
    let cursor;
    do {
        const page = await Storage.list(env, { prefix: 'users/', delimiter: '/', limit: 1000, cursor });
        const prefixes = (page.delimitedPrefixes || page.prefixes || [])
            .map(value => typeof value === 'string' ? value : value.prefix)
            .filter(Boolean);
        for (const userPrefix of prefixes) {
            removed += await cleanupAndroidHotfolder(env, `${userPrefix}hotfolder/android/`, nowMs);
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return removed;
}

function isExpiredHotfolderObject(obj, nowMs) {
    if (!obj.key.endsWith('.json')) return false;
    const uploaded = obj.uploaded ? new Date(obj.uploaded).getTime() : 0;
    if (!uploaded || Number.isNaN(uploaded)) return false;
    const ttl = obj.key.endsWith('_deleted.json')
        ? ANDROID_DELETE_TOMBSTONE_TTL_MS
        : ANDROID_HOTFOLDER_TTL_MS;
    return nowMs - uploaded > ttl;
}
