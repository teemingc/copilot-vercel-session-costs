import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isGenerationId, usdUnits } from './gateway.mjs';

const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const statuses = new Set(['pending', 'confirmed', 'unresolved', 'failed']);

export function validateLedger(data, sessionId) {
    if (data?.version !== 1 || data.sessionId !== sessionId || !Array.isArray(data.records)
        || !Array.isArray(data.observationPeriods) || !Number.isFinite(Date.parse(data.startedAt))) {
        throw new Error('Invalid session ledger');
    }
    const events = new Set();
    for (const record of data.records) {
        if (typeof record.eventId !== 'string' || events.has(record.eventId) || !statuses.has(record.status)
            || typeof record.model !== 'string' || !Number.isFinite(Date.parse(record.timestamp))) throw new Error('Invalid usage record');
        events.add(record.eventId);
        if (record.generationId !== undefined && !isGenerationId(record.generationId)) throw new Error('Invalid generation ID');
        for (const field of tokenFields) {
            if (record[field] !== undefined && (!Number.isSafeInteger(record[field]) || record[field] < 0)) throw new Error('Invalid token count');
        }
        if (record.status === 'confirmed') {
            if (!record.generationId) throw new Error('Missing confirmed generation ID');
            usdUnits(record.charge?.gatewayUsd);
            for (const field of ['surchargeUsd', 'upstreamListUsd']) {
                if (record.charge[field] !== undefined) usdUnits(record.charge[field]);
            }
        }
    }
    return data;
}

export function createStorage(workspacePath, sessionId) {
    const file = workspacePath ? join(workspacePath, 'vercel-session-costs.json') : null;
    let writes = Promise.resolve();
    return {
        file,
        async load() {
            if (!file) throw new Error('Session storage unavailable');
            let text;
            try { text = await readFile(file, 'utf8'); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
            return validateLedger(JSON.parse(text), sessionId);
        },
        save(ledger) {
            const text = JSON.stringify(validateLedger(ledger, sessionId), null, 2) + '\n';
            const operation = writes.catch(() => {}).then(async () => {
                if (!file) throw new Error('Session storage unavailable');
                await mkdir(workspacePath, { recursive: true });
                const temp = `${file}.${randomUUID()}.tmp`;
                try {
                    await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
                    await rename(temp, file);
                } finally { await unlink(temp).catch(() => {}); }
            });
            writes = operation;
            return operation;
        },
        flush: () => writes,
    };
}
