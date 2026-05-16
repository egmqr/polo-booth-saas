// dashboard.js

import { Storage } from './cloud.js';
import { json, decodeBase64, safePrefix } from './util.js';
import { verifyFirebaseToken, getServiceToken } from './auth.js';

// ── AUTH HELPER ───────────────────────────────────────────────────────
async function authenticate(request, env) {
    const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
    return await verifyFirebaseToken(env, token); // throws if invalid
}

// ── TIER HELPER ───────────────────────────────────────────────────────
async function getUserTier(env, uid) {
    const serviceToken = await getServiceToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${serviceToken}` } });
    if (!res.ok) return 'free';
    const doc = await res.json();
    return doc.fields?.tier?.stringValue || 'free';
}

// ── USER ROUTES (provision + profile) ────────────────────────────────
export async function handleUserRoutes(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    let user;
    try { user = await authenticate(request, env); }
    catch (e) { return json({ success: false, error: 'Unauthorized' }, 401); }

    const serviceToken = await getServiceToken(env);
    const fsBase = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

    // POST /api/auth/provision-user — called once on signup
    if (path === '/api/auth/provision-user') {
        const docUrl = `${fsBase}/users/${user.uid}`;
        const existing = await fetch(docUrl, { headers: { Authorization: `Bearer ${serviceToken}` } });
        if (existing.ok) {
            const doc = await existing.json();
            if (doc.fields) return json({ success: true, tier: doc.fields.tier?.stringValue || 'free' });
        }

        await fetch(docUrl, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    email: { stringValue: user.email },
                    tier: { stringValue: 'free' },
                    createdAt: { timestampValue: new Date().toISOString() },
                    note: { stringValue: '' }
                }
            })
        });
        return json({ success: true, tier: 'free' });
    }

    // GET /api/user/profile — called on every login
    if (path === '/api/user/profile') {
        const docUrl = `${fsBase}/users/${user.uid}`;
        const res = await fetch(docUrl, { headers: { Authorization: `Bearer ${serviceToken}` } });
        if (!res.ok) return json({ uid: user.uid, email: user.email, tier: 'free' });
        const doc = await res.json();
        const f = doc.fields || {};
        return json({
            uid: user.uid,
            email: user.email,
            tier: f.tier?.stringValue || 'free',
            note: f.note?.stringValue || ''
        });
    }

    return json({ error: 'Not found' }, 404);
}

// ── DASHBOARD ROUTES ──────────────────────────────────────────────────
export async function handleDashboardRoutes(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    // Auth: verify Firebase token (replaces BOOTH_AUTH_TOKEN check)
    let currentUser;
    try { currentUser = await authenticate(request, env); }
    catch (e) { return json({ success: false, error: 'Unauthorized' }, 401); }

    const body = await request.json();

    if (path === '/api/next-event-id') return json(await mintNextEventId(env));
    if (path === '/api/dashboard/generate-booth') return json(await generateBoothSetup(env, body, currentUser));
    if (path === '/api/dashboard/update-booth') return json(await updateBoothSetup(env, body, currentUser));
    if (path === '/api/dashboard/booth-details') return json(await getBoothDetails(env, body.eventId, currentUser));
    if (path === '/api/dashboard/delete-booth') return json(await deleteBoothEvent(env, body.eventId, currentUser));
    if (path === '/api/dashboard/existing-logos') return json(await listExistingLogos(env, currentUser));
    if (path === '/api/dashboard/upload-asset') return json(await uploadAsset(env, body, currentUser));
    if (path === '/api/sign-upload') return json(await handleSignedUpload(env, body, currentUser));

    if (path === '/api/dashboard/update-pin') {
        if (!body.pin) return json({ success: false, error: 'No pin provided' }, 400);
        return json(await saveSystemPinToFirestore(env, body.pin));
    }
    if (path === '/api/dashboard/delete-file') {
        if (!body.key) return json({ success: false, error: 'No key provided' }, 400);
        try { await Storage.delete(env, body.key); return json({ success: true }); }
        catch (err) { return json({ success: false, error: err.message }, 500); }
    }

    return json({ error: 'Not found' }, 404);
}

// ── BOOTH GENERATION ──────────────────────────────────────────────────
// User-namespaced paths: users/{uid}/events/{eventId}/...
// All existing logic preserved — only the path prefix and tier check are new.

const NETLIFY_BASE_URL = 'https://gallery.polo-booth.com/main.html';
const MASTER_APP_URL = 'https://gallery.polo-booth.com/';

async function generateBoothSetup(env, p, currentUser, isUpdate = false) {

    // ── Tier enforcement ──────────────────────────────────────────────
    const tier = await getUserTier(env, currentUser.uid);
    const isPaid = tier === 'paid';

    if (!isPaid) {
        // Only check event count for NEW events, not updates
        if (!isUpdate) {
            const serviceToken = await getServiceToken(env);
            const listUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${currentUser.uid}/events?pageSize=2`;
            const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${serviceToken}` } });
            const listData = await listRes.json();
            const existingCount = (listData.documents || []).length;

            if (existingCount >= 1) {
                return { success: false, error: 'Free accounts can publish 1 event. Contact us to upgrade your account.' };
            }
        }

        // Strip paid-only features
        p.enableCommunity = false;
        p.communityOnly = false;
        p.existingBgId = '';
        p.logoData = null;
        p.qrLogoData = null;
        p.existingLogoId = '';
        p.existingQrLogoId = '';
    }

    // ── User-scoped path prefix ───────────────────────────────────────
    const uPrefix = `users/${currentUser.uid}/events`;

    const { eventId, folderName, eventName, boothCount, logoData, qrLogoData, existingLogoId, existingQrLogoId, existingBgId, fontColor, bgColor, logoOnMain, templates, enableCommunity, communityOnly, userStickers } = p;

    const includeCommunity = enableCommunity === true;
    const isOnlyCommunity = communityOnly === true;
    const actualNumBooths = isOnlyCommunity ? 0 : (parseInt(boothCount, 10) || 0);

    const cdn = (env.PUBLIC_CDN_BASE || 'https://cdn.polo-booth.com').replace(/\/$/, '');
    let bgId = existingBgId || '';
    let logoId = existingLogoId || '';
    let qrLogoId = existingQrLogoId || '';

    if (logoData?.base64) {
        const timestamp = Date.now();
        logoId = `logo_${timestamp}`;
        await Storage.put(env, `${uPrefix}/${eventId}/assets/logos/${logoId}.png`, decodeBase64(logoData.base64), { httpMetadata: { contentType: logoData.mimeType || 'image/png' } });

        if (qrLogoData?.base64) {
            qrLogoId = `qrlogo_${timestamp}`;
            await Storage.put(env, `${uPrefix}/${eventId}/assets/qr-logos/${qrLogoId}.png`, decodeBase64(qrLogoData.base64), { httpMetadata: { contentType: qrLogoData.mimeType || 'image/jpeg' } });
        } else {
            qrLogoId = logoId;
        }
    }

    let logoUrlForQr = '';
    if (qrLogoId) logoUrlForQr = `${cdn}/${uPrefix}/${eventId}/assets/logos/${qrLogoId}.png`;
    else if (logoId) logoUrlForQr = `${cdn}/${uPrefix}/${eventId}/assets/logos/${logoId}.png`;

    const totalBooths = includeCommunity ? actualNumBooths + 1 : actualNumBooths;
    let cWidth = templates?.[0]?.CanvasWidth || 1800;
    let cHeight = templates?.[0]?.CanvasHeight || 1200;

    const boothPrefixes = [], qrUrls = [], appUrls = [], configKeys = [];

    for (let i = 1; i <= totalBooths; i++) {
        const isCommunity = includeCommunity && i === totalBooths;
        const tabParam = i.toString();
        const prefix = isCommunity ? `${uPrefix}/${eventId}/community` : `${uPrefix}/${eventId}/booth-${i}/prints`;
        boothPrefixes.push(prefix);

        const mainGalleryUrl = `${NETLIFY_BASE_URL}?id=${eventId}&uid=${currentUser.uid}&tab=${tabParam}${isCommunity ? '&isCommunity=true' : ''}`;
        const preserved = p._existingBoothSettings?.[i] || {};

        const eventConfig = {
            Settings: {
                EventName: `${eventName}-Booth${i}`, CanvasWidth: cWidth, CanvasHeight: cHeight,
                PrinterName: preserved.PrinterName ?? null,
                CloudLink: `https://api.polo-booth.com/api/gallery?prefix=${encodeURIComponent(prefix)}`,
                MainGalleryLink: mainGalleryUrl,
                R2KeyPrefix: prefix,
                StaticBoothPreviewSeconds: preserved.StaticBoothPreviewSeconds ?? 30,
                TemplatePaths: [], IsStaticBoothMode: preserved.IsStaticBoothMode ?? false,
                StaticBoothCountdownSeconds: preserved.StaticBoothCountdownSeconds ?? 10
            },
            Templates: templates || []
        };

        const configKey = `${uPrefix}/${eventId}/config/Booth${i}.json`;
        await Storage.put(env, configKey, JSON.stringify(eventConfig, null, 2), { httpMetadata: { contentType: 'application/json' } });
        configKeys.push(configKey);

        const qcUrl = `https://quickchart.io/qr?size=1000&errorCorrectionLevel=H&text=${encodeURIComponent(mainGalleryUrl)}` +
            (logoUrlForQr ? `&centerImageUrl=${encodeURIComponent(logoUrlForQr + '?v=' + Date.now())}&centerImageSizeRatio=0.22` : '');

        try {
            const qrResp = await fetch(qcUrl);
            if (qrResp.ok) {
                const qrKey = `${uPrefix}/${eventId}/qr/${isCommunity ? 'Community_QRCode.png' : `Booth_${i}_QRCode.png`}`;
                await Storage.put(env, qrKey, await qrResp.arrayBuffer(), { httpMetadata: { contentType: 'image/png', cacheControl: 'no-cache' } });
                qrUrls.push(`${cdn}/${qrKey}?v=${Date.now()}`);
            } else qrUrls.push('');
        } catch { qrUrls.push(''); }

        appUrls.push(`${MASTER_APP_URL}?prefix=${encodeURIComponent(prefix)}&tab=${tabParam}${isCommunity ? '&isCommunity=true' : ''}`);
    }

    await saveEventToFirestore(env, currentUser.uid, eventId, {
        folderName, eventName, boothCount: String(actualNumBooths || boothCount || '1'),
        bgId, logoId, qrLogoId, fontColor, bgColor, logoOnMain,
        booths: appUrls.join('|'), qrUrls: qrUrls.join('|'),
        configKeys: configKeys.join('|'), boothPrefixes: boothPrefixes.join('|'),
        enableCommunity: includeCommunity, communityOnly: isOnlyCommunity,
        userStickers: userStickers === true
    });

    // Push each booth config to the user's hotfolder so ProBooth picks it up on next sync
    const userHotfolderPrefix = `users/${currentUser.uid}/hotfolder/`;
    for (const configKey of configKeys) {
        try {
            const obj = await Storage.get(env, configKey);
            if (obj) {
                const filename = configKey.split('/').pop(); // e.g. Booth1.json
                const hotKey = `${userHotfolderPrefix}${eventId}_${filename}`;
                await Storage.put(env, hotKey, await obj.text(), { httpMetadata: { contentType: 'application/json' } });
            }
        } catch { }
    }

    return { success: true, message: 'Generated successfully!' };
}

async function updateBoothSetup(env, p, currentUser) {
    const uPrefix = `users/${currentUser.uid}/events`;
    const actualNumBooths = p.communityOnly === true ? 0 : (parseInt(p.boothCount, 10) || 1);
    const totalBooths = (p.enableCommunity === true) ? actualNumBooths + 1 : actualNumBooths;

    const existingSettings = {};
    for (let i = 1; i <= totalBooths; i++) {
        try {
            const obj = await Storage.get(env, `${uPrefix}/${p.eventId}/config/Booth${i}.json`);
            if (obj) {
                const existing = JSON.parse(await obj.text());
                if (existing?.Settings) existingSettings[i] = {
                    IsStaticBoothMode: existing.Settings.IsStaticBoothMode ?? false,
                    StaticBoothPreviewSeconds: existing.Settings.StaticBoothPreviewSeconds ?? 30,
                    StaticBoothCountdownSeconds: existing.Settings.StaticBoothCountdownSeconds ?? 10,
                    PrinterName: existing.Settings.PrinterName ?? null,
                };
            }
        } catch { }
    }
    p._existingBoothSettings = existingSettings;
    return generateBoothSetup(env, p, currentUser, true);
}

async function getBoothDetails(env, eventId, currentUser) {
    const serviceToken = await getServiceToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${currentUser.uid}/events/${eventId}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${serviceToken}` } });
    if (!res.ok) return { success: false, error: 'Firebase fetch error' };
    const doc = await res.json();
    const f = doc.fields || {};

    let templates = [];
    const firstConfigKey = (f.configKeys?.stringValue || '').split('|').find(k => k && k.length > 5) || '';
    if (firstConfigKey) {
        try {
            const obj = await Storage.get(env, firstConfigKey);
            if (obj) {
                const data = JSON.parse(await obj.text());
                if (Array.isArray(data.Templates)) templates = data.Templates;
            }
        } catch { }
    }

    return {
        success: true, id: eventId,
        folderName: f.folderName?.stringValue || '',
        eventName: f.eventName?.stringValue || '',
        boothCount: f.boothCount?.stringValue || '',
        bgId: f.bgId?.stringValue || '',
        logoId: f.logoId?.stringValue || '',
        qrLogoId: f.qrLogoId?.stringValue || '',
        fontColor: f.fontColor?.stringValue || '#ffffff',
        bgColor: f.bgColor?.stringValue || '#000000',
        logoOnMain: f.logoOnMain?.booleanValue || false,
        userStickers: f.userStickers?.booleanValue || false,
        boothsStr: f.booths?.stringValue || '',
        qrUrlsStr: f.qrUrls?.stringValue || '',
        configKeysStr: f.configKeys?.stringValue || '',
        boothPrefixesStr: f.boothPrefixes?.stringValue || '',
        enableCommunity: f.enableCommunity?.booleanValue || false,
        communityOnly: f.communityOnly?.booleanValue || false,
        templatesStr: JSON.stringify(templates)
    };
}

async function deleteBoothEvent(env, eventId, currentUser) {
    const prefix = `users/${currentUser.uid}/events/${eventId}/`;
    let cursor;
    do {
        const page = await Storage.list(env, { prefix, cursor });
        if (page.objects.length) await Storage.delete(env, page.objects.map(o => o.key));
        cursor = page.truncated ? page.cursor : null;
    } while (cursor);

    const serviceToken = await getServiceToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${currentUser.uid}/events/${eventId}`;
    await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${serviceToken}` } });
    return { success: true, message: 'Booth resources deleted.' };
}

// ── ASSET HELPERS ─────────────────────────────────────────────────────

async function handleSignedUpload(env, body, currentUser) {
    const prefix = safePrefix(body.prefix);
    if (!prefix) return { error: 'Invalid prefix' };

    // Ensure the prefix belongs to this user
    const allowedBase = `users/${currentUser.uid}/`;
    if (!prefix.startsWith(allowedBase)) {
        return { error: 'Prefix must be within your user namespace' };
    }

    const filename = (body.filename || '').replace(/[^A-Za-z0-9._-]/g, '_');
    const key = `${prefix}/${filename}`;
    const uploadUrl = await Storage.presignPut(env, key, 900);

    return { uploadUrl, key, publicUrl: `${(env.PUBLIC_CDN_BASE || 'https://cdn.polo-booth.com').replace(/\/$/, '')}/${key}`, expiresIn: 900 };
}

async function listExistingLogos(env, currentUser) {
    const prefix = `users/${currentUser.uid}/assets/logos/`;
    const list = await Storage.list(env, { prefix, limit: 1000 });
    const cdn = (env.PUBLIC_CDN_BASE || 'https://cdn.polo-booth.com').replace(/\/$/, '');
    const logos = list.objects
        .filter(o => !o.key.split('/').pop().startsWith('.'))
        .map(o => {
            const id = o.key.replace(prefix, '').replace(/\.[^.]+$/, '');
            return { id, qrId: id.replace('logo_', 'qrlogo_'), name: o.key.split('/').pop(), url: `${cdn}/${o.key}?w=150` };
        });
    return { success: true, logos };
}

async function uploadAsset(env, body, currentUser) {
    const map = { 'logo': 'logos', 'background': 'backgrounds', 'qr-logo': 'qr-logos' };
    const folder = map[body.kind];
    if (!folder) return { success: false, error: 'Invalid kind' };

    const id = `${body.kind}_${Date.now()}`;
    const ext = (body.filename || '').match(/\.[a-z0-9]+$/i)?.[0] || '.png';
    const key = `users/${currentUser.uid}/assets/${folder}/${id}${ext}`;
    await Storage.put(env, key, decodeBase64(body.base64Data), { httpMetadata: { contentType: body.mimeType || 'image/png' } });

    return { success: true, id, key, url: `${(env.PUBLIC_CDN_BASE || 'https://cdn.polo-booth.com').replace(/\/$/, '')}/${key}` };
}

// ── FIRESTORE OPS ─────────────────────────────────────────────────────

async function mintNextEventId(env) {
    try {
        const serviceToken = await getServiceToken(env);
        const baseUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)`;
        const commitRes = await fetch(`${baseUrl}/documents:commit`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                writes: [{
                    transform: {
                        document: `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/counters/eventIdCounter`,
                        fieldTransforms: [{ fieldPath: 'currentId', increment: { integerValue: '1' } }]
                    }
                }]
            })
        });
        if (!commitRes.ok) throw new Error('Firestore commit failed');
        const getRes = await fetch(`${baseUrl}/documents/counters/eventIdCounter`, {
            headers: { Authorization: `Bearer ${serviceToken}` }
        });
        const doc = await getRes.json();
        return { success: true, eventId: 'egm' + String(parseInt(doc.fields?.currentId?.integerValue || '1', 10)).padStart(4, '0') };
    } catch (err) {
        return { success: true, eventId: 'egm' + Math.floor(10000 + Math.random() * 90000), fallback: true };
    }
}

async function saveEventToFirestore(env, uid, eventId, data) {
    const serviceToken = await getServiceToken(env);
    const payload = {
        fields: {
            folderName: { stringValue: data.folderName || '' },
            eventName: { stringValue: data.eventName || '' },
            boothCount: { stringValue: data.boothCount || '1' },
            bgId: { stringValue: data.bgId || '' },
            logoId: { stringValue: data.logoId || '' },
            qrLogoId: { stringValue: data.qrLogoId || '' },
            fontColor: { stringValue: data.fontColor || '' },
            bgColor: { stringValue: data.bgColor || '' },
            booths: { stringValue: data.booths || '' },
            qrUrls: { stringValue: data.qrUrls || '' },
            configKeys: { stringValue: data.configKeys || '' },
            boothPrefixes: { stringValue: data.boothPrefixes || '' },
            logoOnMain: { booleanValue: data.logoOnMain === true },
            enableCommunity: { booleanValue: data.enableCommunity === true },
            communityOnly: { booleanValue: data.communityOnly === true },
            userStickers: { booleanValue: data.userStickers === true },
            timestamp: { timestampValue: new Date().toISOString() }
        }
    };
    const updateMaskPaths = Object.keys(payload.fields)
        .map(k => `updateMask.fieldPaths=${k}`).join('&');
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}/events/${eventId}?${updateMaskPaths}`;
    await fetch(url, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${serviceToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
}

async function saveSystemPinToFirestore(env, pin) {
    const serviceToken = await getServiceToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/booth_settings/system`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { pin: { stringValue: pin }, timestamp: { timestampValue: new Date().toISOString() } } })
    });
    if (!res.ok) return { success: false, error: `Firestore Error ${res.status}: ${await res.text()}` };
    return { success: true, message: 'System pin updated' };
}