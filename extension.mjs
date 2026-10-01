// Extension: vercel-session-costs
// Track actual Vercel AI Gateway charges separately for the current Copilot session.
//
// This single-file skeleton is a starting point. For more complex canvases
// (multiple actions with non-trivial logic, shared state, a custom renderer,
// etc.) prefer splitting things out: move each action handler into its own
// function, extract `open`/`onClose` into helpers, and pull large units
// (renderer assets, schema definitions, shared utilities) into sibling files
// imported from this entry point. Keep extension.mjs focused on wiring.

import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { createGateway } from './gateway.mjs';
import { createStorage } from './storage.mjs';
import { Tracker } from './tracker.mjs';
import { startServer } from './server.mjs';
import { readGatewayKeychain } from './credentials.mjs';

const servers = new Map();
const shutdown = new AbortController();
const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
let tracker;
let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

async function current(ctx) {
    await ready;
    if (!tracker || ctx.sessionId !== tracker.sessionId) throw new CanvasError('session_mismatch', 'This canvas belongs to another session.');
    return tracker;
}

const keychainKey = await readGatewayKeychain();
const session = await joinSession({
    requestedEnvironmentVariables: keychainKey ? [] : ['AI_GATEWAY_API_KEY'],
    canvases: [createCanvas({
        id: 'vercel-session-costs',
        displayName: 'Gateway session costs',
        description: 'View actual Vercel AI Gateway spending, billing coverage, and requests for this Copilot session.',
        inputSchema: emptySchema,
        actions: [
            { name: 'get_summary', description: 'Read confirmed USD spending, coverage, and model breakdown for this session.', inputSchema: emptySchema,
                handler: async (ctx) => { const state = (await current(ctx)).state(); const { records, ...summary } = state; return summary; } },
            { name: 'retry_lookups', description: 'Retry unresolved charges with available Gateway generation IDs.', inputSchema: emptySchema,
                handler: async (ctx) => (await current(ctx)).retry() },
            { name: 'export_costs', description: 'Export recorded session costs and usage metadata without credentials or conversation content.', inputSchema: emptySchema,
                handler: async (ctx) => (await current(ctx)).state() },
        ],
        open: async (ctx) => {
            const owner = await current(ctx);
            let entry = servers.get(ctx.instanceId);
            if (!entry) {
                entry = startServer(owner);
                servers.set(ctx.instanceId, entry);
                try { entry = await entry; }
                catch (error) { servers.delete(ctx.instanceId); throw error; }
            } else entry = await entry;
            return { title: 'Gateway session costs', url: entry.url };
        },
        onClose: async (ctx) => {
            const entry = servers.get(ctx.instanceId);
            if (entry) { servers.delete(ctx.instanceId); await (await entry).close(); }
        },
    })],
});

tracker = new Tracker({ sessionId: session.sessionId, storage: createStorage(session.workspacePath, session.sessionId),
    gateway: createGateway({ apiKey: keychainKey || process.env.AI_GATEWAY_API_KEY, signal: shutdown.signal,
        sleep: (ms) => new Promise((resolve) => {
            if (shutdown.signal.aborted) return resolve();
            const finish = () => { clearTimeout(timer); shutdown.signal.removeEventListener('abort', finish); resolve(); };
            const timer = setTimeout(finish, ms);
            shutdown.signal.addEventListener('abort', finish, { once: true });
        }),
    }),
});
const unsubscribe = session.on('assistant.usage', (event) => {
    void ready.then(() => tracker.observe(event)).catch(() => {});
});
tracker.initialize().then(resolveReady, rejectReady);
let closing = false;
async function close() {
    if (closing) return;
    closing = true; unsubscribe(); shutdown.abort();
    await ready;
    await tracker.close();
    await Promise.allSettled([...servers.values()].map(async (entry) => (await entry).close()));
    process.exit(0);
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });

