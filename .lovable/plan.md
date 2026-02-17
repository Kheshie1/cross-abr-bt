

## Automatically Fetch Proxy URL from Evoxt API

### Problem
The current `PROXY_URL` secret is hardcoded and breaks when the VPS IP changes or the proxy service goes down. The edge function currently gets "Connection refused" errors.

### Solution
Use the Evoxt API to dynamically fetch the VPS server IP at runtime, then construct the proxy URL from it automatically.

### How It Works

1. The edge function calls `GET https://api.evoxt.com/listservers?username=YOUR_USERNAME` with Basic auth
2. The response contains all servers with their `primaryip` field
3. The function picks the first active server's IP and constructs the proxy URL (e.g., `http://IP:8080`)
4. This replaces the static `PROXY_URL` secret

### Steps

**Step 1: Store Evoxt Credentials as Secrets**
- `EVOXT_PUBLIC_KEY` - your public key (already provided)
- `EVOXT_PRIVATE_KEY` - your private key (needed from you)
- `EVOXT_USERNAME` - your Evoxt account username (needed from you)

**Step 2: Update the Edge Function**
Modify `supabase/functions/polymarket-trade/index.ts`:

- Add a new `getProxyUrlFromEvoxt()` function that:
  - Reads `EVOXT_PUBLIC_KEY`, `EVOXT_PRIVATE_KEY`, `EVOXT_USERNAME` from env
  - Calls `GET https://api.evoxt.com/listservers?username={username}` with `Authorization: Basic base64(publickey:privatekey)`
  - Parses the response to find the first active server's `primaryip`
  - Returns `http://{primaryip}:8080` as the proxy URL
  - Caches the result so it doesn't call Evoxt on every trade

- Update the `proxiedFetch()` function to:
  - First try `PROXY_URL` env var (manual override)
  - If not set, call `getProxyUrlFromEvoxt()` to get the IP dynamically
  - Use the result to route Polymarket orders through the VPS

**Step 3: Optional - Add a "vps_status" Action**
Add a new action to the edge function that returns the VPS details from Evoxt (IP, status, OS) so the dashboard can show VPS health.

### Technical Details

```text
Edge Function Flow:
  proxiedFetch() called
       |
       v
  PROXY_URL env set? --yes--> use it directly
       |
       no
       v
  getProxyUrlFromEvoxt()
       |
       v
  GET https://api.evoxt.com/listservers?username=xxx
  Authorization: Basic base64(pubkey:privkey)
       |
       v
  Parse response -> find active server -> primaryip
       |
       v
  Construct http://{ip}:8080 -> use as proxy
```

### What We Need From You
- Your **Evoxt private key** (from https://console.evoxt.com/apicredentials.php)
- Your **Evoxt username** (your login username)

