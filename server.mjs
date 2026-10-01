import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/canvas.css', ['canvas.css', 'text/css; charset=utf-8']],
    ['/canvas.js', ['canvas.js', 'text/javascript; charset=utf-8']],
]);

export async function startServer(tracker) {
    const token = randomBytes(32).toString('hex');
    const streams = new Set();
    let origin;
    const sendState = () => {
        const payload = `data: ${JSON.stringify(tracker.state())}\n\n`;
        for (const stream of streams) stream.write(payload);
    };
    const server = createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'");
        const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
        try {
            const url = new URL(req.url || '/', origin);
            const presented = Buffer.from(url.searchParams.get('token') || '');
            const expected = Buffer.from(token);
            if (req.headers.host !== new URL(origin).host || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
                return json(403, { error: 'Access denied.' });
            }
            if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: 'Origin denied.' });
            if (!['GET', 'POST'].includes(req.method)) return json(405, { error: 'Method not allowed.' });
            if (req.method === 'POST') {
                if (url.pathname !== '/retry') return json(404, { error: 'Not found.' });
                if (req.headers.origin !== origin) return json(403, { error: 'Origin required.' });
                if (Number(req.headers['content-length'] || 0) > 1024) return json(413, { error: 'Body too large.' });
                let bytes = 0;
                for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024) return json(413, { error: 'Body too large.' }); }
                return json(200, await tracker.retry());
            }
            if (url.pathname === '/state') return json(200, tracker.state());
            if (url.pathname === '/export') {
                res.setHeader('Content-Disposition', 'attachment; filename="vercel-session-costs.json"');
                return json(200, tracker.state());
            }
            if (url.pathname === '/events') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
                streams.add(res); res.write(`data: ${JSON.stringify(tracker.state())}\n\n`);
                req.on('close', () => streams.delete(res)); return;
            }
            const asset = assets.get(url.pathname);
            if (!asset) return json(404, { error: 'Not found.' });
            const content = await readFile(new URL(`./assets/${asset[0]}`, import.meta.url), 'utf8');
            res.writeHead(200, { 'Content-Type': asset[1] });
            res.end(content.replaceAll('__CANVAS_TOKEN__', token));
        } catch { if (!res.headersSent) json(500, { error: 'Could not load costs.' }); else res.end(); }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${server.address().port}`;
    tracker.on('change', sendState);
    const heartbeat = setInterval(() => { for (const stream of streams) stream.write(': keepalive\n\n'); }, 15000);
    heartbeat.unref();
    return {
        url: `${origin}/?token=${token}`,
        async close() {
            clearInterval(heartbeat); tracker.off('change', sendState);
            for (const stream of streams) stream.end(); streams.clear();
            await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
        },
    };
}
