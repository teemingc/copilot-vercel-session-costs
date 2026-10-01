import test from 'node:test';
import assert from 'node:assert/strict';
import { readGatewayKeychain } from '../credentials.mjs';
import { createGateway } from '../gateway.mjs';

const ID = 'gen_01ARZ3NDEKTSV4RRFFQ69G5FAV';

test('reads only the named Keychain item with a bounded direct subprocess', async () => {
    const key = await readGatewayKeychain({ platform: 'darwin', execFileImpl: async (file, args, options) => {
        assert.equal(file, '/usr/bin/security');
        assert.deepEqual(args, ['find-generic-password', '-s', 'copilot-ai-gateway', '-w']);
        assert.equal(options.timeout, 15000); assert.equal(options.maxBuffer, 65536);
        assert.equal(options.shell, undefined);
        return { stdout: 'test-key-placeholder\n' };
    } });
    assert.equal(key, 'test-key-placeholder');
});
test('missing, denied, timed-out and malformed credentials remain unavailable without diagnostic leakage', async () => {
    for (const value of [undefined, '', ' \n', 'x'.repeat(16385)]) {
        assert.equal(await readGatewayKeychain({ platform: 'darwin', execFileImpl: async () => ({ stdout: value }) }), undefined);
    }
    for (const code of [44, 128, 'ETIMEDOUT']) {
        assert.equal(await readGatewayKeychain({ platform: 'darwin', execFileImpl: async () => {
            throw Object.assign(new Error('sensitive upstream diagnostic'), { code, stdout: 'secret', stderr: 'secret' });
        } }), undefined);
    }
});
test('falls back to the exact item label only when the service is not found', async () => {
    const selectors = [];
    const key = await readGatewayKeychain({ platform: 'darwin', execFileImpl: async (_file, args) => {
        selectors.push(args[1]);
        if (args[1] === '-s') throw Object.assign(new Error('not found'), { code: 44 });
        return { stdout: 'test-label-key\n' };
    } });
    assert.equal(key, 'test-label-key'); assert.deepEqual(selectors, ['-s', '-l']);
});
test('does not retry denied or timed-out access under another selector', async () => {
    let calls = 0;
    assert.equal(await readGatewayKeychain({ platform: 'darwin', execFileImpl: async () => {
        calls++; throw Object.assign(new Error('denied'), { code: 128 });
    } }), undefined);
    assert.equal(calls, 1);
});
test('does not invoke macOS credential tools on other platforms', async () => {
    assert.equal(await readGatewayKeychain({ platform: 'linux', execFileImpl: () => { assert.fail('unexpected subprocess'); } }), undefined);
});
test('Keychain credential configures the fixed-origin Gateway lookup without an environment variable', async () => {
    const apiKey = await readGatewayKeychain({ platform: 'darwin', execFileImpl: async () => ({ stdout: 'test-key-placeholder\n' }) });
    const gateway = createGateway({ apiKey, fetchImpl: async (url, options) => {
        assert.equal(new URL(url).origin, 'https://ai-gateway.vercel.sh');
        assert.equal(options.headers.Authorization, 'Bearer test-key-placeholder');
        return new Response(JSON.stringify({ data: { id: ID, gateway_cost: '0.004' } }), { status: 200 });
    } });
    assert.equal(gateway.configured, true);
    assert.equal((await gateway.lookup(ID)).gatewayUsd, '0.004');
});
