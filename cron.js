import { Firebase, Sessions } from './cloud.js';
import { json } from './util.js';

export async function runDailyTasks(env) {
    const out = { cleanedCounters: 0, errors: [] };

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

    return json(out);
}