# Gateway session costs

Track actual Vercel AI Gateway spending per session in a Copilot Desktop canvas. Requires a custom provider routed through Vercel AI Gateway; standard Copilot subscription usage is not tracked. No build or dependencies needed.

## Install

Choose **Install extension from gist…** in Copilot's command palette and enter:

```text
https://github.com/teemingc/copilot-vercel-session-costs/tree/main
```

Repository access is required while it is private.

## Set up

On macOS, run this in Terminal to store your Gateway API key in the login Keychain:

```sh
security add-generic-password -a "$USER" -s copilot-ai-gateway -T "" -w
```

Enter the key at the password prompt—not in the command or chat. This does not overwrite an existing matching item. Alternatively, create an **application password** named `copilot-ai-gateway` in Keychain Access's **login** keychain.

Then ask Copilot to **reload extensions**, allow Keychain access if prompted, and **open the Gateway session costs canvas**. Repeat the reload in already-running sessions you want to track.

On other platforms, supply `AI_GATEWAY_API_KEY` in Copilot's launch environment and approve extension access to it.

## What to expect

- Totals include only verified Gateway charges in USD. Pending or unknown charges are not zero and are excluded.
- Tracking starts when the extension loads; earlier calls and disconnected periods cannot be recovered. Separate sessions have separate totals.
- Charges are saved per session, and tracking continues with the canvas closed.
- **Retry lookups** retries unpriced requests; **Export JSON** downloads the ledger.
- Credentials stay out of exports and ledgers. Billing lookups send generation IDs to Vercel, not conversation content. Don't share the canvas's live URL.

If costs show **Unavailable**, check your key and reload. If Vercel denies access, use a key for the team that served the requests.
