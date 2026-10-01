import { missingKeyMessage } from './credentials.mjs';

export class LookupError extends Error {
    constructor(code, message, retryable = false) {
        super(message);
        this.code = code;
        this.retryable = retryable;
    }
}

const SCALE = 18;
const UNIT = 10n ** BigInt(SCALE);
export const isGenerationId = (id) => typeof id === 'string' && /^gen_[0-9A-HJKMNP-TV-Z]{26}$/i.test(id);

export function usdUnits(value) {
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Missing USD value');
    const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
    if (!match || !Number.isFinite(Number(value))) throw new Error('Invalid USD value');
    const exponent = Number(match[3] || 0);
    if (Math.abs(exponent) > 100) throw new Error('Invalid USD precision');
    const digits = BigInt(match[1] + (match[2] || ''));
    const shift = SCALE + exponent - (match[2] || '').length;
    if (shift >= 0) return digits * 10n ** BigInt(shift);
    const divisor = 10n ** BigInt(-shift);
    if (digits % divisor) throw new Error('Unsupported USD precision');
    return digits / divisor;
}

export function usdString(units) {
    const fraction = (units % UNIT).toString().padStart(SCALE, '0').replace(/0+$/, '');
    return `${units / UNIT}${fraction ? `.${fraction}` : ''}`;
}

export function normalizeGeneration(body, id) {
    const data = body?.data;
    if (!data || data.id !== id) throw new LookupError('invalid_response', 'Vercel returned a mismatched generation.');
    try {
        const gateway = usdUnits(data.gateway_cost ?? data.total_cost);
        if (data.gateway_cost !== undefined && data.total_cost !== undefined && gateway !== usdUnits(data.total_cost)) {
            throw new Error('Inconsistent charge');
        }
        const result = { gatewayUsd: usdString(gateway) };
        for (const [source, target] of [['surcharge_cost', 'surchargeUsd'], ['upstream_inference_cost', 'upstreamListUsd']]) {
            if (data[source] !== undefined) result[target] = usdString(usdUnits(data[source]));
        }
        if (typeof data.model === 'string') result.model = data.model.slice(0, 200);
        if (typeof data.provider_name === 'string') result.provider = data.provider_name.slice(0, 100);
        if (typeof data.is_byok === 'boolean') result.upstreamByok = data.is_byok;
        return result;
    } catch {
        throw new LookupError('invalid_response', 'Vercel returned an invalid USD charge.');
    }
}

export function createGateway({ apiKey, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signal } = {}) {
    return {
        configured: Boolean(apiKey),
        async lookup(id) {
            if (!apiKey) throw new LookupError('missing_key', missingKeyMessage);
            if (!isGenerationId(id)) throw new LookupError('unsupported_id', 'The provider did not expose a Gateway generation ID.');
            for (let attempt = 0; attempt < 5; attempt++) {
                if (signal?.aborted) throw new LookupError('stopped', 'Lookup stopped.', true);
                let response;
                try {
                    const timeout = AbortSignal.timeout(10000);
                    response = await fetchImpl(`https://ai-gateway.vercel.sh/v1/generation?id=${encodeURIComponent(id)}`, {
                        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
                        redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
                    });
                } catch {
                    if (signal?.aborted) throw new LookupError('stopped', 'Lookup stopped.', true);
                    if (attempt === 4) throw new LookupError('network', 'Vercel lookup failed. Check connectivity and retry.', true);
                    await sleep(1000 * 2 ** attempt);
                    continue;
                }
                if (response.ok) {
                    try { return normalizeGeneration(await response.json(), id); }
                    catch (error) {
                        if (error instanceof LookupError) throw error;
                        throw new LookupError('invalid_response', 'Vercel returned an unreadable generation.');
                    }
                }
                if (response.status === 401 || response.status === 403) {
                    throw new LookupError('authentication', 'Vercel denied access. Check your Gateway key and its team.');
                }
                const retryable = response.status === 404 || response.status === 429 || response.status >= 500;
                if (!retryable || attempt === 4) {
                    const code = response.status === 404 ? 'not_found' : response.status === 429 ? 'rate_limit' : 'lookup_failed';
                    throw new LookupError(code, response.status === 404
                        ? 'Generation not available yet, or not accessible with this key. Retry lookups.'
                        : response.status === 429 ? 'Vercel rate limit reached. Retry later.' : 'Vercel lookup failed. Retry later.', retryable);
                }
                const retryHeader = response.headers.get('retry-after');
                const delay = retryHeader === null ? 1000 * 2 ** attempt
                    : /^\d+$/.test(retryHeader) ? Number(retryHeader) * 1000 : Date.parse(retryHeader) - Date.now();
                if (Number.isFinite(delay) && delay > 30000) throw new LookupError('rate_limit', 'Vercel requested a longer wait. Retry later.', true);
                await sleep(Math.max(1000, Number.isFinite(delay) ? delay : 1000 * 2 ** attempt));
            }
        },
    };
}
