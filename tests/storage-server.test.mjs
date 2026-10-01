import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { createStorage } from '../storage.mjs';
import { startServer } from '../server.mjs';

const ledger = () => ({ version: 1, sessionId: 'one', startedAt: '2026-10-01T00:00:00Z', observationPeriods: [], records: [] });
test('atomic session storage restores ledger and has private permissions', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const storage = createStorage(directory, 'one'); assert.equal(await storage.load(), null);
    await Promise.all([storage.save(ledger()), storage.save(ledger())]);
    assert.deepEqual(await storage.load(), ledger()); assert.equal((await stat(storage.file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['vercel-session-costs.json']);
    await assert.rejects(createStorage(directory, 'another').load());
});
test('malformed files and undefined workspace fail without overwriting', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const storage = createStorage(directory, 'one'); await writeFile(storage.file, 'not json');
    await assert.rejects(storage.load()); assert.equal(await readFile(storage.file, 'utf8'), 'not json');
    await assert.rejects(createStorage(undefined, 'one').load());
});
test('invalid confirmed charges and session mismatches are rejected on save', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'gateway-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
    const storage = createStorage(directory, 'one');
    assert.throws(() => storage.save({ ...ledger(), sessionId: 'two' }));
    assert.throws(() => storage.save({ ...ledger(), records: [{ eventId: 'one', timestamp: ledger().startedAt, model: 'test', status: 'confirmed' }] }));
});
function fakeTracker() {
    const tracker = new EventEmitter(); tracker.state = () => ({ sessionId: 'one', summary: { gatewayUsd: '0.12' }, records: [] });
    tracker.retry = async () => ({ queued: 2 }); return tracker;
}
function route(entry, path) { const url = new URL(entry.url); url.pathname = path; return url; }
test('protected loopback state and exports work without disclosing keys', async (t) => {
    const tracker = fakeTracker(); const entry = await startServer(tracker); t.after(() => entry.close());
    const url = new URL(entry.url); assert.equal(url.hostname, '127.0.0.1');
    const state = await fetch(route(entry, '/state')); assert.equal(state.status, 200);
    assert.equal((await state.json()).summary.gatewayUsd, '0.12');
    assert.equal((await fetch(`${url.origin}/state`)).status, 403);
    const wrongHost = await new Promise((resolve, reject) => {
        const req = request(route(entry, '/state'), { headers: { Host: 'attacker.test' } }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', reject); req.end();
    });
    assert.equal(wrongHost, 403);
    const exported = await fetch(route(entry, '/export')); assert.match(exported.headers.get('content-disposition'), /attachment/);
    assert.doesNotMatch(await exported.text(), /Authorization|API_KEY|Bearer/);
    const html = await (await fetch(entry.url)).text(); assert.ok(html.includes(url.searchParams.get('token')));
    assert.ok(!html.includes('__CANVAS_TOKEN__')); assert.match(html, /Request ledger/);
});
test('retry requires same origin, correct token, permitted method and bounded body', async (t) => {
    const entry = await startServer(fakeTracker()); t.after(() => entry.close()); const origin = new URL(entry.url).origin;
    assert.equal((await fetch(route(entry, '/retry'), { method: 'POST' })).status, 403);
    assert.equal((await fetch(route(entry, '/retry'), { method: 'POST', headers: { Origin: 'https://attacker.test' } })).status, 403);
    const valid = await fetch(route(entry, '/retry'), { method: 'POST', headers: { Origin: origin } }); assert.deepEqual(await valid.json(), { queued: 2 });
    assert.equal((await fetch(route(entry, '/retry'), { method: 'POST', headers: { Origin: origin }, body: 'x'.repeat(1025) })).status, 413);
    assert.equal((await fetch(route(entry, '/state'), { method: 'DELETE' })).status, 405);
});
test('SSE pushes shared state across panels and cleans up on close', async () => {
    const tracker = fakeTracker(); const a = await startServer(tracker); const b = await startServer(tracker);
    const controller = new AbortController();
    try {
        assert.equal(tracker.listenerCount('change'), 2);
        const response = await fetch(route(a, '/events'), { signal: controller.signal });
        const reader = response.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /0.12/);
        tracker.state = () => ({ sessionId: 'one', summary: { gatewayUsd: '0.25' }, records: [] }); tracker.emit('change');
        assert.match(new TextDecoder().decode((await reader.read()).value), /0.25/);
        assert.equal((await (await fetch(route(b, '/state'))).json()).summary.gatewayUsd, '0.25');
    } finally { controller.abort(); await a.close(); await b.close(); }
    assert.equal(tracker.listenerCount('change'), 0);
});
