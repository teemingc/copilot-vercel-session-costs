import { EventEmitter } from 'node:events';
import { isGenerationId, usdString, usdUnits } from './gateway.mjs';
import { missingKeyMessage } from './credentials.mjs';

const tokenFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
const safeText = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : undefined;

export function normalizeUsage(event) {
    if (event?.type !== 'assistant.usage' || typeof event.id !== 'string' || typeof event.data?.model !== 'string') return null;
    const data = event.data;
    const record = {
        eventId: event.id, timestamp: Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : new Date().toISOString(),
        model: safeText(data.model), agentId: safeText(event.agentId), interactionType: safeText(data.interactionType),
        isByok: typeof data.isByok === 'boolean' ? data.isByok : undefined,
        generationId: isGenerationId(data.apiCallId) ? data.apiCallId : undefined,
        status: isGenerationId(data.apiCallId) ? 'pending' : 'unresolved',
        reason: isGenerationId(data.apiCallId) ? undefined : 'No Vercel Gateway generation ID exposed by this provider.',
    };
    for (const field of tokenFields) {
        if (Number.isSafeInteger(data[field]) && data[field] >= 0) record[field] = data[field];
    }
    return record;
}

export function summarize(ledger) {
    const totals = { confirmed: 0, pending: 0, unresolved: 0, failed: 0, observed: ledger.records.length };
    const models = new Map();
    const chargedIds = new Set();
    let total = 0n;
    const tokens = Object.fromEntries(tokenFields.map((field) => [field, 0]));
    for (const record of ledger.records) {
        const key = record.generationId || `event:${record.eventId}`;
        if (chargedIds.has(key)) continue;
        chargedIds.add(key);
        totals[record.status]++;
        let model = models.get(record.model);
        if (!model) { model = { model: record.model, requests: 0, confirmed: 0, unknown: 0, units: 0n }; models.set(record.model, model); }
        model.requests++;
        for (const field of tokenFields) tokens[field] += record[field] || 0;
        if (record.status === 'confirmed') {
            const units = usdUnits(record.charge.gatewayUsd);
            total += units; model.units += units; model.confirmed++;
        } else model.unknown++;
    }
    return {
        gatewayUsd: usdString(total), counts: { ...totals, uniqueRequests: chargedIds.size }, tokens,
        models: [...models.values()].sort((a, b) => a.units === b.units ? a.model.localeCompare(b.model) : a.units > b.units ? -1 : 1)
            .map(({ units, ...model }) => ({ ...model, gatewayUsd: usdString(units) })),
    };
}

export class Tracker extends EventEmitter {
    constructor({ sessionId, storage, gateway, now = () => new Date().toISOString() }) {
        super(); this.sessionId = sessionId; this.storage = storage; this.gateway = gateway; this.now = now;
        this.ledger = null; this.problem = null; this.mutations = Promise.resolve(); this.queued = new Set();
        this.queue = []; this.active = 0; this.stopping = false; this.authBlocked = false;
    }
    async initialize() {
        try {
            this.ledger = await this.storage.load() || { version: 1, sessionId: this.sessionId, startedAt: this.now(), observationPeriods: [], records: [] };
            this.ledger.observationPeriods.push({ startedAt: this.now() });
            for (const record of this.ledger.records) {
                if (record.errorCode !== 'missing_key') continue;
                if (this.gateway.configured) {
                    record.status = 'pending'; delete record.reason; delete record.errorCode;
                } else record.reason = missingKeyMessage;
            }
            await this.storage.save(this.ledger);
        } catch {
            this.problem = 'Could not read or save the session ledger. Check session storage; existing files were not replaced.';
        }
        this.emit('change');
        if (!this.problem) this.resumePending();
    }
    state() {
        return {
            version: 1, sessionId: this.sessionId, configured: this.gateway.configured, problem: this.problem,
            startedAt: this.ledger?.startedAt, observationPeriods: this.ledger?.observationPeriods || [],
            coverage: 'Observed calls only. Earlier usage and disconnected periods cannot be recovered.',
            summary: this.ledger ? summarize(this.ledger) : { gatewayUsd: '0', counts: { observed: 0, confirmed: 0, pending: 0, unresolved: 0, failed: 0, uniqueRequests: 0 }, tokens: {}, models: [] },
            records: this.ledger?.records || [],
        };
    }
    mutate(fn) {
        const operation = this.mutations.then(async () => {
            if (this.problem || !this.ledger) return;
            const previous = structuredClone(this.ledger);
            try { await fn(); await this.storage.save(this.ledger); }
            catch { this.ledger = previous; this.problem = 'Could not save costs. Check session storage before continuing.'; }
            this.emit('change');
        });
        this.mutations = operation.catch(() => { this.problem = 'Could not update the session ledger.'; this.emit('change'); });
        return this.mutations;
    }
    async observe(event) {
        if (this.stopping) return;
        const record = normalizeUsage(event);
        if (!record) return;
        await this.mutate(() => {
            if (this.ledger.records.some((item) => item.eventId === record.eventId)) return;
            if (record.generationId && this.ledger.records.some((item) => item.generationId === record.generationId)) return;
            if (record.generationId && !this.gateway.configured) {
                record.status = 'failed'; record.reason = missingKeyMessage; record.errorCode = 'missing_key';
            }
            this.ledger.records.push(record);
        });
        if (record.generationId && this.gateway.configured && !this.problem) this.enqueue(record.generationId);
    }
    enqueue(id) {
        if (this.stopping || this.authBlocked || this.problem || this.queued.has(id)
            || this.ledger.records.find((record) => record.generationId === id)?.status === 'confirmed') return;
        this.queued.add(id); this.queue.push(id); this.pump();
    }
    resumePending() {
        if (this.gateway.configured) for (const record of this.ledger.records) if (record.status === 'pending') this.enqueue(record.generationId);
    }
    pump() {
        while (!this.stopping && !this.authBlocked && this.active < 2 && this.queue.length) {
            const id = this.queue.shift(); this.active++;
            this.resolve(id).catch(() => {}).finally(() => { this.active--; this.queued.delete(id); this.pump(); });
        }
    }
    async resolve(id) {
        let charge, error;
        try { charge = await this.gateway.lookup(id); }
        catch (failure) { error = failure; }
        await this.mutate(() => {
            const record = this.ledger.records.find((item) => item.generationId === id);
            if (!record || record.status === 'confirmed') return;
            if (charge) {
                record.charge = charge; record.status = 'confirmed'; record.checkedAt = this.now();
                delete record.reason; delete record.errorCode;
            } else {
                record.status = error?.code === 'not_found' ? 'unresolved' : 'failed';
                record.reason = error?.code ? error.message : 'Lookup failed. Retry later.';
                record.errorCode = error?.code || 'lookup_failed';
                if (error?.code === 'authentication') this.authBlocked = true;
            }
        });
    }
    async retry() {
        if (this.problem) return { queued: 0, reason: this.problem };
        if (!this.gateway.configured) return { queued: 0, reason: missingKeyMessage };
        this.authBlocked = false;
        const ids = [];
        await this.mutate(() => {
            for (const record of this.ledger.records) {
                if (record.status !== 'confirmed' && record.generationId) {
                    record.status = 'pending'; delete record.reason; delete record.errorCode;
                    if (!this.queued.has(record.generationId)) ids.push(record.generationId);
                }
            }
        });
        ids.forEach((id) => this.enqueue(id));
        this.pump();
        return { queued: ids.length, reason: ids.length ? undefined : 'No additional generation IDs available to retry.' };
    }
    async close() {
        this.stopping = true;
        await this.mutate(() => {
            const period = this.ledger.observationPeriods.at(-1);
            if (period) period.endedAt = this.now();
        });
        await this.storage.flush().catch(() => {});
    }
}
