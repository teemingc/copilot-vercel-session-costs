import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, normalizeGeneration, usdUnits, usdString, isGenerationId } from '../gateway.mjs';

export const ID = 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ok = (data) => new Response(JSON.stringify({ data: { id: ID, total_cost: 0.00123, ...data } }));

test('USD arithmetic is exact, including scientific notation and tiny amounts', () => {
    assert.equal(usdString(usdUnits('0.1') + usdUnits('0.2')), '0.3');
    assert.equal(usdString(usdUnits(1e-9)), '0.000000001');
    assert.equal(usdString(usdUnits(0)), '0');
    for (const value of [-1, 'NaN', undefined, '0.0000000000000000001']) assert.throws(() => usdUnits(value));
});
test('only documented Gateway IDs are accepted', () => {
    assert.equal(isGenerationId(ID), true);
    for (const value of ['chatcmpl-abc', '../../secret', undefined, 'gen_abc']) assert.equal(isGenerationId(value), false);
});
test('Gateway debit includes surcharge once, and keeps upstream list price separate', () => {
    const charge = normalizeGeneration({ data: { id: ID, gateway_cost: '0.12', total_cost: 0.12, surcharge_cost: '0.02', upstream_inference_cost: '0.5', is_byok: true } }, ID);
    assert.deepEqual(charge, { gatewayUsd: '0.12', surchargeUsd: '0.02', upstreamListUsd: '0.5', upstreamByok: true });
    assert.equal(normalizeGeneration({ data: { id: ID, total_cost: 0 } }, ID).gatewayUsd, '0');
});
test('mismatched IDs, missing charges and inconsistent costs never confirm', () => {
    for (const data of [{ id: 'other', total_cost: 1 }, { id: ID }, { id: ID, total_cost: -1 }, { id: ID, gateway_cost: 1, total_cost: 2 }]) {
        assert.throws(() => normalizeGeneration({ data }, ID));
    }
});
test('lookup sends key to fixed HTTPS origin only and refuses redirects', async () => {
    let captured;
    const gateway = createGateway({ apiKey: 'test-secret', fetchImpl: async (url, options) => { captured = { url, options }; return ok(); } });
    assert.equal((await gateway.lookup(ID)).gatewayUsd, '0.00123');
    assert.equal(new URL(captured.url).origin, 'https://ai-gateway.vercel.sh');
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.headers.Authorization, 'Bearer test-secret');
});
test('missing key and unsupported IDs never make requests', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return ok(); };
    await assert.rejects(createGateway({ fetchImpl }).lookup(ID), { code: 'missing_key' });
    await assert.rejects(createGateway({ apiKey: 'test', fetchImpl }).lookup('chatcmpl-abc'), { code: 'unsupported_id' });
    assert.equal(calls, 0);
});
test('404 ingestion lag and rate limits retry with bounded backoff', async () => {
    let calls = 0; const waits = [];
    const gateway = createGateway({ apiKey: 'test', sleep: async (ms) => waits.push(ms), fetchImpl: async () => {
        calls++; return calls === 1 ? new Response('', { status: 404 }) : calls === 2 ? new Response('', { status: 429, headers: { 'Retry-After': '3' } }) : ok();
    } });
    await gateway.lookup(ID); assert.equal(calls, 3); assert.deepEqual(waits, [1000, 3000]);
});
test('persistent 404 stops after five attempts', async () => {
    let calls = 0;
    await assert.rejects(createGateway({ apiKey: 'test', sleep: async () => {}, fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } }).lookup(ID), { code: 'not_found' });
    assert.equal(calls, 5);
});
test('authentication errors are actionable and sanitize upstream secrets', async () => {
    await assert.rejects(createGateway({ apiKey: 'test-secret', fetchImpl: async () => new Response('test-secret: private details', { status: 401 }) }).lookup(ID), (error) => error.code === 'authentication' && !error.message.includes('test-secret'));
});
test('long Retry-After defers rather than hammering Vercel', async () => {
    await assert.rejects(createGateway({ apiKey: 'test', fetchImpl: async () => new Response('', { status: 429, headers: { 'Retry-After': '90' } }) }).lookup(ID), { code: 'rate_limit' });
});
test('unreadable JSON is not interpreted as a zero charge', async () => {
    await assert.rejects(createGateway({ apiKey: 'test', fetchImpl: async () => new Response('not json') }).lookup(ID), { code: 'invalid_response' });
});
