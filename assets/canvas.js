const $ = (id) => document.getElementById(id);
const token = new URL(location.href).searchParams.get('token');
const endpoint = (path) => `${path}?token=${encodeURIComponent(token)}`;
let state;
let retrying = false;
const number = (value) => Number.isSafeInteger(value) ? value.toLocaleString() : '—';
function money(value) {
    const [whole, fraction = ''] = String(value).split('.');
    return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.padEnd(2, '0')}`;
}
function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}
function setConnection(online) {
    $('connection').textContent = online ? 'Live' : 'Reconnecting…';
    $('connection').classList.toggle('offline', !online);
}
function render(next) {
    state = next;
    $('session-id').textContent = state.sessionId;
    $('setup').hidden = state.configured;
    $('problem').hidden = !state.problem;
    $('problem').textContent = state.problem || '';
    const counts = state.summary.counts;
    const unknown = counts.unresolved + counts.failed;
    $('spend').textContent = state.problem || (!state.configured && !counts.confirmed) ? 'Unavailable'
        : !counts.confirmed ? counts.pending ? 'Pending' : counts.uniqueRequests ? 'Unknown' : 'No charges yet'
        : money(state.summary.gatewayUsd);
    $('confirmed').textContent = number(counts.confirmed);
    $('pending').textContent = number(counts.pending);
    $('unknown').textContent = number(unknown);
    $('reconciliation-message').textContent = state.problem ? 'Recorded charges could not be loaded or saved.'
        : !state.configured ? `No accessible Gateway key. ${number(counts.uniqueRequests)} observed requests have been recorded; unverified charges are not zero.`
        : !counts.confirmed && counts.uniqueRequests ? 'No charges verified yet. Check the request ledger for lookup errors or pending requests.'
        : unknown + counts.pending > 0 ? `${number(unknown + counts.pending)} observed request${unknown + counts.pending === 1 ? '' : 's'} not priced. This is a partial total.`
        : counts.uniqueRequests ? 'Every observed request is priced. Earlier usage may be missing.' : 'No calls recorded yet. This is not a full-session bill.';
    $('coverage').textContent = state.coverage;
    $('tracking-since').textContent = state.startedAt ? `Recording since ${new Date(state.startedAt).toLocaleString()} · ${state.observationPeriods.length} recording period${state.observationPeriods.length === 1 ? '' : 's'}` : '';
    $('retry').disabled = retrying || !state.configured || Boolean(state.problem);
    const modelRows = state.summary.models.map((model) => {
        const row = node('div', undefined, 'model-row');
        const label = node('div');
        label.append(node('p', model.model, 'model-name'), node('p', `${number(model.requests)} request${model.requests === 1 ? '' : 's'}${model.unknown ? ` · ${number(model.unknown)} not priced` : ''}`, 'model-detail'));
        row.append(label, node('span', model.confirmed ? money(model.gatewayUsd) : 'Unknown', 'amount'));
        return row;
    });
    $('model-list').replaceChildren(...(modelRows.length ? modelRows : [node('p', 'No recorded requests yet.', 'empty')]));
    $('request-count').textContent = `${number(counts.uniqueRequests)} observed`;
    $('empty').hidden = state.records.length > 0;
    $('ledger-wrapper').hidden = state.records.length === 0;
    const rows = [...state.records].reverse().map((record) => {
        const row = node('tr');
        const label = node('td');
        const time = node('time', new Date(record.timestamp).toLocaleTimeString()); time.dateTime = record.timestamp;
        label.append(time, node('p', record.model, 'cell-model'));
        const attribution = record.agentId ? `Sub-agent ${record.agentId}` : record.interactionType || 'Main agent';
        label.append(node('p', attribution, 'cell-detail'));
        if (record.reason) label.append(node('p', record.reason, 'cell-detail'));
        const input = node('td', number(record.inputTokens), 'token-count');
        if (record.cacheReadTokens !== undefined) input.append(node('p', `${number(record.cacheReadTokens)} cache read`, 'cell-detail'));
        if (record.cacheWriteTokens !== undefined) input.append(node('p', `${number(record.cacheWriteTokens)} cache write`, 'cell-detail'));
        const output = node('td', number(record.outputTokens), 'token-count');
        if (record.reasoningTokens !== undefined) output.append(node('p', `${number(record.reasoningTokens)} reasoning`, 'cell-detail'));
        const charge = node('td');
        if (record.status === 'confirmed') {
            charge.append(node('span', money(record.charge.gatewayUsd), 'amount'));
            if (record.charge.surchargeUsd && record.charge.surchargeUsd !== '0') charge.append(node('p', `Includes ${money(record.charge.surchargeUsd)} surcharge`, 'cell-detail'));
            if (record.charge.upstreamByok && record.charge.upstreamListUsd) charge.append(node('p', `${money(record.charge.upstreamListUsd)} upstream list price (separate)`, 'cell-detail'));
        } else {
            charge.append(node('span', record.status === 'pending' ? 'Pending' : record.status === 'failed' ? 'Unknown · error' : 'Unknown', `status ${record.status}`));
        }
        row.append(label, input, output, charge); return row;
    });
    $('ledger').replaceChildren(...rows);
}
$('retry').addEventListener('click', async () => {
    retrying = true; $('retry').disabled = true; $('retry').textContent = 'Retrying…';
    try {
        const response = await fetch(endpoint('/retry'), { method: 'POST' });
        if (!response.ok) throw new Error();
        const result = await response.json();
        $('feedback').textContent = result.queued ? `${result.queued} lookup${result.queued === 1 ? '' : 's'} queued.` : result.reason;
    } catch { $('feedback').textContent = 'Could not retry. Reopen the canvas and try again.'; }
    finally { retrying = false; $('retry').textContent = 'Retry lookups'; if (state) render(state); }
});
async function connect() {
    try {
        const response = await fetch(endpoint('/state'));
        if (!response.ok) throw new Error();
        render(await response.json());
    } catch { $('feedback').textContent = 'Could not load costs. Reopen the canvas after extensions reconnect.'; }
    const events = new EventSource(endpoint('/events'));
    events.onopen = () => setConnection(true);
    events.onerror = () => setConnection(false);
    events.onmessage = (event) => {
        try { render(JSON.parse(event.data)); setConnection(true); }
        catch { $('feedback').textContent = 'Could not read the latest update. Reopen the canvas.'; }
    };
    window.addEventListener('pagehide', () => events.close(), { once: true });
}
connect();
