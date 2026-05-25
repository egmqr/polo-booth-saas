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
        // Parse the body to get the invite code
        let body = {};
        try { body = await request.json(); } catch (e) { }
        const inviteCode = body.inviteCode;

        if (!inviteCode) return json({ success: false, error: 'Invite code is required.' }, 400);

        // 1. Verify the invite code in Firestore
        const codeUrl = `${fsBase}/invite_codes/${inviteCode}`;
        const codeRes = await fetch(codeUrl, { headers: { Authorization: `Bearer ${serviceToken}` } });

        if (!codeRes.ok) {
            return json({ success: false, error: 'Invalid invite code.' }, 400);
        }

        const codeDoc = await codeRes.json();
        const isUsed = codeDoc.fields?.used?.booleanValue;

        if (isUsed) {
            return json({ success: false, error: 'This invite code has already been used.' }, 400);
        }

        // 2. Mark the code as used
        await fetch(`${codeUrl}?updateMask.fieldPaths=used&updateMask.fieldPaths=usedBy`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    used: { booleanValue: true },
                    usedBy: { stringValue: user.uid }
                }
            })
        });

        // 3. Provision the user
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
            note: f.note?.stringValue || '',
            pin: f.pin?.stringValue || '1234'
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
    if (path === '/api/dashboard/check-event-name') return json(await checkEventNameUnique(env, body, currentUser));
    if (path === '/api/dashboard/generate-booth') return json(await generateBoothSetup(env, body, currentUser));
    if (path === '/api/dashboard/update-booth') return json(await updateBoothSetup(env, body, currentUser));
    if (path === '/api/dashboard/rename-event') return json(await renameEventName(env, body, currentUser));
    if (path === '/api/dashboard/booth-details') return json(await getBoothDetails(env, body.eventId, currentUser));
    if (path === '/api/dashboard/delete-booth') return json(await deleteBoothEvent(env, body.eventId, currentUser));
    if (path === '/api/dashboard/existing-assets') return json(await listExistingAssets(env, body, currentUser));
    if (path === '/api/dashboard/upload-asset') return json(await uploadAsset(env, body, currentUser));
    if (path === '/api/sign-upload') return json(await handleSignedUpload(env, body, currentUser));

    if (path === '/api/dashboard/update-pin') {
        if (!body.pin) return json({ success: false, error: 'No pin provided' }, 400);
        // FIX: Pass currentUser into the function so it knows whose profile to update
        return json(await saveSystemPinToFirestore(env, body.pin, currentUser));
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
            // Fetch up to 4 so we can accurately count if they already have 3
            const listUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${currentUser.uid}/events?pageSize=4`;
            const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${serviceToken}` } });
            const listData = await listRes.json();
            const existingCount = (listData.documents || []).length;

            // Allow up to 3 cloud events for free users; extras are saved locally in ProBooth.
            if (existingCount >= 3) {
                return { success: false, error: 'Free accounts can publish 3 cloud events. Additional events are saved locally in the ProBooth app.' };
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

    const { eventId, folderName, eventName, pageTitle, boothCount, logoData, qrLogoData, existingLogoId, existingQrLogoId, existingBgId, fontColor, bgColor, logoOnMain, templates, enableCommunity, communityOnly, userStickers, source } = p;
    // Origin marker: 'probooth' events have templates locked on the web dashboard.
    const eventSource = (source === 'probooth') ? 'probooth' : (p._existingSource || 'dashboard');

    const includeCommunity = enableCommunity === true;
    const isOnlyCommunity = communityOnly === true;
    const actualNumBooths = isOnlyCommunity ? 0 : (parseInt(boothCount, 10) || 0);

    const cdn = (env.PUBLIC_CDN_BASE || 'https://cdn.polo-booth.com').replace(/\/$/, '');

    // ── BACKGROUND REUSE & BACKUP LOGIC ──
    let bgId = p.existingBgId || '';
    if (p.existingBgKey && !p.isNewBgUpload) {
        // Check if the key is already in this event's folder to prevent duplication
        if (!p.existingBgKey.includes(`/${eventId}/`)) {
            // Reuse: Copy from Global Gallery into this Event's folder
            const bgObj = await Storage.get(env, p.existingBgKey);
            if (bgObj) {
                bgId = `bg_${Date.now()}`;
                await Storage.put(env, `${uPrefix}/${eventId}/assets/backgrounds/${bgId}.jpg`, await bgObj.arrayBuffer(), { httpMetadata: bgObj.httpMetadata });
            }
        }
        // If it DOES include the eventId, bgId remains p.existingBgId (no copying needed)
    } else if (p.isNewBgUpload && bgId) {
        // Backup: Save a copy of the newly uploaded BG to the Global Gallery
        const bgObj = await Storage.get(env, `${uPrefix}/${eventId}/assets/backgrounds/${bgId}.jpg`);
        if (bgObj) {
            await Storage.put(env, `users/${currentUser.uid}/assets/backgrounds/${bgId}.jpg`, await bgObj.arrayBuffer(), { httpMetadata: bgObj.httpMetadata });
        }
    }

    // ── LOGO REUSE & BACKUP LOGIC ──
    let logoId = p.existingLogoId || '';
    let qrLogoId = p.existingQrLogoId || '';

    if (logoData?.base64) {
        const timestamp = Date.now();
        logoId = `logo_${timestamp}`;
        const buffer = decodeBase64(logoData.base64);

        // Upload to Event Folder AND backup to Global Gallery
        await Storage.put(env, `${uPrefix}/${eventId}/assets/logos/${logoId}.png`, buffer, { httpMetadata: { contentType: logoData.mimeType || 'image/png' } });
        await Storage.put(env, `users/${currentUser.uid}/assets/logos/${logoId}.png`, buffer, { httpMetadata: { contentType: logoData.mimeType || 'image/png' } });

        if (qrLogoData?.base64) {
            qrLogoId = `qrlogo_${timestamp}`;
            const qrBuffer = decodeBase64(qrLogoData.base64);
            await Storage.put(env, `${uPrefix}/${eventId}/assets/qr-logos/${qrLogoId}.png`, qrBuffer, { httpMetadata: { contentType: qrLogoData.mimeType || 'image/jpeg' } });
            await Storage.put(env, `users/${currentUser.uid}/assets/qr-logos/${qrLogoId}.png`, qrBuffer, { httpMetadata: { contentType: qrLogoData.mimeType || 'image/jpeg' } });
        } else {
            qrLogoId = logoId;
        }
    } else if (p.existingLogoKey) {
        // Check if the key is already in this event's folder to prevent duplication
        if (!p.existingLogoKey.includes(`/${eventId}/`)) {
            // Reuse: Copy from Global Gallery into this Event's folder
            const lObj = await Storage.get(env, p.existingLogoKey);
            if (lObj) {
                logoId = `logo_${Date.now()}`;
                await Storage.put(env, `${uPrefix}/${eventId}/assets/logos/${logoId}.png`, await lObj.arrayBuffer(), { httpMetadata: lObj.httpMetadata });
            }
            if (p.existingQrLogoKey) {
                const qObj = await Storage.get(env, p.existingQrLogoKey);
                if (qObj) {
                    qrLogoId = `qrlogo_${Date.now()}`;
                    await Storage.put(env, `${uPrefix}/${eventId}/assets/qr-logos/${qrLogoId}.png`, await qObj.arrayBuffer(), { httpMetadata: qObj.httpMetadata });
                }
            } else {
                qrLogoId = logoId;
            }
        }
        // If it DOES include the eventId, logoId and qrLogoId remain as passed
    }
    let logoUrlForQr = '';
    if (qrLogoId) {
        // FIX: Look in 'qr-logos' if it's a white-background QR logo, otherwise look in 'logos'
        const folder = qrLogoId.startsWith('qrlogo_') ? 'qr-logos' : 'logos';
        logoUrlForQr = `${cdn}/${uPrefix}/${eventId}/assets/${folder}/${qrLogoId}.png`;
    } else if (logoId) {
        logoUrlForQr = `${cdn}/${uPrefix}/${eventId}/assets/logos/${logoId}.png`;
    }

    const totalBooths = includeCommunity ? actualNumBooths + 1 : actualNumBooths;

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
                EventName: `${eventName}-Booth${i}`,
                PrinterName: preserved.PrinterName ?? null,
                CloudLink: `https://webqr.polo-booth.com/gallery?prefix=${encodeURIComponent(prefix)}`,
                MainGalleryLink: mainGalleryUrl,
                R2KeyPrefix: prefix,
                StaticBoothPreviewSeconds: preserved.StaticBoothPreviewSeconds ?? 30,
                TemplatePaths: [], IsStaticBoothMode: preserved.IsStaticBoothMode ?? false,
                StaticBoothCountdownSeconds: preserved.StaticBoothCountdownSeconds ?? 10,
                Source: eventSource
            },
            Templates: templates || []
        };

        const configKey = `${uPrefix}/${eventId}/config/Booth${i}.json`;
        await Storage.put(env, configKey, JSON.stringify(eventConfig, null, 2), { httpMetadata: { contentType: 'application/json' } });
        configKeys.push(configKey);

        const qcUrl = `https://quickchart.io/qr?size=1000&errorCorrectionLevel=H&text=${encodeURIComponent(mainGalleryUrl)}` +
            (logoUrlForQr ? `&centerImageUrl=${encodeURIComponent(logoUrlForQr + '?v=' + Date.now())}&centerImageSizeRatio=0.22` : '');

        try {
            // FIX: Pass a longer timeout signal so Cloudflare waits for QuickChart to process your logo
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds max

            const qrResp = await fetch(qcUrl, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (qrResp.ok) {
                const qrKey = `${uPrefix}/${eventId}/qr/${isCommunity ? 'Community_QRCode.png' : `Booth_${i}_QRCode.png`}`;
                await Storage.put(env, qrKey, await qrResp.arrayBuffer(), { httpMetadata: { contentType: 'image/png', cacheControl: 'no-cache' } });
                qrUrls.push(`${cdn}/${qrKey}?v=${Date.now()}`);
            } else {
                console.error("QuickChart returned error:", qrResp.status);
                qrUrls.push('');
            }
        } catch (err) {
            console.error("QR Code Generation/Upload failed:", err);
            qrUrls.push('');
        }

        appUrls.push(`${MASTER_APP_URL}?prefix=${encodeURIComponent(prefix)}&tab=${tabParam}${isCommunity ? '&isCommunity=true' : ''}${userStickers === true ? '&userStickers=true' : ''}`);
    }

    await saveEventToFirestore(env, currentUser.uid, eventId, {
        folderName, eventName, pageTitle: pageTitle || eventName, boothCount: String(actualNumBooths || boothCount || '1'),
        bgId, logoId, qrLogoId, fontColor, bgColor, logoOnMain,
        booths: appUrls.join('|'), qrUrls: qrUrls.join('|'),
        configKeys: configKeys.join('|'), boothPrefixes: boothPrefixes.join('|'),
        enableCommunity: includeCommunity, communityOnly: isOnlyCommunity,
        userStickers: userStickers === true,
        source: eventSource
    });

    // Push each booth config to the user's hotfolder so ProBooth picks it up on next sync
    // FIX: Skip pushing to hotfolder if this is a "Community Only" web event
    if (!isOnlyCommunity) {
        const userHotfolderPrefix = `users/${currentUser.uid}/hotfolder/`;
        for (const configKey of configKeys) {

            // FIX: If the event has normal booths PLUS a community booth, 
            // skip pushing the community booth config (which is always the last one)
            if (includeCommunity && configKey.endsWith(`Booth${totalBooths}.json`)) {
                continue;
            }

            try {
                const obj = await Storage.get(env, configKey);
                if (obj) {
                    const filename = configKey.split('/').pop(); // e.g. Booth1.json
                    const hotKey = `${userHotfolderPrefix}${eventId}_${filename}`;
                    await Storage.put(env, hotKey, await obj.text(), { httpMetadata: { contentType: 'application/json' } });
                }
            } catch { }
        }
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
                if (existing?.Settings?.Source && !p._existingSource) p._existingSource = existing.Settings.Source;
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
        pageTitle: f.pageTitle?.stringValue || f.eventName?.stringValue || '',
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
        source: f.source?.stringValue || 'dashboard',
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

    // Also purge any hotfolder entries for this event so ProBooth
    // won't re-sync a deleted event on its next startup.
    const hotPrefix = `users/${currentUser.uid}/hotfolder/${eventId}_`;
    const hotList = await Storage.list(env, { prefix: hotPrefix, limit: 50 });
    if (hotList.objects.length) await Storage.delete(env, hotList.objects.map(o => o.key));

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

// NEW: Consolidated asset fetcher (Supports both Global and Isolated Event folders)
async function listExistingAssets(env, body, currentUser) {
    const folder = body.kind === 'background' ? 'backgrounds' : 'logos';

    // Check if eventId is passed for isolated fetching
    const prefix = body.eventId
        ? `users/${currentUser.uid}/events/${body.eventId}/assets/${folder}/`
        : `users/${currentUser.uid}/assets/${folder}/`;

    const list = await Storage.list(env, { prefix, limit: 100 });
    const cdn = (env.PUBLIC_CDN_BASE || 'https://cdn.polo-booth.com').replace(/\/$/, '');

    const assets = list.objects
        .filter(o => !o.key.split('/').pop().startsWith('.'))
        .map(o => {
            const id = o.key.replace(prefix, '').replace(/\.[^.]+$/, '');
            return {
                id,
                key: o.key, // Send the explicit storage key so it can be deleted
                name: o.key.split('/').pop(),
                url: `${cdn}/${o.key}?w=150`,
                uploadedAt: o.uploaded
            };
        })
        .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)); // Newest first

    return { success: true, assets };
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

        // Changed "egm" to "evt"
        return { success: true, eventId: 'evt' + String(parseInt(doc.fields?.currentId?.integerValue || '1', 10)).padStart(4, '0') };
    } catch (err) {
        // Changed "egm" to "evt"
        return { success: true, eventId: 'evt' + Math.floor(10000 + Math.random() * 90000), fallback: true };
    }
}

async function saveEventToFirestore(env, uid, eventId, data) {
    const serviceToken = await getServiceToken(env);
    const payload = {
        fields: {
            folderName: { stringValue: data.folderName || '' },
            eventName: { stringValue: data.eventName || '' },
            pageTitle: { stringValue: data.pageTitle || data.eventName || '' },
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
            source: { stringValue: data.source || 'dashboard' },
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

// ── EVENT NAME UNIQUENESS CHECK ──────────────────────────────────────
async function checkEventNameUnique(env, body, currentUser) {
    const { eventName, excludeEventId } = body;
    if (!eventName) return { success: false, error: 'eventName required' };

    const serviceToken = await getServiceToken(env);
    const listUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${currentUser.uid}/events?pageSize=200`;
    const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${serviceToken}` } });
    if (!res.ok) return { success: true, unique: true }; // fail open

    const data = await res.json();
    const docs = data.documents || [];
    const conflict = docs.find(doc => {
        const docId = doc.name.split('/').pop();
        if (excludeEventId && docId === excludeEventId) return false;
        const name = doc.fields?.eventName?.stringValue || '';
        return name.trim().toLowerCase() === eventName.trim().toLowerCase();
    });

    return { success: true, unique: !conflict };
}

// ── EVENT NAME RENAME (push to Firestore + hotfolder) ────────────────
// Called when a dashboard user changes only the Event Name in Edit Setup.
// Updates Firestore and pushes a lightweight rename marker to the hotfolder
// so ProBooth can update the event name on its side on next sync.
async function renameEventName(env, body, currentUser) {
    const { eventId, newEventName } = body;
    if (!eventId || !newEventName) return { success: false, error: 'eventId and newEventName required' };

    // 1. Update eventName in Firestore
    const serviceToken = await getServiceToken(env);
    const fsUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${currentUser.uid}/events/${eventId}?updateMask.fieldPaths=eventName`;
    const fsRes = await fetch(fsUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { eventName: { stringValue: newEventName } } })
    });
    if (!fsRes.ok) return { success: false, error: `Firestore error ${fsRes.status}` };

    // 2. Push a rename marker to the hotfolder so ProBooth picks it up on next startup sync.
    //    We patch all existing booth config files to carry the new EventName.
    const uPrefix = `users/${currentUser.uid}/events/${eventId}/config`;
    const configList = await Storage.list(env, { prefix: uPrefix + '/', limit: 20 });
    const hotPrefix = `users/${currentUser.uid}/hotfolder/`;

    for (const obj of configList.objects) {
        if (!obj.key.endsWith('.json')) continue;
        try {
            const r2obj = await Storage.get(env, obj.key);
            if (!r2obj) continue;
            const pkg = JSON.parse(await r2obj.text());
            if (pkg?.Settings) {
                // Update EventName in the config JSON (keeps the -BoothN suffix pattern)
                const oldName = pkg.Settings.EventName || '';
                const boothSuffix = oldName.match(/-Booth\d+$/)?.[0] || '';
                pkg.Settings.EventName = `${newEventName}${boothSuffix}`;
                const updated = JSON.stringify(pkg, null, 2);
                // Overwrite the R2 config
                await Storage.put(env, obj.key, updated, { httpMetadata: { contentType: 'application/json' } });
                // Push to hotfolder
                const filename = obj.key.split('/').pop();
                await Storage.put(env, `${hotPrefix}${eventId}_${filename}`, updated, { httpMetadata: { contentType: 'application/json' } });
            }
        } catch { }
    }

    return { success: true };
}

async function saveSystemPinToFirestore(env, pin, currentUser) {
    const serviceToken = await getServiceToken(env);

    // Point to the user's document and apply an updateMask so we don't accidentally overwrite their account tier!
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${currentUser.uid}?updateMask.fieldPaths=pin`;

    const res = await fetch(url, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { pin: { stringValue: pin } } })
    });

    if (!res.ok) return { success: false, error: `Firestore Error ${res.status}: ${await res.text()}` };
    return { success: true, message: 'System pin updated for user profile.' };
}