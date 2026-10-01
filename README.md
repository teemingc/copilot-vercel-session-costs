# Gateway session costs

A personal Copilot Desktop canvas extension for actual Vercel AI Gateway charges. Installed in `~/.copilot/extensions/vercel-session-costs/` (or `$COPILOT_HOME/extensions/vercel-session-costs/`). No build or dependencies are required; Copilot resolves its SDK.

## Installation

In Copilot Desktop, choose **Install extension from gist…** in the command palette and enter this repository-folder URL (repository access is required):

```text
https://github.com/teemingc/copilot-vercel-session-costs/tree/main
```

Alternatively, clone the repository directly into the user extension directory:

```sh
git clone https://github.com/teemingc/copilot-vercel-session-costs.git "${COPILOT_HOME:-$HOME/.copilot}/extensions/vercel-session-costs"
```

Do not clone over an existing installation. Reload extensions after installation. Each user supplies their own Gateway API key; this repository contains no credentials or session ledgers.

## Setup

1. Your Copilot session must already use a custom model provider routed through Vercel AI Gateway. Standard Copilot subscription usage does not create Vercel charges.
2. On macOS, open **Keychain Access** and create a password item named `copilot-ai-gateway`, with your Gateway key as its password. Open the original Copilot app normally; no special launcher, `.zshrc` entry, or environment variable is needed. Do not paste the key into chat, this folder, provider logs, or the canvas.
   If the saved item cannot be found, run this in Terminal to create an exact-service match with a private password prompt:

   ```sh
   security add-generic-password -a "$USER" -s copilot-ai-gateway -T "" -w
   ```

   Enter the Gateway key only at the password prompt, never as a command argument. This does not overwrite an existing matching item. The empty trusted-app list leaves access subject to macOS approval.

3. Reload extensions and allow Keychain access if macOS prompts. The extension reads only that named item through `/usr/bin/security`; it does not bypass Keychain permissions or modify the item's access-control settings. Missing or denied credentials show setup guidance and do not stop usage recording. After a successful reload, previously recorded requests that failed solely because the key was missing are retried automatically.
4. Ask Copilot: **“Open the Gateway session costs canvas.”** Open it inside each session whose costs you want to view. Reload extensions in already-running sessions to begin recording there; newly started local sessions discover this user extension automatically.

Tracking runs even when the canvas is closed. This installation is for local Copilot Desktop runtimes, not cloud agents.

### Alternative environment setup

`AI_GATEWAY_API_KEY` remains supported when the Keychain item is unavailable, including on non-macOS platforms. Set it in Copilot's inherited environment and reload extensions. The SDK asks permission to expose only this variable when it is set and filtered; denying that request rejects extension startup. An already-running app does not acquire a newly exported terminal variable. A usable Keychain credential takes priority, and no environment access is requested in that case.

Keychain reads are bounded to 15 seconds. Cancellation, timeout, missing items, empty passwords and denied access all leave billing unconfigured unless an approved environment key is available. Errors never include command output or the key. Reload after creating, changing or unlocking the item. macOS may ask for access again; the extension does not silently grant persistent access to `/usr/bin/security`. The key is encrypted at rest but exists in the extension process's memory while it runs.

## What the numbers mean

**Confirmed Gateway spend** sums successfully verified generation debits in USD. Pending and unknown charges are not included. Without any verified charges, the canvas shows **Unavailable** (missing credentials/storage), **Pending**, **Unknown**, or **No charges yet**, rather than a misleading `$0.00`. Model subtotals with no verified requests show **Unknown**. Zero is displayed only when at least one actual zero-cost charge has been verified. A partial sum may still omit unpriced requests.

On macOS, the Keychain lookup first matches the exact service `copilot-ai-gateway`, then the exact item label if that service is not found. Access denial or timeout does not trigger another password-read attempt.

- Requests correlate using the SDK's `assistant.usage.data.apiCallId`, if it is a documented Gateway `gen_<ulid>` ID. Some provider adapters expose another ID or none; those requests remain unknown. The extension does not intercept or reroute inference traffic.
- The API lookup must return the same generation ID and a valid `gateway_cost` / `total_cost`. These already include surcharges; surcharge details are not added again.
- Upstream BYOK list inference prices, when returned by Vercel, are displayed separately. They are not a provider invoice or an additional Gateway debit.
- Copilot's billing multiplier is not a USD charge and is ignored.
- Tiny charges are displayed without rounding to apparent zero. Decimal sums are calculated with exact fixed-point arithmetic up to 18 decimal places.

## Session boundaries and history

The extension subscribes to live usage events after it joins a session. Copilot marks those events ephemeral; they are not available in persisted conversation history. Calls before installation, before reload in an existing session, or while the extension was disconnected cannot be recovered. Totals are always **observed charges**, not a guaranteed historical session bill.

Records are stored in `vercel-session-costs.json` inside the SDK-provided session workspace, validated against that session's actual ID. If session storage is unavailable or its ledger is malformed, the canvas shows an error instead of replacing an existing file. Observation periods document starts and graceful stops; abrupt disconnections may leave a period without a stop time, and are not evidence of uninterrupted recording.

Usage from sub-agents emitted in the same runtime is attributed in the request ledger. Independently created nested sessions have their own ledger and are not summed into a parent's costs. Opening multiple panels does not duplicate costs. Reloading restores this extension's recorded charges and retries pending lookups.

## Controls and actions

- **Retry lookups**: retry unconfirmed requests with usable generation IDs. Requests without such an ID cannot be priced by retrying. No model requests are generated.
- **Export JSON**: download observed usage metadata, charges and coverage, without credentials or conversation content.
- Agent-facing actions: `get_summary`, `retry_lookups`, `export_costs`; they take an empty object and are scoped to the current session.

Lookups retry ingestion-delay 404s, network failures, rate limits and server failures with bounded concurrency and backoff. Longer `Retry-After` values defer work for manual retry. Authentication failures halt new lookups until retry/reload. Confirmed charges are never fetched again simply because a panel opens.

## Privacy and troubleshooting

Only completion IDs are sent to Vercel's documented HTTPS generation endpoint. No prompts, responses, source code or session identifiers are sent. The key stays in the provider process; it never appears in HTML, exports, ledgers or action results. Browser endpoints bind to loopback, require a random per-panel capability token, and reject cross-origin mutations. Do not share the canvas's live capability URL.

- **Connect your Gateway key**: create or unlock the `copilot-ai-gateway` password item in macOS Keychain Access, reload extensions, and approve Keychain access if prompted. `AI_GATEWAY_API_KEY` is an alternative.
- **Vercel denied access**: check the key belongs to the team that served the request, then retry.
- **No Gateway generation ID**: your provider adapter did not expose a supported ID. This version deliberately reports unknown rather than guessing from account-wide spend.
- **Generation not available yet**: ingestion may be delayed, or this key may not access the record. Retry later.
- **Could not read/save ledger**: check session workspace permissions and inspect its artifact. Malformed files are not overwritten on initialization.
- **Reconnecting**: reopen the canvas after the extension reconnects; tracking survives panel closure while the provider remains loaded.

Use Copilot's extension **list** / **inspect** tools to diagnose provider startup failures. No API key is needed to run the focused tests:

```sh
node --test tests/*.test.mjs
```
