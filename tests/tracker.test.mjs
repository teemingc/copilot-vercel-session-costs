import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, normalizeUsage, summarize } from '../tracker.mjs';

const ID = 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ID2 = 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAW';
function event(id = 'event-1', generation = ID) {
    return { type: 'assistant.usage', id, timestamp: '2026-10-01T00:00:00Z', data: { apiCallId: generation, model: 'anthropic/claude-sonnet-5', inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cost: 500, isByok: true }, agentId: 'child-1' };
}
function fixture({ configured = true, lookup = async () => ({ gatewayUsd: '0.00123' }), ledger = null, sessionId = 'session-1' } = {}) {
    let saved = ledger;
    const storage = { load: async () => saved, save: async (data) => { saved = structuredClone(data); }, flush: async () => {} };
    const tracker = new Tracker({ sessionId, storage, gateway: { configured, lookup } });
    return { tracker, storage, saved: () => saved };
}
async function idle(tracker) {
    for (let i = 0; i < 50 && (tracker.active || tracker.queue.length); i++) await new Promise((resolve) => setTimeout(resolve, 2));
    await tracker.mutations;
    assert.equal(tracker.active, 0);
}

test('usage normalization retains attribution but never billing multiplier or transcript', () => {
    const value = event(); value.data.prompt = 'private transcript';
    const record = normalizeUsage(value);
    assert.equal(record.agentId, 'child-1'); assert.equal(record.generationId, ID);
    assert.equal(record.cost, undefined); assert.equal(record.prompt, undefined);
    assert.equal(normalizeUsage({ type: 'assistant.message' }), null);
});
test('missing generation ID is unknown, never zero-dollar confirmed', async () => {
    const { tracker } = fixture(); await tracker.initialize(); await tracker.observe(event('no-id', undefined));
    // Explicitly replace default argument to exercise missing provider ID.
    const missing = event('missing'); delete missing.data.apiCallId; await tracker.observe(missing); await idle(tracker);
    const record = tracker.state().records.find((r) => r.eventId === 'missing');
    assert.equal(record.status, 'unresolved'); assert.equal(record.charge, undefined);
    await tracker.close();
});
test('events and repeated generation IDs deduplicate across delivery and reload', async () => {
    let calls = 0;
    const first = fixture({ lookup: async () => { calls++; return { gatewayUsd: '0.12' }; } });
    await first.tracker.initialize(); await first.tracker.observe(event()); await first.tracker.observe(event());
    await first.tracker.observe(event('different-event', ID)); await idle(first.tracker);
    assert.equal(calls, 1); assert.equal(first.tracker.state().summary.gatewayUsd, '0.12');
    const second = fixture({ ledger: first.saved() }); await second.tracker.initialize(); await second.tracker.observe(event());
    assert.equal(second.tracker.state().records.length, 1); assert.equal(second.tracker.state().summary.gatewayUsd, '0.12');
    assert.equal(second.tracker.state().observationPeriods.length, 2);
    await first.tracker.close(); await second.tracker.close();
});
test('confirmed spend excludes unknown requests and uses exact decimals', async () => {
    const { tracker } = fixture({ lookup: async (id) => ({ gatewayUsd: id === ID ? '0.1' : '0.2' }) });
    await tracker.initialize(); await tracker.observe(event()); await tracker.observe(event('event-2', ID2));
    await tracker.observe(event('event-3', 'chatcmpl-other')); await idle(tracker);
    assert.equal(tracker.state().summary.gatewayUsd, '0.3'); assert.equal(tracker.state().summary.counts.unresolved, 1);
    assert.equal(tracker.state().summary.models[0].unknown, 1); await tracker.close();
});
test('same-runtime sub-agent attribution does not mix independent session ledgers', async () => {
    const a = fixture(); const b = fixture({ sessionId: 'session-2' });
    await a.tracker.initialize(); await b.tracker.initialize(); await a.tracker.observe(event()); await idle(a.tracker);
    assert.equal(b.tracker.state().summary.counts.observed, 0); assert.equal(a.tracker.state().records[0].agentId, 'child-1');
    await a.tracker.close(); await b.tracker.close();
});
test('missing credentials keep recorded requests and expose setup state', async () => {
    const { tracker } = fixture({ configured: false }); await tracker.initialize(); await tracker.observe(event());
    assert.equal(tracker.state().configured, false); assert.equal(tracker.state().summary.gatewayUsd, '0');
    assert.equal(tracker.state().records[0].status, 'failed'); assert.equal((await tracker.retry()).queued, 0); await tracker.close();
});
test('failed generation can be retried and confirmed exactly once', async () => {
    let fail = true;
    const { tracker } = fixture({ lookup: async () => { if (fail) throw Object.assign(new Error('Not available'), { code: 'not_found' }); return { gatewayUsd: '0' }; } });
    await tracker.initialize(); await tracker.observe(event()); await idle(tracker);
    assert.equal(tracker.state().records[0].status, 'unresolved'); fail = false;
    assert.equal((await tracker.retry()).queued, 1); await idle(tracker);
    assert.equal(tracker.state().summary.counts.confirmed, 1); assert.equal(tracker.state().summary.gatewayUsd, '0'); await tracker.close();
});
test('corrupt storage is not overwritten and disables cost mutations', async () => {
    let writes = 0;
    const tracker = new Tracker({ sessionId: 'one', storage: { load: async () => { throw new Error('bad file'); }, save: async () => writes++, flush: async () => {} }, gateway: { configured: true } });
    await tracker.initialize(); await tracker.observe(event()); assert.ok(tracker.state().problem); assert.equal(writes, 0); await tracker.close();
});
test('reload with available credentials prices requests recorded before key setup', async () => {
    const first = fixture({ configured: false }); await first.tracker.initialize(); await first.tracker.observe(event());
    assert.equal(first.tracker.state().records[0].errorCode, 'missing_key');
    const second = fixture({ ledger: first.saved() }); await second.tracker.initialize(); await idle(second.tracker);
    assert.equal(second.tracker.state().summary.counts.confirmed, 1);
    assert.equal(second.tracker.state().summary.gatewayUsd, '0.00123');
    await first.tracker.close(); await second.tracker.close();
});
test('pending lookups resume after a session reload', async () => {
    const first = fixture({ configured: false }); await first.tracker.initialize();
    const ledger = first.saved(); ledger.records.push(normalizeUsage(event()));
    const second = fixture({ ledger }); await second.tracker.initialize(); await idle(second.tracker);
    assert.equal(second.tracker.state().summary.counts.confirmed, 1);
    await first.tracker.close(); await second.tracker.close();
});
test('storage failure does not publish an unpersisted confirmed total', async () => {
    const { tracker, storage } = fixture(); await tracker.initialize();
    storage.save = async (ledger) => { if (ledger.records.some((r) => r.status === 'confirmed')) throw new Error('disk full'); };
    await tracker.observe(event()); await idle(tracker);
    assert.ok(tracker.state().problem);
    assert.equal(tracker.state().summary.gatewayUsd, '0');
    assert.equal(tracker.state().records[0].status, 'pending');
    await tracker.close();
});
test('authentication retry restarts both blocked queue and failed requests', async () => {
    let unblock; let fail = true;
    const gate = new Promise((resolve) => { unblock = resolve; });
    const { tracker } = fixture({ lookup: async () => { await gate; if (fail) throw Object.assign(new Error('Authentication failed'), { code: 'authentication' }); return { gatewayUsd: '0.1' }; } });
    await tracker.initialize(); await tracker.observe(event()); await tracker.observe(event('two', ID2));
    await tracker.observe(event('three', 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAX'));
    unblock();
    for (let i = 0; i < 50 && tracker.active; i++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(tracker.authBlocked, true); assert.equal(tracker.queue.length, 1);
    fail = false; await tracker.retry(); await idle(tracker);
    assert.equal(tracker.state().summary.gatewayUsd, '0.3');
    assert.equal(tracker.state().summary.counts.confirmed, 3); await tracker.close();
});
test('summary does not double-charge duplicate generation IDs in an existing ledger', () => {
    const record = { ...normalizeUsage(event()), status: 'confirmed', charge: { gatewayUsd: '0.2' } };
    assert.equal(summarize({ records: [record, { ...record, eventId: 'other' }] }).gatewayUsd, '0.2');
});
