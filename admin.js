// admin.js

import { getServiceToken } from './auth.js';
import { json } from './util.js';

export async function handleAdminRoutes(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret'
            }
        });
    }

    if (request.headers.get('x-admin-secret') !== env.ADMIN_SECRET) {
        return json({ success: false, error: 'Forbidden' }, 403);
    }

    const serviceToken = await getServiceToken(env);
    const fsBase = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;

    // GET /api/admin/users — list all registered users
    if (path === '/api/admin/users' && request.method === 'GET') {
        const res = await fetch(`${fsBase}/users?pageSize=300`, {
            headers: { Authorization: `Bearer ${serviceToken}` }
        });
        const data = await res.json();

        const users = (data.documents || []).map(doc => {
            const f = doc.fields || {};
            const uid = doc.name.split('/').pop();
            return {
                uid,
                email: f.email?.stringValue || '',
                tier: f.tier?.stringValue || 'free',
                createdAt: f.createdAt?.timestampValue || '',
                note: f.note?.stringValue || '',
                expiresAt: f.expiresAt?.timestampValue || '' // <-- ADD THIS LINE
            };
        });

        return json({ success: true, users });
    }

    // NEW: GET /api/admin/invites — list all invite codes
    if (path === '/api/admin/invites' && request.method === 'GET') {
        const res = await fetch(`${fsBase}/invite_codes?pageSize=500`, {
            headers: { Authorization: `Bearer ${serviceToken}` }
        });
        const data = await res.json();

        const invites = (data.documents || []).map(doc => {
            const f = doc.fields || {};
            const code = doc.name.split('/').pop();
            return {
                code,
                used: f.used?.booleanValue || false,
                usedBy: f.usedBy?.stringValue || '',
                createdAt: f.createdAt?.timestampValue || '',
                isMultiUse: f.isMultiUse?.booleanValue || false,
                expiresAt: f.expiresAt?.timestampValue || ''
            };
        });

        return json({ success: true, invites });
    }

    // POST /api/admin/set-tier — upgrade or downgrade a user
    // Body: { uid, tier: "free"|"paid", note }
    if (path === '/api/admin/set-tier' && request.method === 'POST') {
        const { uid, tier, note } = await request.json();

        if (!uid || !['free', 'paid'].includes(tier)) {
            return json({ success: false, error: 'Invalid uid or tier' }, 400);
        }

        let updateMask = `updateMask.fieldPaths=tier&updateMask.fieldPaths=note`;
        let fields = {
            tier: { stringValue: tier },
            note: { stringValue: note || '' }
        };

        // NEW: Calculate 1 year expiration on upgrade, clear it on downgrade
        if (tier === 'paid') {
            const oneYearFromNow = new Date();
            oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
            updateMask += `&updateMask.fieldPaths=expiresAt`;
            fields.expiresAt = { timestampValue: oneYearFromNow.toISOString() };
        } else {
            updateMask += `&updateMask.fieldPaths=expiresAt`;
            fields.expiresAt = { nullValue: null };
        }

        await fetch(`${fsBase}/users/${uid}?${updateMask}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
        });

        return json({ success: true, uid, tier });
    }

    return json({ error: 'Not found' }, 404);
}