import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function readGatewayKeychain({ platform = process.platform, execFileImpl = run } = {}) {
    if (platform !== 'darwin') return undefined;
    for (const selector of ['-s', '-l']) {
        try {
            const { stdout } = await execFileImpl('/usr/bin/security', ['find-generic-password', selector, 'copilot-ai-gateway', '-w'], {
                encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true,
            });
            const key = typeof stdout === 'string' ? stdout.trim() : '';
            return key && key.length <= 16384 ? key : undefined;
        } catch (error) {
            if (error?.code !== 44 || selector === '-l') return undefined;
        }
    }
}

export const missingKeyMessage = 'Add copilot-ai-gateway in macOS Keychain Access, or set AI_GATEWAY_API_KEY, then reload extensions.';
