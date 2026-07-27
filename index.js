// index.js

import { handleGalleryRoutes } from './gallery.js';
import { handleQRRoutes } from './qr.js';
import { handleDashboardRoutes, handleUserRoutes } from './dashboard.js';
import { handleHotfolder } from './hotfolder.js';
import { handleAdminRoutes, handleAppVersionsPublic } from './admin.js';
import { json, cors } from './util.js';

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'content-type, authorization, x-admin-secret'
        }
    });
}

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // ── Admin routes (protected by ADMIN_SECRET header) ──
            if (path.startsWith('/api/admin/'))
                return cors(await handleAdminRoutes(request, env));

            if (path === '/api/app-versions')
                return cors(await handleAppVersionsPublic(request, env));

            // ── User auth routes (provision + profile) ──
            if (path === '/api/auth/provision-user' || path === '/api/user/profile')
                return cors(await handleUserRoutes(request, env));

            // ── All routes below are identical to your existing index.js ──
            if (path.startsWith('/api/gallery') || path.startsWith('/api/stream') || path.startsWith('/api/template') || path.startsWith('/api/upload-community'))
                return cors(await handleGalleryRoutes(request, env));

            if (path.startsWith('/api/photo') || path.startsWith('/api/session-gallery') || path.startsWith('/api/toggle-session') || path.startsWith('/api/next-photo-id'))
                return cors(await handleQRRoutes(request, env));

            if (path.startsWith('/api/hotfolder'))
                return cors(await handleHotfolder(request, env));

            if (path.startsWith('/api/dashboard/') || path === '/api/next-event-id' || path === '/api/sign-upload')
                return cors(await handleDashboardRoutes(request, env));

            if (path === '/api/cron/daily') {
                const { runDailyTasks } = await import('./cron.js');
                return cors(await runDailyTasks(env));
            }

            return cors(json({ error: 'Not found', path }, 404));
        } catch (err) {
            console.error('Worker error:', err.stack || err.message);
            return cors(json({ success: false, error: err.message }, 500));
        }
    },

    async scheduled(event, env) {
        const { runDailyTasks } = await import('./cron.js');
        await runDailyTasks(env);
    }
};
