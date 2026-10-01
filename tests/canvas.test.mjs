import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = (await readFile(new URL('../assets/canvas.js', import.meta.url), 'utf8')).replace(/connect\(\);\s*$/, '');
function renderer() {
    const elements = new Map();
    function element() {
        return { textContent: '', classList: { toggle() {} }, append(...children) { this.children = children; }, replaceChildren(...children) { this.children = children; }, addEventListener() {} };
    }
    const context = { URL, location: { href: 'http://127.0.0.1/?token=test' }, document: {
        getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element,
    } };
    runInNewContext(source, context);
    return { render: context.render, get: (id) => elements.get(id) };
}
function state({ configured = true, confirmed = 0, pending = 0, failed = 0, problem = null, usd = '0', requests = confirmed + pending + failed } = {}) {
    return { sessionId: 'test', configured, problem, observationPeriods: [], records: [], coverage: 'Observed only', summary: {
        gatewayUsd: usd, counts: { confirmed, pending, failed, unresolved: 0, uniqueRequests: requests },
        models: requests ? [{ model: 'test/model', confirmed, requests, unknown: pending + failed, gatewayUsd: usd }] : [],
    } };
}
for (const [name, value, expected] of [
    ['missing credentials', { configured: false, failed: 2 }, 'Unavailable'],
    ['storage failure', { problem: 'Disk full', confirmed: 1 }, 'Unavailable'],
    ['pending billing', { pending: 2 }, 'Pending'],
    ['failed lookup', { failed: 2 }, 'Unknown'],
    ['no recorded calls', {}, 'No charges yet'],
    ['verified zero-cost request', { confirmed: 1 }, '$0.00'],
    ['verified nonzero partial total', { confirmed: 1, failed: 1, usd: '0.123' }, '$0.123'],
]) {
    test(`canvas distinguishes ${name}`, () => {
        const ui = renderer(); ui.render(state(value));
        assert.equal(ui.get('spend').textContent, expected);
        if (value.failed && !value.confirmed) {
            assert.equal(ui.get('model-list').children[0].children[1].textContent, 'Unknown');
        }
        if (value.configured === false) assert.match(ui.get('reconciliation-message').textContent, /No accessible Gateway key/);
    });
}
