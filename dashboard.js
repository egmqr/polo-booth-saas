// dashboard.js

import { Storage } from './cloud.js';
import { json, decodeBase64, safePrefix } from './util.js';
import { verifyFirebaseToken, getServiceToken } from './auth.js';
import { putHotfolderTargets } from './hotfolder.js';

// ── AUTH HELPER ───────────────────────────────────────────────────────
async function authenticate(request, env) {
    const token = (request.headers.get('authorization') || '').replace('Bearer ', '');
    return await verifyFirebaseToken(env, token); // throws if invalid
}

function normalizeInviteCode(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/\s+/g, '')
        .toUpperCase();
}

async function findInviteCode(fsBase, serviceToken, submittedCode) {
    const rawCode = String(submittedCode || '').trim();
    const normalizedCode = normalizeInviteCode(rawCode);
    const candidates = [...new Set([rawCode, normalizedCode].filter(Boolean))];

    for (const candidate of candidates) {
        const codeUrl = `${fsBase}/invite_codes/${encodeURIComponent(candidate)}`;
        const res = await fetch(codeUrl, { headers: { Authorization: `Bearer ${serviceToken}` } });
        if (res.ok) return { codeUrl, codeDoc: await res.json() };
        if (res.status !== 404) return { errorStatus: res.status, errorBody: await res.text() };
    }

    // Firestore document IDs are case-sensitive. Fall back to a normalized scan so
    // codes copied with different casing, Unicode dashes, or invisible spaces work.
    let pageToken = '';
    do {
        const listUrl = new URL(`${fsBase}/invite_codes`);
        listUrl.searchParams.set('pageSize', '500');
        if (pageToken) listUrl.searchParams.set('pageToken', pageToken);

        const res = await fetch(listUrl.toString(), { headers: { Authorization: `Bearer ${serviceToken}` } });
        if (!res.ok) return { errorStatus: res.status, errorBody: await res.text() };

        const data = await res.json();
        const match = (data.documents || []).find(doc => {
            const storedCode = doc.name.split('/').pop() || '';
            return normalizeInviteCode(storedCode) === normalizedCode;
        });
        if (match) {
            const storedCode = match.name.split('/').pop();
            return {
                codeUrl: `${fsBase}/invite_codes/${encodeURIComponent(storedCode)}`,
                codeDoc: match
            };
        }

        pageToken = data.nextPageToken || '';
    } while (pageToken);

    return null;
}

// ── TIER HELPER ───────────────────────────────────────────────────────
async function getUserTier(env, uid) {
    const serviceToken = await getServiceToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${serviceToken}` } });
    if (!res.ok) return 'free';

    const doc = await res.json();
    let tier = doc.fields?.tier?.stringValue || 'free';
    const status = doc.fields?.status?.stringValue || 'active';
    const expiresAt = doc.fields?.expiresAt?.timestampValue;

    if (status === 'suspended' || status === 'disabled') {
        return 'blocked';
    }

    // ENFORCEMENT: If they are marked paid but the date has passed, force 'free'
    if (tier === 'paid' && expiresAt) {
        if (new Date() > new Date(expiresAt)) {
            tier = 'free';
        }
    }

    return tier;
}

async function getUserAccess(env, uid) {
    const serviceToken = await getServiceToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${serviceToken}` } });
    if (res.status === 404) return { ok: true, status: 'active' };
    if (!res.ok) return { ok: true, status: 'active' };

    const doc = await res.json();
    const status = doc.fields?.status?.stringValue || 'active';
    const reason = doc.fields?.suspensionReason?.stringValue || '';
    return {
        ok: status !== 'suspended' && status !== 'disabled',
        status,
        reason
    };
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

        if (!normalizeInviteCode(inviteCode)) return json({ success: false, error: 'Invite code is required.' }, 400);

        // 1. Verify the invite code in Firestore
        const inviteLookup = await findInviteCode(fsBase, serviceToken, inviteCode);
        if (!inviteLookup) {
            return json({ success: false, error: 'Invalid invite code.' }, 400);
        }
        if (inviteLookup.errorStatus) {
            console.error('Invite code lookup failed:', inviteLookup.errorStatus, inviteLookup.errorBody);
            return json({ success: false, error: 'Invite code verification is temporarily unavailable. Please try again.' }, 503);
        }

        const { codeUrl, codeDoc } = inviteLookup;
        const isUsed = codeDoc.fields?.used?.booleanValue;
        const isMultiUse = codeDoc.fields?.isMultiUse?.booleanValue;
        const expiresAt = codeDoc.fields?.expiresAt?.timestampValue;
        const isRevoked = codeDoc.fields?.revoked?.booleanValue;
        const inviteTier = codeDoc.fields?.tier?.stringValue || 'paid';
        const maxUses = parseInt(codeDoc.fields?.maxUses?.integerValue || '0', 10);
        const useCount = parseInt(codeDoc.fields?.useCount?.integerValue || '0', 10);

        if (isRevoked) {
            return json({ success: false, error: 'This invite code has been revoked.' }, 400);
        }

        if (isMultiUse) {
            // Validate expiration for multi-use codes
            if (expiresAt && new Date() > new Date(expiresAt)) {
                return json({ success: false, error: 'This invite code has expired.' }, 400);
            }
            if (maxUses > 0 && useCount >= maxUses) {
                return json({ success: false, error: 'This invite code has reached its usage limit.' }, 400);
            }
            await fetch(`${codeUrl}?updateMask.fieldPaths=useCount&updateMask.fieldPaths=lastUsedAt&updateMask.fieldPaths=lastUsedBy`, {
                method: 'PATCH',
                headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        useCount: { integerValue: String(useCount + 1) },
                        lastUsedAt: { timestampValue: new Date().toISOString() },
                        lastUsedBy: { stringValue: user.uid }
                    }
                })
            });
            // Note: We skip the PATCH request below so it remains usable.
        } else {
            // Standard single-use logic
            if (isUsed) {
                return json({ success: false, error: 'This invite code has already been used.' }, 400);
            }

            // 2. Mark the single-use code as used
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
        }

        // 3. Provision the user
        const docUrl = `${fsBase}/users/${user.uid}`;
        const existing = await fetch(docUrl, { headers: { Authorization: `Bearer ${serviceToken}` } });
        if (existing.ok) {
            const doc = await existing.json();
            if (doc.fields) {
                const status = doc.fields.status?.stringValue || 'active';
                if (status === 'suspended' || status === 'disabled') {
                    return json({
                        success: false,
                        error: doc.fields.suspensionReason?.stringValue || 'This account is not currently active.'
                    }, 403);
                }
                return json({ success: true, tier: doc.fields.tier?.stringValue || 'free' });
            }
        }

        await fetch(docUrl, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    email: { stringValue: user.email },
                    tier: { stringValue: inviteTier === 'free' ? 'free' : 'paid' },
                    status: { stringValue: 'active' },
                    role: { stringValue: 'owner' },
                    createdAt: { timestampValue: new Date().toISOString() },
                    updatedAt: { timestampValue: new Date().toISOString() },
                    pin: { stringValue: '0000' },
                    note: { stringValue: '' },
                    inviteCode: { stringValue: codeDoc.name.split('/').pop() || '' }
                }
            })
        });
        return json({ success: true, tier: inviteTier === 'free' ? 'free' : 'paid' });
    }

    // GET /api/user/profile — called on every login
    if (path === '/api/user/profile') {
        const docUrl = `${fsBase}/users/${user.uid}`;
        const res = await fetch(docUrl, { headers: { Authorization: `Bearer ${serviceToken}` } });
        if (!res.ok) return json({ uid: user.uid, email: user.email, tier: 'free' });

        const doc = await res.json();
        const f = doc.fields || {};
        const status = f.status?.stringValue || 'active';
        if (status === 'suspended' || status === 'disabled') {
            return json({
                success: false,
                error: f.suspensionReason?.stringValue || 'This account is not currently active.'
            }, 403);
        }

        let tier = f.tier?.stringValue || 'free';
        const expiresAt = f.expiresAt?.timestampValue;

        // Force to free on the frontend if expired
        if (tier === 'paid' && expiresAt) {
            if (new Date() > new Date(expiresAt)) {
                tier = 'free';
            }
        }

        return json({
            uid: user.uid,
            email: user.email,
            tier: tier, // <-- Pass the evaluated tier here
            status,
            role: f.role?.stringValue || 'owner',
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

    const access = await getUserAccess(env, currentUser.uid);
    if (!access.ok) {
        return json({
            success: false,
            error: access.reason || 'This account is not currently active.'
        }, 403);
    }

    const body = await request.json();

    if (path === '/api/next-event-id') return json(await mintNextEventId(env));
    if (path === '/api/dashboard/check-event-name') return json(await checkEventNameUnique(env, body, currentUser));
    if (path === '/api/dashboard/generate-booth') return json(await generateBoothSetup(env, body, currentUser));
    if (path === '/api/dashboard/update-booth') return json(await updateBoothSetup(env, body, currentUser));
    if (path === '/api/dashboard/rename-event') return json(await renameEventName(env, body, currentUser));
    if (path === '/api/dashboard/sync-config-templates') return json(await syncConfigTemplates(env, body, currentUser));
    if (path === '/api/dashboard/booth-details') return json(await getBoothDetails(env, body.eventId, currentUser, { includeTemplates: body.includeTemplates !== false }));
    if (path === '/api/dashboard/delete-booth') return json(await deleteBoothEvent(env, body.eventId, currentUser));
    if (path === '/api/dashboard/existing-assets') return json(await listExistingAssets(env, body, currentUser));
    if (path === '/api/dashboard/existing-assets-both') {
        const [bgRes, logoRes] = await Promise.all([
            listExistingAssets(env, { kind: 'background', eventId: body.eventId }, currentUser),
            listExistingAssets(env, { kind: 'logo', eventId: body.eventId }, currentUser)
        ]);
        return json({ success: true, bg: bgRes.assets, logo: logoRes.assets });
    }
    if (path === '/api/dashboard/upload-asset') return json(await uploadAsset(env, body, currentUser));
    if (path === '/api/sign-upload') return json(await handleSignedUpload(env, body, currentUser));

    if (path === '/api/dashboard/update-pin') {
        if (!body.pin) return json({ success: false, error: 'No pin provided' }, 400);
        // FIX: Pass currentUser into the function so it knows whose profile to update
        return json(await saveSystemPinToFirestore(env, body.pin, currentUser));
    }
    if (path === '/api/dashboard/download-file') {
        if (!body.key) return json({ success: false, error: 'No key provided' }, 400);
        if (!body.key.startsWith(`users/${currentUser.uid}/`)) {
            return json({ success: false, error: 'Forbidden' }, 403);
        }

        try {
            const obj = await Storage.get(env, body.key);
            if (!obj) return json({ success: false, error: 'File not found' }, 404);

            const headers = new Headers();
            headers.set('content-type', obj.httpMetadata?.contentType || 'application/octet-stream');
            headers.set('cache-control', 'no-store');
            return new Response(obj.body, { headers });
        } catch (err) {
            return json({ success: false, error: err.message }, 500);
        }
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

    const {
        eventId, folderName, eventName, pageTitle, boothCount,
        logoData, qrLogoData, existingLogoId, existingQrLogoId, existingBgId,
        fontColor, bgColor, logoOnMain, templates,
        enableCommunity, communityOnly, userStickers,
        showSearchBar, showTime, customTerm, source
    } = p;
    // Origin marker: 'probooth' events have templates locked on the web dashboard.
    const eventSource = (source === 'probooth') ? 'probooth' : (p._existingSource || 'dashboard');

    const isOnlyCommunity = communityOnly === true;
    const includeCommunity = enableCommunity === true || isOnlyCommunity;
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

    // Pre-compute all non-community booth prefixes so every booth config
    // carries the full list. ProBooth can then register all booths from
    // whichever config file it processes first.
    const allBoothPrefixes = [];
    for (let i = 1; i <= totalBooths; i++) {
        const isCommunity = includeCommunity && i === totalBooths;
        if (!isCommunity) allBoothPrefixes.push(`${uPrefix}/${eventId}/booth-${i}/prints`);
    }

    const boothResults = await Promise.all(Array.from({ length: totalBooths }, async (_, index) => {
        const i = index + 1;
        const isCommunity = includeCommunity && i === totalBooths;
        const tabParam = i.toString();
        const prefix = isCommunity ? `${uPrefix}/${eventId}/community` : `${uPrefix}/${eventId}/booth-${i}/prints`;

        const mainGalleryUrl = `${NETLIFY_BASE_URL}?id=${eventId}&uid=${currentUser.uid}&tab=${tabParam}${isCommunity ? '&isCommunity=true' : ''}`;
        const preserved = p._existingBoothSettings?.[i] || {};

        const eventConfig = {
            Settings: {
                EventId: eventId,
                BoothCount: totalBooths,
                EventName: `${eventName}-Booth${i}`,
                PrinterName: preserved.PrinterName ?? '',
                CloudLink: `https://webqr.polo-booth.com/gallery?prefix=${encodeURIComponent(prefix)}`,
                MainGalleryLink: mainGalleryUrl,
                R2KeyPrefix: prefix,
                // All non-community booth prefixes — present in every booth config
                // so ProBooth gets the full list regardless of sync order.
                AllBoothPrefixes: allBoothPrefixes,
                StaticBoothPreviewSeconds: preserved.StaticBoothPreviewSeconds ?? 30,
                TemplatePaths: [], IsStaticBoothMode: preserved.IsStaticBoothMode ?? false,
                StaticBoothCountdownSeconds: preserved.StaticBoothCountdownSeconds ?? 10,
                Source: eventSource
            },
            Templates: templates || []
        };

        const configKey = `${uPrefix}/${eventId}/config/Booth${i}.json`;
        const configText = JSON.stringify(eventConfig, null, 2);
        const configWrite = Storage.put(env, configKey, configText, { httpMetadata: { contentType: 'application/json' } });

        const qcUrl = `https://quickchart.io/qr?size=1000&errorCorrectionLevel=H&text=${encodeURIComponent(mainGalleryUrl)}` +
            (logoUrlForQr ? `&centerImageUrl=${encodeURIComponent(logoUrlForQr + '?v=' + Date.now())}&centerImageSizeRatio=0.22` : '');

        let qrUrl = '';
        const qrWrite = (async () => {
            try {
            // FIX: Pass a longer timeout signal so Cloudflare waits for QuickChart to process your logo
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 seconds max

                const qrResp = await fetch(qcUrl, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (qrResp.ok) {
                    const qrKey = `${uPrefix}/${eventId}/qr/${isCommunity ? 'Community_QRCode.png' : `Booth_${i}_QRCode.png`}`;
                    await Storage.put(env, qrKey, await qrResp.arrayBuffer(), { httpMetadata: { contentType: 'image/png', cacheControl: 'no-cache' } });
                    qrUrl = `${cdn}/${qrKey}?v=${Date.now()}`;
                } else {
                    console.error("QuickChart returned error:", qrResp.status);
                }
            } catch (err) {
                console.error("QR Code Generation/Upload failed:", err);
            }
        })();

        await Promise.all([configWrite, qrWrite]);
        return {
            isCommunity,
            prefix,
            configKey,
            configText,
            qrUrl,
            appUrl: `${MASTER_APP_URL}?prefix=${encodeURIComponent(prefix)}&tab=${tabParam}${isCommunity ? '&isCommunity=true' : ''}${userStickers === true ? '&userStickers=true' : ''}`
        };
    }));

    const boothPrefixes = boothResults.map(booth => booth.prefix);
    const qrUrls = boothResults.map(booth => booth.qrUrl);
    const appUrls = boothResults.map(booth => booth.appUrl);
    const configKeys = boothResults.map(booth => booth.configKey);

    const gallerySettings = {
        showSearchBar: showSearchBar !== false,
        showTime: showTime !== false,
        customTerm: customTerm || ''
    };

    await saveEventToFirestore(env, currentUser.uid, eventId, {
        folderName, eventName, pageTitle: pageTitle || eventName, boothCount: String(actualNumBooths || boothCount || '1'),
        bgId, logoId, qrLogoId, fontColor, bgColor, logoOnMain,
        booths: appUrls.join('|'), qrUrls: qrUrls.join('|'),
        configKeys: configKeys.join('|'), boothPrefixes: boothPrefixes.join('|'),
        enableCommunity: includeCommunity, communityOnly: isOnlyCommunity,
        userStickers: userStickers === true,
        ...gallerySettings,
        source: eventSource
    });

    // Push each booth config to the user's hotfolder so ProBooth picks it up on next sync
    // FIX: Skip pushing to hotfolder if this is a "Community Only" web event
    if (!isOnlyCommunity) {
        await Promise.all(boothResults
            .filter(booth => !booth.isCommunity)
            .map(async booth => {
                try {
                    const filename = booth.configKey.split('/').pop(); // e.g. Booth1.json
                    await putHotfolderTargets(env, currentUser.uid, `${eventId}_${filename}`, booth.configText);
                } catch { }
            }));
    }

    return {
        success: true,
        message: 'Generated successfully!',
        gallerySettings,
        details: {
            success: true,
            id: eventId,
            folderName,
            eventName,
            pageTitle: pageTitle || eventName,
            boothCount: String(actualNumBooths || boothCount || '1'),
            bgId,
            logoId,
            qrLogoId,
            fontColor,
            bgColor,
            logoOnMain: logoOnMain === true,
            userStickers: userStickers === true,
            showSearchBar: gallerySettings.showSearchBar,
            showTime: gallerySettings.showTime,
            customTerm: gallerySettings.customTerm,
            boothsStr: appUrls.join('|'),
            qrUrlsStr: qrUrls.join('|'),
            configKeysStr: configKeys.join('|'),
            boothPrefixesStr: boothPrefixes.join('|'),
            enableCommunity: includeCommunity,
            communityOnly: isOnlyCommunity,
            source: eventSource,
            templatesStr: ''
        }
    };
}

async function updateBoothSetup(env, p, currentUser) {
    const uPrefix = `users/${currentUser.uid}/events`;
    const actualNumBooths = p.communityOnly === true ? 0 : (parseInt(p.boothCount, 10) || 1);
    const totalBooths = (p.enableCommunity === true || p.communityOnly === true) ? actualNumBooths + 1 : actualNumBooths;

    const existingSettings = {};
    let latestTemplates = p.templates || [];   // start with what the dashboard sent

    await Promise.all(Array.from({ length: totalBooths }, async (_, index) => {
        const i = index + 1;
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

                // Always pull the latest Templates from R2 for the first non-community booth.
                // ProBooth is the owner of templates for probooth-source events; the dashboard
                // must carry them forward unchanged. For dashboard-source events this still
                // ensures the R2 config is the source of truth if the frontend sent an empty list.
                if (i === 1 && Array.isArray(existing?.Templates) && existing.Templates.length > 0) {
                    // Prefer R2 templates if:
                    //   a) the source is probooth (ProBooth owns templates), OR
                    //   b) the dashboard sent no templates (empty/null)
                    const isProbooth = (existing?.Settings?.Source === 'probooth') || (p._existingSource === 'probooth');
                    if (isProbooth || !latestTemplates.length) {
                        latestTemplates = existing.Templates;
                    }
                }
            }
        } catch { }
    }));

    p._existingBoothSettings = existingSettings;
    p.templates = latestTemplates;   // ensure generate uses the authoritative template list
    return generateBoothSetup(env, p, currentUser, true);
}

async function getBoothDetails(env, eventId, currentUser, options = {}) {
    const serviceToken = await getServiceToken(env);
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${currentUser.uid}/events/${eventId}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${serviceToken}` } });
    if (!res.ok) return { success: false, error: 'Firebase fetch error' };
    const doc = await res.json();
    const f = doc.fields || {};

    let templates = [];
    if (options.includeTemplates !== false) {
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
        showSearchBar: f.showSearchBar?.booleanValue ?? true,
        showTime: f.showTime?.booleanValue ?? true,
        customTerm: f.customTerm?.stringValue || '',
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

    // Purge any existing hotfolder entries for this event (stale booth configs).
    for (const client of ['v3', 'android']) {
        const hotPrefix = `users/${currentUser.uid}/hotfolder/${client}/${eventId}_`;
        const hotList = await Storage.list(env, { prefix: hotPrefix, limit: 50 });
        if (hotList.objects.length) await Storage.delete(env, hotList.objects.map(o => o.key));
    }

    // Write a deletion tombstone so ProBooth removes its local folders on next sync.
    // Pattern: {eventId}_deleted.json — ProBooth's Pass 1 detects and processes these.
    await putHotfolderTargets(env, currentUser.uid, `${eventId}_deleted.json`, JSON.stringify({ deleted: true, eventId }));

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
            showSearchBar: { booleanValue: data.showSearchBar !== false },
            showTime: { booleanValue: data.showTime !== false },
            customTerm: { stringValue: data.customTerm || '' },
            source: { stringValue: data.source || 'dashboard' },
            timestamp: { timestampValue: new Date().toISOString() }
        }
    };
    const updateMaskPaths = Object.keys(payload.fields)
        .map(k => `updateMask.fieldPaths=${k}`).join('&');
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}/events/${eventId}?${updateMaskPaths}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: {
            Authorization: `Bearer ${serviceToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        throw new Error(`Firestore event save failed (${res.status}): ${await res.text()}`);
    }
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

    // 1. Update eventName/folderName in Firestore. folderName is the legacy display
    // source for booth card labels, so keep it aligned with the visible event name.
    const serviceToken = await getServiceToken(env);
    const fsUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${currentUser.uid}/events/${eventId}?updateMask.fieldPaths=eventName&updateMask.fieldPaths=folderName`;
    const fsRes = await fetch(fsUrl, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { eventName: { stringValue: newEventName }, folderName: { stringValue: newEventName } } })
    });
    if (!fsRes.ok) return { success: false, error: `Firestore error ${fsRes.status}` };

    // 2. Push a rename marker to the hotfolder so ProBooth picks it up on next startup sync.
    //    We patch all existing booth config files to carry the new EventName.
    const uPrefix = `users/${currentUser.uid}/events/${eventId}/config`;
    const configList = await Storage.list(env, { prefix: uPrefix + '/', limit: 20 });
    await Promise.all(configList.objects.map(async obj => {
        if (!obj.key.endsWith('.json')) return;
        try {
            const r2obj = await Storage.get(env, obj.key);
            if (!r2obj) return;
            const pkg = JSON.parse(await r2obj.text());
            if (pkg?.Settings) {
                // Skip the community booth — its R2KeyPrefix contains '/community'
                // and ProBooth doesn't need a hotfolder entry for it.
                if ((pkg.Settings.R2KeyPrefix || '').includes('/community')) return;

                // Update EventName in the config JSON (keeps the -BoothN suffix pattern)
                const oldName = pkg.Settings.EventName || '';
                const boothSuffix = oldName.match(/-Booth\d+$/)?.[0] || '';
                pkg.Settings.EventName = `${newEventName}${boothSuffix}`;
                const updated = JSON.stringify(pkg, null, 2);
                // Overwrite the R2 config
                await Storage.put(env, obj.key, updated, { httpMetadata: { contentType: 'application/json' } });
                // Push to hotfolder
                const filename = obj.key.split('/').pop();
                await putHotfolderTargets(env, currentUser.uid, `${eventId}_${filename}`, updated);
            }
        } catch { }
    }));

    return { success: true };
}

async function syncConfigTemplates(env, body, currentUser) {
    const { eventId, templates } = body;
    if (!eventId || !Array.isArray(templates)) {
        return { success: false, error: 'eventId and templates array required' };
    }

    const configPrefix = `users/${currentUser.uid}/events/${eventId}/config/`;
    let cursor;
    let updatedCount = 0;
    let hotfolderCount = 0;

    do {
        const page = await Storage.list(env, { prefix: configPrefix, limit: 1000, cursor });
        await Promise.all((page.objects || []).map(async obj => {
            if (!obj.key.endsWith('.json')) return;

            try {
                const r2obj = await Storage.get(env, obj.key);
                if (!r2obj) return;

                const pkg = JSON.parse(await r2obj.text());
                pkg.Templates = templates;

                const updated = JSON.stringify(pkg, null, 2);
                await Storage.put(env, obj.key, updated, { httpMetadata: { contentType: 'application/json' } });
                updatedCount++;

                const eventName = pkg?.Settings?.EventName || '';
                const r2Prefix = pkg?.Settings?.R2KeyPrefix || '';
                const isVirtualBooth = eventName.includes('-VirtualBooth') || r2Prefix.includes('/virtual');
                const isCommunity = r2Prefix.includes('/community');
                const filename = obj.key.split('/').pop();

                if (!isVirtualBooth && !isCommunity && /^Booth\d+\.json$/i.test(filename)) {
                    await putHotfolderTargets(env, currentUser.uid, `${eventId}_${filename}`, updated);
                    hotfolderCount++;
                }
            } catch { }
        }));

        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    return { success: true, updatedCount, hotfolderCount };
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
