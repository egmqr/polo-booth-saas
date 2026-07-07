// admin.js

import { getServiceToken } from './auth.js';
import { json } from './util.js';

const ADMIN_PAGE_LIMIT = 500;

function docId(doc) {
    return decodeURIComponent((doc.name || '').split('/').pop() || '');
}

function readString(fields, key, fallback = '') {
    const value = fields?.[key];
    if (!value) return fallback;
    if ('stringValue' in value) return value.stringValue;
    if ('timestampValue' in value) return value.timestampValue;
    if ('integerValue' in value) return String(value.integerValue);
    if ('booleanValue' in value) return value.booleanValue ? 'true' : 'false';
    return fallback;
}

function readBoolean(fields, key, fallback = false) {
    const value = fields?.[key];
    return value && 'booleanValue' in value ? value.booleanValue : fallback;
}

function readInt(fields, key, fallback = 0) {
    const value = fields?.[key];
    if (!value) return fallback;
    const raw = value.integerValue ?? value.stringValue;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanStatus(status) {
    return ['active', 'suspended', 'disabled'].includes(status) ? status : 'active';
}

function cleanRole(role) {
    return ['owner', 'admin', 'member', 'viewer'].includes(role) ? role : 'owner';
}

function cleanTier(tier) {
    return ['free', 'paid'].includes(tier) ? tier : 'free';
}

function normalizeCode(value) {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/\s+/g, '')
        .toUpperCase();
}

function randomInviteCode() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return [...bytes]
        .map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32])
        .join('')
        .replace(/(.{4})/g, '$1-')
        .replace(/-$/, '');
}

function isoOrEmpty(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function userFromDoc(doc) {
    const f = doc.fields || {};
    const tier = cleanTier(readString(f, 'tier', 'free'));
    const expiresAt = readString(f, 'expiresAt', '');
    const effectiveTier = tier === 'paid' && expiresAt && new Date() > new Date(expiresAt) ? 'free' : tier;

    return {
        uid: docId(doc),
        email: readString(f, 'email'),
        tier,
        effectiveTier,
        status: cleanStatus(readString(f, 'status', 'active')),
        role: cleanRole(readString(f, 'role', 'owner')),
        createdAt: readString(f, 'createdAt'),
        updatedAt: readString(f, 'updatedAt'),
        lastAdminActionAt: readString(f, 'lastAdminActionAt'),
        expiresAt,
        note: readString(f, 'note'),
        suspensionReason: readString(f, 'suspensionReason'),
        accountName: readString(f, 'accountName'),
        inviteCode: readString(f, 'inviteCode'),
        pin: readString(f, 'pin'),
        seatLimit: readInt(f, 'seatLimit', 1)
    };
}

function inviteFromDoc(doc) {
    const f = doc.fields || {};
    const expiresAt = readString(f, 'expiresAt');
    const revoked = readBoolean(f, 'revoked', false);
    const isMultiUse = readBoolean(f, 'isMultiUse', false);
    const used = readBoolean(f, 'used', false);
    const expired = Boolean(expiresAt && new Date() > new Date(expiresAt));

    return {
        code: docId(doc),
        used,
        usedBy: readString(f, 'usedBy'),
        createdAt: readString(f, 'createdAt'),
        createdBy: readString(f, 'createdBy'),
        updatedAt: readString(f, 'updatedAt'),
        isMultiUse,
        expiresAt,
        expired,
        revoked,
        revokedAt: readString(f, 'revokedAt'),
        lastUsedAt: readString(f, 'lastUsedAt'),
        lastUsedBy: readString(f, 'lastUsedBy'),
        tier: cleanTier(readString(f, 'tier', 'paid')),
        note: readString(f, 'note'),
        maxUses: readInt(f, 'maxUses', 0),
        useCount: readInt(f, 'useCount', 0),
        usable: !revoked && !expired && (isMultiUse || !used)
    };
}

async function listCollection(fsBase, serviceToken, collection, pageSize, pageToken = '') {
    const url = new URL(`${fsBase}/${collection}`);
    url.searchParams.set('pageSize', String(Math.min(Math.max(pageSize || 100, 1), ADMIN_PAGE_LIMIT)));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${serviceToken}` } });
    if (!res.ok) throw new Error(`Firestore list failed (${res.status}): ${await res.text()}`);
    return await res.json();
}

async function getFirestoreDoc(fsBase, serviceToken, path) {
    const res = await fetch(`${fsBase}/${path}`, { headers: { Authorization: `Bearer ${serviceToken}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore get failed (${res.status}): ${await res.text()}`);
    return await res.json();
}

async function patchFirestoreDoc(fsBase, serviceToken, path, fields) {
    const updateMask = Object.keys(fields)
        .map(key => `updateMask.fieldPaths=${encodeURIComponent(key)}`)
        .join('&');

    const res = await fetch(`${fsBase}/${path}?${updateMask}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
    });
    if (!res.ok) throw new Error(`Firestore update failed (${res.status}): ${await res.text()}`);
    return await res.json();
}

async function deleteFirestoreDoc(fsBase, serviceToken, path) {
    const res = await fetch(`${fsBase}/${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${serviceToken}` }
    });
    if (!res.ok && res.status !== 404) throw new Error(`Firestore delete failed (${res.status}): ${await res.text()}`);
}

async function countUserEvents(fsBase, serviceToken, uid) {
    const data = await listCollection(fsBase, serviceToken, `users/${encodeURIComponent(uid)}/events`, 200);
    return (data.documents || []).length;
}

async function listUserEvents(fsBase, serviceToken, uid) {
    const data = await listCollection(fsBase, serviceToken, `users/${encodeURIComponent(uid)}/events`, 200);
    return (data.documents || []).map(doc => {
        const f = doc.fields || {};
        return {
            id: docId(doc),
            eventName: readString(f, 'eventName') || readString(f, 'folderName') || docId(doc),
            boothCount: readString(f, 'boothCount'),
            source: readString(f, 'source', 'dashboard'),
            timestamp: readString(f, 'timestamp')
        };
    }).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

async function readAll(fsBase, serviceToken, collection, mapper) {
    const out = [];
    let pageToken = '';
    do {
        const data = await listCollection(fsBase, serviceToken, collection, ADMIN_PAGE_LIMIT, pageToken);
        out.push(...(data.documents || []).map(mapper));
        pageToken = data.nextPageToken || '';
    } while (pageToken);
    return out;
}

function buildUserFields(body, now) {
    const fields = { updatedAt: { timestampValue: now }, lastAdminActionAt: { timestampValue: now } };

    if ('tier' in body) fields.tier = { stringValue: cleanTier(body.tier) };
    if ('status' in body) fields.status = { stringValue: cleanStatus(body.status) };
    if ('role' in body) fields.role = { stringValue: cleanRole(body.role) };
    if ('note' in body) fields.note = { stringValue: String(body.note || '').slice(0, 1000) };
    if ('suspensionReason' in body) fields.suspensionReason = { stringValue: String(body.suspensionReason || '').slice(0, 500) };
    if ('accountName' in body) fields.accountName = { stringValue: String(body.accountName || '').slice(0, 160) };
    if ('pin' in body) fields.pin = { stringValue: String(body.pin || '').slice(0, 32) };
    if ('seatLimit' in body) fields.seatLimit = { integerValue: String(Math.max(parseInt(body.seatLimit, 10) || 1, 1)) };

    if ('expiresAt' in body) {
        const expiresAt = isoOrEmpty(body.expiresAt);
        fields.expiresAt = expiresAt ? { timestampValue: expiresAt } : { nullValue: null };
    } else if (body.tier === 'paid' && body.extendOneYear === true) {
        const date = new Date();
        date.setFullYear(date.getFullYear() + 1);
        fields.expiresAt = { timestampValue: date.toISOString() };
    } else if (body.tier === 'free') {
        fields.expiresAt = { nullValue: null };
    }

    if (body.status === 'suspended') fields.suspendedAt = { timestampValue: now };
    if (body.status === 'active' || body.status === 'disabled') fields.suspendedAt = { nullValue: null };

    return fields;
}

export async function handleAdminRoutes(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret'
            }
        });
    }

    if (request.headers.get('x-admin-secret') !== env.ADMIN_SECRET) {
        return json({ success: false, error: 'Forbidden' }, 403);
    }

    const serviceToken = await getServiceToken(env);
    const fsBase = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

    if (path === '/api/admin/summary' && request.method === 'GET') {
        const [users, invites] = await Promise.all([
            readAll(fsBase, serviceToken, 'users', userFromDoc),
            readAll(fsBase, serviceToken, 'invite_codes', inviteFromDoc)
        ]);

        return json({
            success: true,
            summary: {
                users: {
                    total: users.length,
                    paid: users.filter(u => u.effectiveTier === 'paid').length,
                    free: users.filter(u => u.effectiveTier !== 'paid').length,
                    suspended: users.filter(u => u.status === 'suspended' || u.status === 'disabled').length,
                    expiring30d: users.filter(u => {
                        if (u.effectiveTier !== 'paid' || !u.expiresAt) return false;
                        const ms = new Date(u.expiresAt) - new Date();
                        return ms >= 0 && ms <= 30 * 24 * 60 * 60 * 1000;
                    }).length
                },
                invites: {
                    total: invites.length,
                    usable: invites.filter(i => i.usable).length,
                    used: invites.filter(i => i.used).length,
                    revoked: invites.filter(i => i.revoked).length
                }
            }
        });
    }

    if (path === '/api/admin/users' && request.method === 'GET') {
        const pageSize = parseInt(url.searchParams.get('pageSize') || '150', 10);
        const pageToken = url.searchParams.get('pageToken') || '';
        const includeCounts = url.searchParams.get('includeCounts') === 'true';
        const data = await listCollection(fsBase, serviceToken, 'users', pageSize, pageToken);
        const users = (data.documents || []).map(userFromDoc);

        if (includeCounts) {
            await Promise.all(users.map(async user => {
                user.eventCount = await countUserEvents(fsBase, serviceToken, user.uid);
            }));
        }

        users.sort((a, b) => (a.email || a.uid).localeCompare(b.email || b.uid));
        return json({ success: true, users, nextPageToken: data.nextPageToken || '' });
    }

    if (path === '/api/admin/user-detail' && request.method === 'GET') {
        const uid = url.searchParams.get('uid');
        if (!uid) return json({ success: false, error: 'uid is required' }, 400);

        const doc = await getFirestoreDoc(fsBase, serviceToken, `users/${encodeURIComponent(uid)}`);
        if (!doc) return json({ success: false, error: 'User not found' }, 404);

        const [events] = await Promise.all([listUserEvents(fsBase, serviceToken, uid)]);
        return json({ success: true, user: { ...userFromDoc(doc), eventCount: events.length }, events });
    }

    if (path === '/api/admin/invites' && request.method === 'GET') {
        const pageSize = parseInt(url.searchParams.get('pageSize') || '250', 10);
        const pageToken = url.searchParams.get('pageToken') || '';
        const data = await listCollection(fsBase, serviceToken, 'invite_codes', pageSize, pageToken);
        const invites = (data.documents || []).map(inviteFromDoc).sort((a, b) => {
            if (a.usable !== b.usable) return a.usable ? -1 : 1;
            return String(b.createdAt).localeCompare(String(a.createdAt));
        });
        return json({ success: true, invites, nextPageToken: data.nextPageToken || '' });
    }

    if ((path === '/api/admin/set-tier' || path === '/api/admin/update-user') && request.method === 'POST') {
        const body = await request.json();
        const uid = String(body.uid || '').trim();
        if (!uid) return json({ success: false, error: 'uid is required' }, 400);

        const fields = buildUserFields(body, new Date().toISOString());
        await patchFirestoreDoc(fsBase, serviceToken, `users/${encodeURIComponent(uid)}`, fields);
        return json({ success: true, uid });
    }

    if (path === '/api/admin/bulk-users' && request.method === 'POST') {
        const body = await request.json();
        const uids = Array.isArray(body.uids) ? body.uids.map(uid => String(uid || '').trim()).filter(Boolean) : [];
        if (!uids.length) return json({ success: false, error: 'Select at least one user.' }, 400);
        if (uids.length > 100) return json({ success: false, error: 'Bulk actions are limited to 100 users at a time.' }, 400);

        const fields = buildUserFields(body, new Date().toISOString());
        await Promise.all(uids.map(uid => patchFirestoreDoc(fsBase, serviceToken, `users/${encodeURIComponent(uid)}`, fields)));
        return json({ success: true, updated: uids.length });
    }

    if (path === '/api/admin/create-invite' && request.method === 'POST') {
        const body = await request.json();
        const code = normalizeCode(body.code) || randomInviteCode();
        if (!/^[A-Z0-9-]{4,64}$/.test(code)) return json({ success: false, error: 'Invite code can use letters, numbers, and dashes only.' }, 400);

        const now = new Date().toISOString();
        const expiresAt = isoOrEmpty(body.expiresAt);
        const fields = {
            used: { booleanValue: false },
            createdAt: { timestampValue: now },
            updatedAt: { timestampValue: now },
            createdBy: { stringValue: 'admin' },
            isMultiUse: { booleanValue: body.isMultiUse === true },
            revoked: { booleanValue: false },
            tier: { stringValue: cleanTier(body.tier || 'paid') },
            note: { stringValue: String(body.note || '').slice(0, 500) },
            maxUses: { integerValue: String(Math.max(parseInt(body.maxUses, 10) || 0, 0)) },
            useCount: { integerValue: '0' }
        };
        if (expiresAt) fields.expiresAt = { timestampValue: expiresAt };

        await patchFirestoreDoc(fsBase, serviceToken, `invite_codes/${encodeURIComponent(code)}`, fields);
        return json({ success: true, invite: { code, ...inviteFromDoc({ name: `/invite_codes/${encodeURIComponent(code)}`, fields }) } });
    }

    if (path === '/api/admin/revoke-invite' && request.method === 'POST') {
        const body = await request.json();
        const code = normalizeCode(body.code);
        if (!code) return json({ success: false, error: 'code is required' }, 400);
        const now = new Date().toISOString();
        await patchFirestoreDoc(fsBase, serviceToken, `invite_codes/${encodeURIComponent(code)}`, {
            revoked: { booleanValue: true },
            revokedAt: { timestampValue: now },
            updatedAt: { timestampValue: now },
            note: { stringValue: String(body.note || '').slice(0, 500) }
        });
        return json({ success: true, code });
    }

    if (path === '/api/admin/delete-invite' && request.method === 'POST') {
        const body = await request.json();
        const code = normalizeCode(body.code);
        if (!code) return json({ success: false, error: 'code is required' }, 400);
        await deleteFirestoreDoc(fsBase, serviceToken, `invite_codes/${encodeURIComponent(code)}`);
        return json({ success: true, code });
    }

    return json({ success: false, error: 'Not found' }, 404);
}
