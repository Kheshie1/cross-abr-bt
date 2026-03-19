import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Wallet, utils } from "https://esm.sh/ethers@5.7.2?bundle";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GAMMA_URL = "https://gamma-api.polymarket.com";
const KALSHI_URL = "https://api.elections.kalshi.com/trade-api/v2";
const CLOB_URL = "https://clob.polymarket.com";
const MYRIAD_URL = "https://api-v2.myriadprotocol.com";

// ──────────── KALSHI RSA-PSS AUTH ────────────

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [\w ]+-----/g, "")
    .replace(/-----END [\w ]+-----/g, "")
    .replace(/\s/g, "");
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

// Convert PKCS#1 (RSA PRIVATE KEY) to PKCS#8 format for WebCrypto
function pkcs1ToPkcs8(pkcs1Der: ArrayBuffer): ArrayBuffer {
  const pkcs1Bytes = new Uint8Array(pkcs1Der);
  // PKCS#8 wraps PKCS#1 with an AlgorithmIdentifier header
  // OID for rsaEncryption: 1.2.840.113549.1.1.1
  const oid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const algorithmId = new Uint8Array([0x30, oid.length, ...oid]);
  
  // Wrap PKCS#1 key in OCTET STRING
  const keyLenBytes = encodeDerLength(pkcs1Bytes.length);
  const octetString = new Uint8Array([0x04, ...keyLenBytes, ...pkcs1Bytes]);
  
  // Version INTEGER 0
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  
  // SEQUENCE { version, algorithmIdentifier, privateKey }
  const innerLen = version.length + algorithmId.length + octetString.length;
  const innerLenBytes = encodeDerLength(innerLen);
  const pkcs8 = new Uint8Array([0x30, ...innerLenBytes, ...version, ...algorithmId, ...octetString]);
  return pkcs8.buffer;
}

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  if (len < 0x100) return new Uint8Array([0x81, len]);
  return new Uint8Array([0x82, (len >> 8) & 0xff, len & 0xff]);
}

async function kalshiSign(privateKeyPem: string, timestamp: string, method: string, path: string): Promise<string> {
  const pathOnly = path.split("?")[0];
  const message = `${timestamp}${method}${pathOnly}`;
  const msgBytes = new TextEncoder().encode(message);

  let keyData = pemToArrayBuffer(privateKeyPem);
  
  // Auto-detect PKCS#1 vs PKCS#8 and convert if needed
  if (privateKeyPem.includes("RSA PRIVATE KEY")) {
    keyData = pkcs1ToPkcs8(keyData);
  }
  
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    cryptoKey,
    msgBytes
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function kalshiHeaders(method: string, path: string): Promise<Record<string, string>> {
  const apiKey = Deno.env.get("KALSHI_API_KEY");
  const privateKeyPem = Deno.env.get("KALSHI_PRIVATE_KEY");
  if (!apiKey || !privateKeyPem) throw new Error("Kalshi credentials not configured");

  const timestamp = String(Date.now());
  const signature = await kalshiSign(privateKeyPem, timestamp, method, path);

  return {
    "KALSHI-ACCESS-KEY": apiKey,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "Content-Type": "application/json",
  };
}

async function fetchKalshiBalance(): Promise<{ balance: number; portfolio_value: number }> {
  const path = "/trade-api/v2/portfolio/balance";
  const headers = await kalshiHeaders("GET", path);
  const res = await fetch(`https://api.elections.kalshi.com${path}`, { headers });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kalshi balance failed [${res.status}]: ${err}`);
  }
  const data = await res.json();
  return {
    balance: (data.balance || 0) / 100, // cents to dollars
    portfolio_value: (data.portfolio_value || 0) / 100,
  };
}

async function placeKalshiOrder(
  ticker: string,
  side: "yes" | "no",
  yesPrice: number, // 0-1 range
  sizeUsd: number,
): Promise<any> {
  const path = "/trade-api/v2/portfolio/orders";
  const headers = await kalshiHeaders("POST", path);

  // Kalshi prices are in cents (1-99)
  const priceCents = Math.round(yesPrice * 100);
  // Actual cost per contract depends on which side we're buying
  const costPerContractCents = side === "yes" ? priceCents : (100 - priceCents);
  const count = Math.max(1, Math.floor(sizeUsd / (costPerContractCents / 100)));
  const clientOrderId = crypto.randomUUID();

  const body = {
    ticker,
    client_order_id: clientOrderId,
    type: "limit",
    action: "buy",
    side,
    count,
    yes_price: side === "yes" ? priceCents : undefined,
    no_price: side === "no" ? (100 - priceCents) : undefined,
  };

  console.log(`Kalshi order: ${JSON.stringify(body)}`);

  const res = await fetch(`https://api.elections.kalshi.com${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Kalshi order failed [${res.status}]: ${JSON.stringify(data)}`);
  }

  console.log(`✅ Kalshi order placed: ${ticker} ${side} @ ${priceCents}¢ × ${count}`);
  return data.order || data;
}

// ──────────── ORDER SIGNING CONSTANTS ────────────
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const KNOWN_WALLET = "0xb34ff4C3134eb683F7fA8f1E090d567e13bEC7D2";
const KNOWN_WALLET_2 = "0x2F736345aC40441Bd4b28f896d122c954f09BA11";

const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
};
// ──────────── POLYMARKET AUTH & PROXY ────────────

// Constants for deterministic proxy wallet derivation (CREATE2)
const PROXY_FACTORY = "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";
const PROXY_IMPL = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";

// Gnosis Safe proxy (used by browser-based Polymarket accounts)
const SAFE_FACTORY = "0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC";
const SAFE_SINGLETON = "0x69f4D1788e39c87893C980c06EdF4b7f686e2938";

// Derive EIP-1167 minimal proxy address
function deriveProxyAddress(eoaAddress: string): string {
  try {
    const salt = utils.keccak256(
      utils.solidityPack(["address", "address"], [eoaAddress, PROXY_IMPL])
    );
    const implNoPrefix = PROXY_IMPL.toLowerCase().replace("0x", "");
    const initCode = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" + implNoPrefix + "5af43d82803e903d91602b57fd5bf3";
    const initCodeHash = utils.keccak256(initCode);
    return utils.getCreate2Address(PROXY_FACTORY, salt, initCodeHash);
  } catch (e) {
    console.warn("CREATE2 proxy derivation failed:", e);
    return eoaAddress;
  }
}

// Derive Gnosis Safe proxy address
function deriveSafeAddress(eoaAddress: string): string {
  try {
    const abiCoder = new utils.AbiCoder();
    const initializer = abiCoder.encode(
      ["address[]", "uint256", "address", "bytes", "address", "address", "uint256", "address"],
      [[eoaAddress], 1, "0x0000000000000000000000000000000000000000", "0x", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0, "0x0000000000000000000000000000000000000000"]
    );
    const salt = utils.keccak256(
      utils.solidityPack(["bytes32", "uint256"], [utils.keccak256(initializer), 0])
    );
    const singletonNoPrefix = SAFE_SINGLETON.toLowerCase().replace("0x", "");
    const creationCode = "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003257600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555050609b806101296000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2646970667358221220d1429297349653a4918076d650332de1a1068c5f3e07c5c82360c277770b955264736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564" + abiCoder.encode(["address"], [SAFE_SINGLETON]).replace("0x", "");
    const initCodeHash = utils.keccak256(creationCode);
    return utils.getCreate2Address(SAFE_FACTORY, salt, initCodeHash);
  } catch (e) {
    console.warn("Safe derivation failed:", e);
    return "";
  }
}

const CLOB_DOMAIN = {
  name: "ClobAuthDomain",
  version: "1",
  chainId: 137,
};

const CLOB_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
};

async function buildL1Headers(privateKey: string): Promise<Record<string, string>> {
  const wallet = new Wallet(privateKey);
  const timestamp = Math.floor(Date.now() / 1000);
  const value = {
    address: wallet.address,
    timestamp: String(timestamp),
    nonce: 0,
    message: "This message attests that I control the given wallet",
  };
  const sig = await wallet._signTypedData(CLOB_DOMAIN, CLOB_TYPES, value);
  return {
    "POLY_ADDRESS": wallet.address,
    "POLY_SIGNATURE": sig,
    "POLY_TIMESTAMP": String(timestamp),
    "POLY_NONCE": "0",
  };
}

// Derive fresh L2 API credentials
async function deriveL2Creds(privateKey: string): Promise<{ apiKey: string; secret: string; passphrase: string }> {
  const l1Headers = await buildL1Headers(privateKey);
  const deriveRes = await fetch(`${CLOB_URL}/auth/derive-api-key`, {
    method: "GET",
    headers: l1Headers,
  });
  if (!deriveRes.ok) {
    const errText = await deriveRes.text();
    throw new Error(`Derive API key failed [${deriveRes.status}]: ${errText}`);
  }
  const creds = await deriveRes.json();
  console.log("Derived fresh L2 creds");
  return creds;
}

// Build HMAC-signed L2 headers for a specific request
async function buildL2Headers(privateKey: string, creds: { apiKey: string; secret: string; passphrase: string }, method: string, path: string): Promise<Record<string, string>> {
  const wallet = new Wallet(privateKey);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method + path;

  const secretBytes = Uint8Array.from(
    atob(creds.secret.replace(/-/g, "+").replace(/_/g, "/")),
    c => c.charCodeAt(0)
  );
  const key = await crypto.subtle.importKey(
    "raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const hmacSig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/\+/g, "-").replace(/\//g, "_");

  return {
    "POLY_ADDRESS": wallet.address,
    "POLY_API_KEY": creds.apiKey,
    "POLY_SIGNATURE": hmacSig,
    "POLY_TIMESTAMP": timestamp,
    "POLY_PASSPHRASE": creds.passphrase,
  };
}

// Fetch USDC cash balance from L2 (EOA wallet)
async function fetchCashBalance(privateKey: string): Promise<{ balance: number; allowance: number }> {
  const creds = await deriveL2Creds(privateKey);
  const headers = await buildL2Headers(privateKey, creds, "GET", "/balance-allowance");
  const balRes = await fetch(`${CLOB_URL}/balance-allowance?asset_type=COLLATERAL`, { headers });
  if (!balRes.ok) {
    const errText = await balRes.text();
    throw new Error(`Balance fetch failed [${balRes.status}]: ${errText}`);
  }
  const data = await balRes.json();
  return { balance: Number(data.balance || 0) / 1e6, allowance: Number(data.allowance || 0) / 1e6 };
}

// Fetch on-chain USDC balance for any wallet address via Polygon RPC
const POLYGON_RPC = "https://polygon-rpc.com";
const USDC_CONTRACT = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e on Polygon

async function fetchOnChainUSDC(walletAddress: string): Promise<number> {
  // ERC-20 balanceOf(address) selector = 0x70a08231
  const paddedAddr = walletAddress.slice(2).toLowerCase().padStart(64, "0");
  const callData = `0x70a08231${paddedAddr}`;
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: USDC_CONTRACT, data: callData }, "latest"],
  });
  const res = await fetch(POLYGON_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return parseInt(json.result || "0x0", 16) / 1e6;
}

// Fetch combined USDC cash: EOA L2 balance + known wallets on-chain
async function fetchTotalCashBalance(privateKey: string): Promise<{ balance: number; allowance: number; eoaBalance: number; knownWalletBalance: number }> {
  const [l2Bal, knownOnChain, known2OnChain] = await Promise.allSettled([
    fetchCashBalance(privateKey),
    fetchOnChainUSDC(KNOWN_WALLET),
    fetchOnChainUSDC(KNOWN_WALLET_2),
  ]);
  const eoa = l2Bal.status === "fulfilled" ? l2Bal.value : { balance: 0, allowance: 0 };
  const known = knownOnChain.status === "fulfilled" ? knownOnChain.value : 0;
  const known2 = known2OnChain.status === "fulfilled" ? known2OnChain.value : 0;
  console.log(`Cash breakdown: EOA=$${eoa.balance.toFixed(2)}, KNOWN_WALLET=$${known.toFixed(2)}, KNOWN_WALLET_2=$${known2.toFixed(2)}`);
  return {
    balance: eoa.balance + known + known2,
    allowance: eoa.allowance,
    eoaBalance: eoa.balance,
    knownWalletBalance: known + known2,
  };
}

// ──────────── EVOXT DYNAMIC PROXY ────────────

let cachedProxyUrl: string | null = null;
let cachedProxyExpiry = 0;
const PROXY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getProxyUrlFromEvoxt(): Promise<string | null> {
  if (cachedProxyUrl && Date.now() < cachedProxyExpiry) {
    return cachedProxyUrl;
  }

  const publicKey = Deno.env.get("EVOXT_PUBLIC_KEY");
  const privateKey = Deno.env.get("EVOXT_PRIVATE_KEY");
  const username = Deno.env.get("EVOXT_USERNAME");

  if (!publicKey || !privateKey || !username) {
    console.log("Evoxt credentials not configured, skipping dynamic proxy");
    return null;
  }

  try {
    const auth = btoa(`${publicKey}:${privateKey}`);
    const res = await fetch(`https://api.evoxt.com/listservers?username=${encodeURIComponent(username)}`, {
      headers: { "Authorization": `Basic ${auth}` },
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Evoxt API error [${res.status}]: ${err}`);
      return cachedProxyUrl; // return stale cache if available
    }

    const data = await res.json();
    // Find first active server with an IP
    let serverIp: string | null = null;
    if (Array.isArray(data)) {
      const active = data.find((s: any) => s.primaryip && s.status === "Active");
      if (active) serverIp = active.primaryip;
      else if (data.length > 0 && data[0].primaryip) serverIp = data[0].primaryip;
    } else if (typeof data === "object") {
      // Response might be keyed by server ID
      for (const key of Object.keys(data)) {
        const s = data[key];
        if (s?.primaryip) {
          serverIp = s.primaryip;
          if (s.status === "Active") break;
        }
      }
    }

    if (!serverIp) {
      console.error("Evoxt: no server IP found in response");
      return cachedProxyUrl;
    }

    cachedProxyUrl = `http://${serverIp}:8080`;
    cachedProxyExpiry = Date.now() + PROXY_CACHE_TTL;
    console.log(`Evoxt: resolved proxy URL → ${cachedProxyUrl}`);
    return cachedProxyUrl;
  } catch (e) {
    console.error("Evoxt API call failed:", e);
    return cachedProxyUrl;
  }
}

// ──────────── PROXY HELPER ────────────

async function proxiedFetch(url: string, init: RequestInit): Promise<Response> {
  // Priority: PROXY_URL env var (manual override) → Evoxt dynamic → direct
  let proxyUrl = Deno.env.get("PROXY_URL") || null;
  if (!proxyUrl) {
    proxyUrl = await getProxyUrlFromEvoxt();
  }

  if (!proxyUrl) {
    console.log("No proxy available, using direct connection");
    return fetch(url, init);
  }

  const proxy = new URL(proxyUrl);
  const target = new URL(url);

  const proxyAuth = proxy.username
    ? `Basic ${btoa(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`)}`
    : undefined;

  const headers = new Headers(init.headers);
  headers.set("Host", target.host);

  const proxyHeaders: Record<string, string> = {};
  headers.forEach((v, k) => { proxyHeaders[k] = v; });
  if (proxyAuth) proxyHeaders["Proxy-Authorization"] = proxyAuth;

  const res = await fetch(url, {
    ...init,
    headers: proxyHeaders,
    // @ts-ignore - Deno supports client proxy
    client: Deno.createHttpClient({
      proxy: { url: `${proxy.protocol}//${proxy.host}`, basicAuth: proxy.username ? { username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) } : undefined },
    }),
  });

  return res;
}

// ──────────── ORDER SIGNING & PLACEMENT ────────────

// Round price to nearest tick (0.01)
function roundToTick(price: number): number {
  return Math.round(price * 100) / 100;
}

// Create, sign, and post an order to Polymarket CLOB (via proxy)
async function placePolymarketOrder(
  privateKey: string,
  tokenId: string,
  price: number,
  size: number,
  side: "BUY" | "SELL" = "BUY",
  negRisk: boolean = true,
): Promise<any> {
  const wallet = new Wallet(privateKey);
  const creds = await deriveL2Creds(privateKey);

  // Round price to tick size
  const tickPrice = roundToTick(price);
  const sideInt = side === "BUY" ? 0 : 1;
  const signatureType = 0; // EOA

  // Amounts in raw units (6 decimals for both USDC and tokens)
  let makerAmount: string;
  let takerAmount: string;
  if (side === "BUY") {
    makerAmount = String(Math.round(tickPrice * size * 1e6)); // USDC to pay
    takerAmount = String(Math.round(size * 1e6)); // tokens to receive
  } else {
    // SELL: maker gives tokens, taker gives USDC
    makerAmount = String(Math.round(size * 1e6)); // tokens to give
    takerAmount = String(Math.round(tickPrice * size * 1e6)); // USDC to receive
  }

  const salt = String(Math.floor(Math.random() * 1e15));
  const exchangeAddress = negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE;

  const order = {
    salt,
    maker: wallet.address,
    signer: wallet.address,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId,
    makerAmount,
    takerAmount,
    expiration: "0",
    nonce: "0",
    feeRateBps: "0",
    side: sideInt,
    signatureType,
  };

  // EIP-712 sign
  const domain = { name: "CTFExchange", version: "1", chainId: 137, verifyingContract: exchangeAddress };
  const signature = await wallet._signTypedData(domain, ORDER_TYPES, order);

  // Build L2 auth headers for POST /order
  const l2Headers = await buildL2Headers(privateKey, creds, "POST", "/order");

  // Post to CLOB — routed through proxy to bypass geo-block
  const res = await proxiedFetch(`${CLOB_URL}/order`, {
    method: "POST",
    headers: { ...l2Headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      order: { ...order, signature, side, signatureType },
      owner: wallet.address,
      orderType: "GTC",
    }),
  });

  const resData = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Order failed [${res.status}]: ${JSON.stringify(resData)}`);
  }

  console.log(`✅ ${side} order placed via proxy: ${tokenId} @ $${tickPrice} × ${size}`);
  return resData;
}

// Derive fresh L2 creds using L1 auth, then use them for balance (legacy wrapper)
async function deriveAndFetchBalance(privateKey: string): Promise<any> {
  const creds = await deriveL2Creds(privateKey);
  const headers = await buildL2Headers(privateKey, creds, "GET", "/balance-allowance");
  const balRes = await fetch(`${CLOB_URL}/balance-allowance?asset_type=COLLATERAL`, { headers });
  if (!balRes.ok) {
    const errText = await balRes.text();
    throw new Error(`Balance fetch failed [${balRes.status}]: ${errText}`);
  }
  return balRes.json();
}

// ──────────── MATCHING ENGINE ────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Generate bigrams for fuzzy matching (more robust than single tokens)
function bigrams(s: string): Set<string> {
  const norm = normalize(s);
  const set = new Set<string>();
  for (let i = 0; i < norm.length - 1; i++) {
    set.add(norm.slice(i, i + 2));
  }
  return set;
}

// Dice coefficient — robust fuzzy similarity (0-1)
function diceCoefficient(a: string, b: string): number {
  const biA = bigrams(a);
  const biB = bigrams(b);
  if (biA.size === 0 || biB.size === 0) return 0;
  let intersection = 0;
  for (const bi of biA) {
    if (biB.has(bi)) intersection++;
  }
  return (2 * intersection) / (biA.size + biB.size);
}

// Extract key entities (proper nouns, numbers, named things)
function extractEntities(s: string): string[] {
  const norm = normalize(s);
  const stop = new Set([
    "will", "the", "does", "what", "when", "where", "who", "which",
    "that", "this", "with", "from", "into", "over", "under", "about",
    "before", "after", "between", "during", "above", "below", "more",
    "than", "next", "last", "first", "second", "third", "most",
    "each", "every", "other", "another", "some", "many", "much",
    "very", "just", "also", "only", "even", "still", "already",
    "been", "being", "have", "having", "here", "there",
    "win", "won", "lose", "lost", "beat", "game", "match",
    "price", "market", "high", "low", "day", "week", "month", "year",
    "today", "tomorrow", "yesterday", "points", "team",
    "cup", "open", "final", "finals",
    "2026", "2025", "2027",
  ]);
  return norm
    .split(" ")
    .filter((w) => w.length > 2 && !stop.has(w));
}

// Match quality — relaxed for more coverage
function matchMarkets(polyQ: string, kalshiQ: string, polyEnts: string[], kalshiEnts: Set<string>): number {
  const entityMatches = polyEnts.filter((e) => kalshiEnts.has(e));
  const matchCount = entityMatches.length;

  const dice = diceCoefficient(polyQ, kalshiQ);

  // Allow single entity match IF dice similarity is strong
  if (matchCount === 0) return 0;
  if (matchCount === 1 && dice < 0.35) return 0;

  const entityScore = matchCount / Math.max(polyEnts.length, kalshiEnts.size);

  // 55% entity, 45% bigram — more weight on fuzzy for broader matching
  const combined = entityScore * 0.55 + dice * 0.45;

  const bonus = matchCount >= 3 ? 0.1 : matchCount >= 2 ? 0.05 : 0;

  return Math.min(1, combined + bonus);
}

// ──────────── MARKET DATA ────────────

interface MarketData {
  id: string;
  question: string;
  yes_price: number;
  no_price: number;
  platform: "polymarket" | "kalshi" | "myriad";
  volume: number;
  end_date?: string;
  token_id_yes?: string;
  token_id_no?: string;
  ticker?: string;
  category?: string;
}

// ──────────── POLYMARKET FETCH ────────────

async function fetchPolymarkets(limit = 500): Promise<MarketData[]> {
  const res = await fetch(
    `${GAMMA_URL}/markets?closed=false&active=true&limit=${limit}&order=volume24hr&ascending=false`
  );
  if (!res.ok) throw new Error(`Gamma API error [${res.status}]`);
  const markets = await res.json();
  return markets
    .filter((m: any) => {
      const prices = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
      return prices.length >= 2 && Number(prices[0]) > 0 && Number(prices[1]) > 0;
    })
    .map((m: any) => {
      const tokens = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
      const prices = JSON.parse(m.outcomePrices).map(Number);
      return {
        id: m.conditionId || m.id,
        question: m.question || "",
        yes_price: prices[0],
        no_price: prices[1],
        platform: "polymarket" as const,
        volume: Number(m.volume24hr || 0),
        end_date: m.endDate,
        token_id_yes: tokens[0],
        token_id_no: tokens[1],
        category: m.groupSlug || "",
      };
    });
}

// ──────────── KALSHI FETCH (multi-page, MVE excluded) ────────────

async function fetchKalshiMarkets(maxPages = 10): Promise<MarketData[]> {
  const allMarkets: MarketData[] = [];
  let cursor: string | undefined;
  let skipMve = 0, skipType = 0, skipQ = 0, skipPrice = 0;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      limit: "1000",
      status: "open",
      mve_filter: "exclude",
    });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`${KALSHI_URL}/markets?${params}`);
    if (!res.ok) {
      console.error(`Kalshi API error [${res.status}]`);
      break;
    }
    const data = await res.json();
    const markets = data.markets || [];
    cursor = data.cursor;
    console.log(`Kalshi page ${page}: ${markets.length} markets (cursor: ${cursor ? "yes" : "no"})`);

    // Debug first page
    if (page === 0 && markets.length > 0) {
      const nonMve = markets.find((x: any) => !x.mve_collection_ticker);
      if (nonMve) {
        console.log(`First non-MVE: ticker=${nonMve.ticker} yes_ask=${nonMve.yes_ask_dollars} no_ask=${nonMve.no_ask_dollars} subtitle=${(nonMve.subtitle||"").slice(0,60)}`);
      } else {
        console.log(`ALL ${markets.length} markets on page ${page} are MVE legs`);
      }
      // Price distribution debug
      const priceRanges = { extreme: 0, mid: 0, cheap: 0, zero: 0, hasSubtitle: 0 };
      for (const x of markets) {
        const ya = parseFloat(x.yes_ask_dollars) || 0;
        const na = parseFloat(x.no_ask_dollars) || 0;
        if (ya <= 0.01 || na <= 0.01) priceRanges.zero++;
        else if (ya >= 0.99 || na >= 0.99) priceRanges.extreme++;
        else if (ya >= 0.90 || na >= 0.90) priceRanges.mid++;
        else priceRanges.cheap++;
        if ((x.subtitle || "").length >= 5) priceRanges.hasSubtitle++;
      }
      console.log(`Price dist p0: zero=${priceRanges.zero} extreme=${priceRanges.extreme} mid=${priceRanges.mid} cheap=${priceRanges.cheap} hasSubtitle=${priceRanges.hasSubtitle}`);
      // Log a market with a subtitle if possible
      const withSub = markets.find((x: any) => (x.subtitle || "").length >= 5);
      if (withSub) console.log(`WithSub: ticker=${withSub.ticker} yes=${withSub.yes_ask_dollars} no=${withSub.no_ask_dollars} sub="${(withSub.subtitle||"").slice(0,80)}"`);
      // Log a market with mid prices
      const midPrice = markets.find((x: any) => {
        const ya = parseFloat(x.yes_ask_dollars) || 0;
        const na = parseFloat(x.no_ask_dollars) || 0;
        return ya > 0.05 && ya < 0.95 && na > 0.05 && na < 0.95;
      });
      if (midPrice) console.log(`MidPrice: ticker=${midPrice.ticker} yes=${midPrice.yes_ask_dollars} no=${midPrice.no_ask_dollars} title="${(midPrice.title||"").slice(0,80)}"`);
    }

    for (const m of markets) {
      // ─── SKIP MVE parlay legs (they have dead 0/1 prices and no subtitle) ───
      if (m.mve_collection_ticker) { skipMve++; continue; }

      // ─── SKIP multi-variate type ───
      if (m.market_type === "multi_variate") { skipType++; continue; }

      // ─── Use title as primary, subtitle as fallback ───
      const question = m.title || m.subtitle || m.yes_sub_title || "";
      if (question.length < 5) { skipQ++; continue; }

      // ─── Price: Kalshi V2 uses _dollars suffix (decimal values 0-1) ───
      const yesAsk = parseFloat(m.yes_ask_dollars) || 0;
      const noAsk = parseFloat(m.no_ask_dollars) || 0;
      const yesBid = parseFloat(m.yes_bid_dollars) || 0;
      const noBid = parseFloat(m.no_bid_dollars) || 0;
      const lastPrice = parseFloat(m.last_price_dollars) || 0;

      // Use best available price source
      const yesPrice = yesAsk > 0 ? yesAsk : (yesBid > 0 ? yesBid : lastPrice);
      const noPrice = noAsk > 0 ? noAsk : (noBid > 0 ? noBid : (1 - yesPrice));

      // Filter: need real prices between 1¢ and 99¢
      if (yesPrice <= 0.01 || noPrice <= 0.01) { skipPrice++; continue; }
      if (yesPrice >= 0.99 || noPrice >= 0.99) { skipPrice++; continue; }

      allMarkets.push({
        id: m.ticker || "",
        question,
        yes_price: yesPrice,
        no_price: noPrice,
        platform: "kalshi" as const,
        volume: m.volume_24h || m.volume_fp || m.volume || 0,
        end_date: m.close_time || m.expiration_time,
        ticker: m.ticker,
        category: m.event_ticker || "",
      });
    }

    if (!cursor || markets.length < 1000) break;
  }

  console.log(`Kalshi filter stats: mve=${skipMve}, type=${skipType}, question=${skipQ}, price=${skipPrice}`);
  console.log(`Kalshi: ${allMarkets.length} single-binary markets after filtering`);
  return allMarkets;
}

// ──────────── MYRIAD MARKETS FETCH ────────────

async function fetchMyriadMarkets(maxPages = 5): Promise<MarketData[]> {
  const allMarkets: MarketData[] = [];

  for (let page = 1; page <= maxPages; page++) {
    try {
      const params = new URLSearchParams({
        state: "open",
        sort: "volume",
        order: "desc",
        page: String(page),
        limit: "100",
      });

      const res = await fetch(`${MYRIAD_URL}/markets?${params}`);
      if (!res.ok) {
        console.error(`Myriad API error [${res.status}]`);
        break;
      }
      const data = await res.json();
      const markets = data.data || data.markets || data || [];
      if (!Array.isArray(markets) || markets.length === 0) break;

      for (const m of markets) {
        const outcomes = m.outcomes || [];
        if (outcomes.length < 2) continue;

        // Get prices from outcomes
        const yesOutcome = outcomes.find((o: any) => 
          o.title?.toLowerCase() === "yes" || o.title?.toLowerCase() === outcomes[0]?.title?.toLowerCase()
        ) || outcomes[0];
        const noOutcome = outcomes.find((o: any) => 
          o.title?.toLowerCase() === "no" || o.title?.toLowerCase() === outcomes[1]?.title?.toLowerCase()
        ) || outcomes[1];

        const yesPrice = Number(yesOutcome?.price || 0);
        const noPrice = Number(noOutcome?.price || 0);

        // Skip invalid prices
        if (yesPrice <= 0.01 || noPrice <= 0.01) continue;
        if (yesPrice >= 0.99 || noPrice >= 0.99) continue;

        const question = m.title || m.description || "";
        if (question.length < 5) continue;

        allMarkets.push({
          id: String(m.id || m.slug || ""),
          question,
          yes_price: yesPrice,
          no_price: noPrice,
          platform: "myriad" as const,
          volume: Number(m.volume || m.volume24h || 0),
          end_date: m.expiresAt || m.resolvesAt,
          category: Array.isArray(m.topics) ? m.topics[0] || "" : "",
        });
      }

      // Check pagination
      const pagination = data.pagination;
      if (pagination && !pagination.hasNext) break;
      if (!pagination && markets.length < 100) break;
    } catch (e) {
      console.error(`Myriad fetch error (page ${page}):`, e);
      break;
    }
  }

  console.log(`Myriad: ${allMarkets.length} open markets fetched`);
  return allMarkets;
}

// ──────────── CROSS-PLATFORM ARB FINDER ────────────

interface CrossPlatformArb {
  poly_market: MarketData;  // "source" market (any platform)
  kalshi_market: MarketData;  // "target" market (any platform)
  match_score: number;
  best_strategy: string;
  buy_yes_platform: string;
  buy_yes_price: number;
  buy_no_platform: string;
  buy_no_price: number;
  total_cost: number;
  spread_pct: number;
  guaranteed_profit: number;
  is_arb: boolean;
}

function findCrossPlatformArbs(
  polymarkets: MarketData[],
  kalshiMarkets: MarketData[],
  minMatchScore = 0.2
): CrossPlatformArb[] {
  const arbs: CrossPlatformArb[] = [];

  // Build inverted index: entity → list of kalshi indices
  const kalshiData = kalshiMarkets.map((k) => ({
    market: k,
    entities: new Set(extractEntities(k.question)),
  }));
  const entityIndex = new Map<string, number[]>();
  for (let i = 0; i < kalshiData.length; i++) {
    for (const ent of kalshiData[i].entities) {
      if (!entityIndex.has(ent)) entityIndex.set(ent, []);
      entityIndex.get(ent)!.push(i);
    }
  }

  for (const poly of polymarkets) {
    let bestMatch: MarketData | null = null;
    let bestScore = 0;

    const polyEntities = extractEntities(poly.question);
    if (polyEntities.length < 1) continue;

    // Only check Kalshi markets that share at least one entity
    const candidateIndices = new Set<number>();
    for (const ent of polyEntities) {
      const indices = entityIndex.get(ent);
      if (indices) for (const idx of indices) candidateIndices.add(idx);
    }

    for (const idx of candidateIndices) {
      const { market: kalshi, entities: kalshiEnts } = kalshiData[idx];
      const score = matchMarkets(poly.question, kalshi.question, polyEntities, kalshiEnts);
      if (score > bestScore && score >= minMatchScore) {
        bestScore = score;
        bestMatch = kalshi;
      }
    }

    if (bestMatch) {
      // Strategy 1: Buy YES on Poly + Buy NO on Kalshi
      const cost1 = poly.yes_price + bestMatch.no_price;
      // Strategy 2: Buy YES on Kalshi + Buy NO on Poly
      const cost2 = bestMatch.yes_price + poly.no_price;

      let bestCost: number,
        strategy: string,
        buyYesPlatform: string,
        buyYesPrice: number,
        buyNoPlatform: string,
        buyNoPrice: number;

      if (cost1 <= cost2) {
        bestCost = cost1;
        strategy = `YES@Poly $${poly.yes_price.toFixed(3)} + NO@Kalshi $${bestMatch.no_price.toFixed(3)}`;
        buyYesPlatform = "polymarket";
        buyYesPrice = poly.yes_price;
        buyNoPlatform = "kalshi";
        buyNoPrice = bestMatch.no_price;
      } else {
        bestCost = cost2;
        strategy = `YES@Kalshi $${bestMatch.yes_price.toFixed(3)} + NO@Poly $${poly.no_price.toFixed(3)}`;
        buyYesPlatform = "kalshi";
        buyYesPrice = bestMatch.yes_price;
        buyNoPlatform = "polymarket";
        buyNoPrice = poly.no_price;
      }

      const spreadPct = ((1 - bestCost) / bestCost) * 100;

      arbs.push({
        poly_market: poly,
        kalshi_market: bestMatch,
        match_score: Number(bestScore.toFixed(3)),
        best_strategy: strategy,
        buy_yes_platform: buyYesPlatform,
        buy_yes_price: buyYesPrice,
        buy_no_platform: buyNoPlatform,
        buy_no_price: buyNoPrice,
        total_cost: Number(bestCost.toFixed(4)),
        spread_pct: Number(spreadPct.toFixed(2)),
        guaranteed_profit: Number((1 - bestCost).toFixed(4)),
        is_arb: bestCost < 1,
      });
    }
  }

  return arbs.sort((a, b) => b.spread_pct - a.spread_pct);
}

// ──────────── KALSHI INTERNAL ARB FINDER ────────────

interface KalshiInternalArb {
  market: MarketData;
  yes_price: number;
  no_price: number;
  total_cost: number;
  guaranteed_profit: number;
  spread_pct: number;
}

function findKalshiInternalArbs(markets: MarketData[]): KalshiInternalArb[] {
  const arbs: KalshiInternalArb[] = [];
  for (const m of markets) {
    // Skip toxic market types
    if (isToxicMarket(m.ticker || "", m.question)) continue;

    const totalCost = m.yes_price + m.no_price;
    if (totalCost < 0.99) { // Must cost less than $0.99 for guaranteed profit after fees
      const profit = 1 - totalCost;
      arbs.push({
        market: m,
        yes_price: m.yes_price,
        no_price: m.no_price,
        total_cost: totalCost,
        guaranteed_profit: profit,
        spread_pct: Number(((profit / totalCost) * 100).toFixed(2)),
      });
    }
  }
  return arbs.sort((a, b) => b.spread_pct - a.spread_pct);
}

// ──────────── TOXIC MARKET FILTER ────────────
// These market patterns have historically caused the majority of losses.
// Block them entirely to protect the bankroll.

const TOXIC_TICKER_PATTERNS = [
  // Crypto price markets — unpredictable outcomes
  /^KXBTC/i, /^KXETH/i, /^KXSOL/i, /^KXDOGE/i, /^KXXRP/i,
  /^KXADA/i, /^KXBNB/i, /^KXAVAX/i,
  // Temperature markets
  /^KXHIGH/i, /^KXLOW/i,
  // Tennis challenger — low liquidity
  /^KXATPCHALLENGER/i, /^KXWTACHALLENGER/i,
  // ─── NEW: Categories that caused massive losses ───
  // S&P 500 / Nasdaq index range & above/below bets
  /^KXINX/i, /^KXINXU/i, /^KXNASDAQ/i,
  // Forex — unpredictable directional bets
  /^KXEURUSD/i, /^KXUSDJPY/i, /^KXGBPUSD/i, /^KXUSDCAD/i, /^KXUSDCHF/i, /^KXAUDUSD/i, /^KXNZDUSD/i,
  // Media mention markets — "will announcer say X" is pure coin-flip
  /^KXNBAMENTION/i, /^KXNCAABMENTION/i, /^KXNFLMENTION/i, /^KXNHLMENTION/i,
  /^KXFOXNEWSMENTION/i, /^KXMSNBCMENTION/i, /^KXCNNMENTION/i,
  /^KXMENTION/i, /^KXTRUMPMENTION/i, /^KXHEGSETHMENTION/i, /^KXBIDENMENTION/i,
  // Spotify stream count — impossible to predict
  /^KXSPOTSTREAMGLOBAL/i, /^KXSPOTSTREAM/i,
  // YouTube / social view counts
  /^KXYTVIEW/i, /^KXTIKTOK/i,
  // Dow Jones
  /^KXDJI/i, /^KXDJIU/i,
  // Russell 2000
  /^KXRUT/i, /^KXRUTU/i,
  // Gold / Oil / Commodity prices
  /^KXGOLD/i, /^KXOIL/i, /^KXWTI/i, /^KXSILVER/i,
];

const TOXIC_QUESTION_PATTERNS = [
  /temp(erature)?.*\d+-?\d*°/i,     // any temp bracket bets
  /\$[\d,]+(\.\d+)?\s+to\s+/i,     // price range bets
  /price.*between/i,                // price between X and Y
  /\bprice\b.*on\s+\w+\s+\d/i,     // "price on Mar 17" — crypto/commodity price
  /high temp/i,                     // high temperature markets
  /low temp/i,                      // low temperature markets
  // ─── NEW: Block by question text as a safety net ───
  /S&P\s*500/i,                     // S&P 500 in any form
  /Nasdaq/i,                        // Nasdaq in any form
  /\bannouncer/i,                   // "will the announcers say"
  /\bstreams?\b.*spotify/i,         // Spotify stream counts
  /spotify.*\bstreams?\b/i,         // reversed order
  /EUR\/USD|USD\/JPY|GBP\/USD/i,    // forex pairs
  /\bopen price\b/i,                // "open price" = forex/stock direction
  /Dow Jones|Russell 2000/i,        // other indexes
  /how many streams/i,              // stream count bets
];

// Max size for any single trade to prevent catastrophic single-bet losses
const MAX_SINGLE_TRADE_SIZE = 2.00; // Reduced from $5 to $2 — smaller bets, less downside per loss

function isToxicMarket(ticker: string, question: string): boolean {
  for (const pat of TOXIC_TICKER_PATTERNS) {
    if (pat.test(ticker)) return true;
  }
  for (const pat of TOXIC_QUESTION_PATTERNS) {
    if (pat.test(question)) return true;
  }
  return false;
}

// ──────────── KALSHI VALUE BETTING ────────────

interface KalshiValueBet {
  market: MarketData;
  side: "yes" | "no";
  price: number;
  edge: number;
  hoursLeft: number;
}

function findKalshiValueBets(markets: MarketData[], maxHours = 72): KalshiValueBet[] {  // 72h window for more opportunities
  const now = Date.now();
  const bets: KalshiValueBet[] = [];
  let checked = 0, timeFiltered = 0, toxicFiltered = 0;

  // TIER 1: Ultra-safe (≤5¢ opposing = 95%+ implied probability)
  const TIER1_THRESHOLD = 0.05;
  // TIER 2: High-confidence (≤10¢ opposing = 90%+ implied probability, shorter window)
  const TIER2_THRESHOLD = 0.10;
  // TIER 3: Strong edge (≤15¢ opposing = 85%+ implied probability, very short window only)
  const TIER3_THRESHOLD = 0.15;

  const yesUnder5 = markets.filter(m => m.yes_price <= TIER1_THRESHOLD).length;
  const noUnder5 = markets.filter(m => m.no_price <= TIER1_THRESHOLD).length;
  const yesUnder10 = markets.filter(m => m.yes_price > TIER1_THRESHOLD && m.yes_price <= TIER2_THRESHOLD).length;
  const noUnder10 = markets.filter(m => m.no_price > TIER1_THRESHOLD && m.no_price <= TIER2_THRESHOLD).length;
  const yesUnder15 = markets.filter(m => m.yes_price > TIER2_THRESHOLD && m.yes_price <= TIER3_THRESHOLD).length;
  const noUnder15 = markets.filter(m => m.no_price > TIER2_THRESHOLD && m.no_price <= TIER3_THRESHOLD).length;
  const withEndDate = markets.filter(m => !!m.end_date).length;
  const withTicker = markets.filter(m => !!m.ticker).length;
  console.log(`Value debug: ${markets.length} markets, ${withEndDate} end_date, ${withTicker} ticker | T1(≤5¢): yes=${yesUnder5} no=${noUnder5} | T2(≤10¢): yes=${yesUnder10} no=${noUnder10} | T3(≤15¢): yes=${yesUnder15} no=${noUnder15}`);

  for (const m of markets) {
    if (!m.end_date || !m.ticker) continue;
    checked++;

    if (isToxicMarket(m.ticker, m.question)) { toxicFiltered++; continue; }

    const msLeft = new Date(m.end_date).getTime() - now;
    const hoursLeft = msLeft / (1000 * 60 * 60);
    if (hoursLeft < 0.25 || hoursLeft > maxHours) { timeFiltered++; continue; }

    // Determine tier and constraints based on opposing price
    // Lower opposing price = higher confidence = more relaxed constraints
    const MAX_ENTRY_PRICE = 0.85; // Never pay more than 85¢ (minimum 17.6% edge — need ~85% win rate, achievable)
    const MIN_EDGE_PCT = 15; // Minimum 15% edge to justify the risk

    // Check both sides
    const sides: Array<{ side: "yes" | "no"; oppPrice: number; entryPrice: number }> = [];
    
    // Buy NO when YES is cheap (opponent likely to lose)
    if (m.yes_price <= TIER3_THRESHOLD && m.no_price > 0 && m.no_price <= MAX_ENTRY_PRICE) {
      sides.push({ side: "no", oppPrice: m.yes_price, entryPrice: m.no_price });
    }
    // Buy YES when NO is cheap (priced to win)
    if (m.no_price <= TIER3_THRESHOLD && m.yes_price > 0 && m.yes_price <= MAX_ENTRY_PRICE) {
      sides.push({ side: "yes", oppPrice: m.no_price, entryPrice: m.yes_price });
    }

    for (const { side, oppPrice, entryPrice } of sides) {
      const edge = ((1 - entryPrice) / entryPrice) * 100;
      if (edge < MIN_EDGE_PCT) continue;

      // Tier-based time constraints (higher risk = shorter window)
      let maxAllowedHours: number;
      if (oppPrice <= TIER1_THRESHOLD) {
        maxAllowedHours = 72; // Ultra-safe: 3 days OK
      } else if (oppPrice <= TIER2_THRESHOLD) {
        maxAllowedHours = 24; // High-confidence: 1 day max
      } else {
        maxAllowedHours = 6; // Strong edge: 6 hours max (imminent resolution)
      }

      if (hoursLeft > maxAllowedHours) continue;

      bets.push({ market: m, side, price: entryPrice, edge: Number(edge.toFixed(2)), hoursLeft: Number(hoursLeft.toFixed(1)) });
    }
  }

  // Deduplicate by ticker+side
  const seen = new Map<string, KalshiValueBet>();
  for (const b of bets) {
    const key = `${b.market.ticker}-${b.side}`;
    if (!seen.has(key) || seen.get(key)!.edge < b.edge) seen.set(key, b);
  }

  console.log(`Value scan: ${checked} checked, ${toxicFiltered} toxic-filtered, ${timeFiltered} time-filtered, ${bets.length} candidates`);

  // Sort by edge-per-hour (prioritize fast + high edge)
  return Array.from(seen.values()).sort((a, b) => {
    return (b.edge / Math.max(b.hoursLeft, 0.5)) - (a.edge / Math.max(a.hoursLeft, 0.5));
  });
}

// ──────────── AUTO-SYNC HELPER ────────────
// Reusable sync logic — returns sync results object
async function syncKalshiTradesInternal(supabase: any): Promise<{ synced: number; won: number; lost: number; totalPnl: number; stillActive: number }> {
  const { data: liveTrades, error: fetchErr } = await supabase
    .from("polymarket_trades")
    .select("*")
    .like("side", "%KALSHI%")
    .eq("status", "live");

  if (fetchErr) throw fetchErr;
  if (!liveTrades || liveTrades.length === 0) {
    return { synced: 0, won: 0, lost: 0, totalPnl: 0, stillActive: 0 };
  }

  console.log(`🔄 Auto-sync: checking ${liveTrades.length} live Kalshi trades...`);

  const tickerSet = new Set(liveTrades.map((t: any) => t.token_id || t.market_id));
  const tickerStatuses: Record<string, any> = {};

  for (const ticker of tickerSet) {
    try {
      const path = `/trade-api/v2/markets/${ticker}`;
      const hdrs = await kalshiHeaders("GET", path);
      const res = await fetch(`https://api.elections.kalshi.com${path}`, { headers: hdrs });
      if (res.ok) {
        const data = await res.json();
        const market = data.market || data;
        tickerStatuses[ticker as string] = {
          status: market.status,
          result: market.result,
          close_time: market.close_time,
          settlement_value: market.settlement_value,
        };
      }
    } catch (e) {
      console.warn(`  ${ticker}: fetch error: ${e}`);
    }
  }

  let settledOrders: any[] = [];
  try {
    const path = "/trade-api/v2/portfolio/settlements";
    const hdrs = await kalshiHeaders("GET", path);
    const res = await fetch(`https://api.elections.kalshi.com${path}?limit=200`, { headers: hdrs });
    if (res.ok) {
      const data = await res.json();
      settledOrders = data.settlements || [];
    }
  } catch (_) {}

  const settlementByTicker: Record<string, any> = {};
  for (const s of settledOrders) {
    const t = s.ticker || s.market_ticker;
    if (t) settlementByTicker[t] = s;
  }

  let synced = 0, won = 0, lost = 0, totalPnl = 0;

  for (const trade of liveTrades) {
    const ticker = trade.token_id || trade.market_id;
    const marketInfo = tickerStatuses[ticker];
    if (!marketInfo) continue;

    const isSettled = ["finalized", "settled", "closed"].includes(marketInfo.status);
    if (!isSettled && marketInfo.status === "active") continue;

    const side = trade.side as string;
    const boughtYes = side.includes("YES");
    const boughtNo = side.includes("NO");
    const result = marketInfo.result;

    let pnl = 0;
    let newStatus = "settled";

    if (result === "yes" && boughtYes) {
      pnl = trade.size * (1 - trade.price); won++;
    } else if (result === "no" && boughtNo) {
      pnl = trade.size * (1 - trade.price); won++;
    } else if (result === "yes" && boughtNo) {
      pnl = -(trade.size * trade.price); lost++;
    } else if (result === "no" && boughtYes) {
      pnl = -(trade.size * trade.price); lost++;
    } else if (result === "all_no" || result === "all_yes") {
      if (result === "all_no" && boughtNo) { pnl = trade.size * (1 - trade.price); won++; }
      else if (result === "all_yes" && boughtYes) { pnl = trade.size * (1 - trade.price); won++; }
      else { pnl = -(trade.size * trade.price); lost++; }
    } else if (!result && isSettled) {
      const settlement = settlementByTicker[ticker];
      if (settlement) {
        pnl = (settlement.revenue || 0) / 100 - trade.size * trade.price;
        if (pnl > 0) won++; else lost++;
      } else {
        newStatus = "expired";
        pnl = -(trade.size * trade.price); lost++;
      }
    } else {
      continue;
    }

    pnl = Math.round(pnl * 100) / 100;
    totalPnl += pnl;

    await supabase
      .from("polymarket_trades")
      .update({ status: newStatus, profit_loss: pnl })
      .eq("id", trade.id);

    console.log(`  ✅ ${trade.market_question?.slice(0, 50)}: ${newStatus} | P&L: $${pnl.toFixed(2)}`);
    synced++;
  }

  totalPnl = Math.round(totalPnl * 100) / 100;
  const stillActive = liveTrades.length - synced;
  console.log(`🔄 Auto-sync complete: ${synced} settled (${won}W/${lost}L), $${totalPnl.toFixed(2)} P&L, ${stillActive} still active`);
  return { synced, won, lost, totalPnl, stillActive };
}

// Check if auto-sync should trigger (≥5 trades past resolution time)
async function maybeAutoSync(supabase: any): Promise<any> {
  const now = new Date().toISOString();
  const { data: pastDueTrades, error } = await supabase
    .from("polymarket_trades")
    .select("id")
    .like("side", "%KALSHI%")
    .eq("status", "live")
    .lt("resolved_at", now);

  if (error || !pastDueTrades) return null;

  const SYNC_THRESHOLD = 5;
  if (pastDueTrades.length >= SYNC_THRESHOLD) {
    console.log(`🔄 Auto-sync triggered: ${pastDueTrades.length} trades past resolution time (threshold: ${SYNC_THRESHOLD})`);
    return await syncKalshiTradesInternal(supabase);
  }

  console.log(`Auto-sync: ${pastDueTrades.length}/${SYNC_THRESHOLD} trades past resolution — not yet`);
  return null;
}

// ──────────── VALUE BET EXECUTOR ────────────

async function executeValueBets(
  supabase: any,
  kalshiMarkets: MarketData[],
  maxPerTrade: number,
  minFloor: number,
  slotsAvailable: number,
  tradedMarketIds: Set<string>,
  tradedQuestions: Set<string>,
): Promise<Response> {
  const valueBets = findKalshiValueBets(kalshiMarkets); // uses default 720h (30 days)
  console.log(`Value betting: ${valueBets.length} candidates found`);

  if (valueBets.length === 0) {
    return new Response(JSON.stringify({ skipped: true, reason: "No value bets available" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Filter out already-traded markets
  const newBets = valueBets.filter(b => {
    if (tradedMarketIds.has(b.market.id)) return false;
    if (tradedQuestions.has(normalize(b.market.question))) return false;
    return true;
  });

  const toPlace = newBets.slice(0, 3); // Up to 3 value bets per cycle

  if (toPlace.length === 0) {
    return new Response(JSON.stringify({ skipped: true, reason: "No new value bets (all already traded)" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const inserts = [];
  const results = [];

  for (const bet of toPlace) {
    const ticker = bet.market.ticker;
    if (!ticker) continue;

    // Re-check balance
    const currentBal = await fetchKalshiBalance();
    const currentAvailable = Math.max(0, currentBal.balance - minFloor);
    // CAUTIOUS: max $2 per value bet for safety
    const CAUTIOUS_MAX = 10.00;
    const tradeSize = Math.min(currentAvailable, CAUTIOUS_MAX);
    if (tradeSize < 0.10) {
      console.log(`Value bet: stopping — available cash $${currentAvailable.toFixed(2)} too low`);
      break;
    }

    try {
      const yesPrice = bet.side === "yes" ? bet.price : (1 - bet.price);
      const orderResult = await placeKalshiOrder(ticker, bet.side, yesPrice, tradeSize);
      const orderId = orderResult?.order_id || orderResult?.id || null;
      console.log(`✅ Value bet: ${ticker} ${bet.side.toUpperCase()} @ ${(bet.price * 100).toFixed(0)}¢ | edge: ${bet.edge}% | resolves in ${bet.hoursLeft}h`);

      results.push({ question: bet.market.question, side: bet.side, price: bet.price, edge: bet.edge, hoursLeft: bet.hoursLeft, ticker });

      inserts.push({
        market_id: bet.market.id,
        market_question: bet.market.question,
        token_id: ticker,
        side: `BUY_${bet.side.toUpperCase()}@KALSHI`,
        price: bet.price,
        size: tradeSize,
        status: "live",
        order_id: orderId,
        profit_loss: 0, // unknown until resolution
        resolved_at: bet.market.end_date || null,
      });
    } catch (e) {
      console.error(`❌ Value bet failed (${ticker}): ${e}`);
      continue;
    }
  }

  if (inserts.length > 0) {
    const { data: trades, error: tradeErr } = await supabase
      .from("polymarket_trades").insert(inserts).select();
    if (tradeErr) throw tradeErr;

    return new Response(JSON.stringify({
      executed: true,
      strategy: "kalshi_value_bet",
      count: results.length,
      trades,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ skipped: true, reason: "Value bet orders all failed" }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ──────────── MAIN HANDLER ────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const body = await req.json();
    const {
      action, market_id, question,
      buy_yes_platform, buy_no_platform, buy_yes_price, buy_no_price,
      size, is_running, trade_amount, interval_minutes, min_confidence, max_open_trades,
    } = body;

    // ──── BALANCE ────
    if (action === "balance") {
      const balances: Record<string, any> = { polymarket: null, kalshi: null };
      let positions: any[] = [];
      let walletInfo: any = null;

      const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");

      if (privateKey) {
        const wallet = new Wallet(privateKey);
        const eoaAddress = wallet.address;

        // Step 1: Derive proxy wallets + known user wallet
        const proxyAddress = deriveProxyAddress(eoaAddress);
        const safeAddress = deriveSafeAddress(eoaAddress);
        const allAddresses = [eoaAddress, proxyAddress, safeAddress, KNOWN_WALLET, KNOWN_WALLET_2].filter((a, i, arr) => a && a !== "" && arr.indexOf(a) === i);
        console.log(`EOA: ${eoaAddress}, Proxy: ${proxyAddress}, Safe: ${safeAddress}`);

        // Step 2: Fetch cash balance + positions for ALL derived addresses
        const positionPromises = allAddresses.map(addr =>
          fetch(`https://data-api.polymarket.com/positions?user=${addr}`)
            .then(r => r.ok ? r.json() : [])
            .then(data => { console.log(`Positions for ${addr}: ${(data || []).length}`); return data || []; })
            .catch(() => [])
        );

        const [balResult, ...posResults] = await Promise.allSettled([
          fetchTotalCashBalance(privateKey),
          ...positionPromises,
        ]);

        // Merge positions from all addresses
        const rawPositions = posResults.flatMap(r => r.status === "fulfilled" ? (r.value || []) : []);
        console.log(`Total positions found: ${rawPositions.length}`);

        // Cash balance (combined EOA + KNOWN_WALLET)
        if (balResult.status === "fulfilled") {
          const data = balResult.value;
          balances.polymarket = {
            balance: data.balance,
            allowance: data.allowance,
            eoaBalance: data.eoaBalance,
            knownWalletBalance: data.knownWalletBalance,
          };
        } else {
          console.error("Balance fetch failed:", balResult.reason);
          balances.polymarket = { balance: 0, allowance: 0, error: "Could not fetch cash balance" };
        }

        // Positions (already merged from proxy + EOA above)
        {
          let portfolioValue = 0;
          positions = rawPositions
            .filter((p: any) => Number(p.size || 0) > 0)
            .map((p: any) => {
              const size = Number(p.size || 0);
              const currentPrice = Number(p.curPrice || p.price || 0);
              const value = size * currentPrice;
              portfolioValue += value;
              return {
                market: p.title || p.market_slug || p.asset || "Unknown",
                outcome: p.outcome || (p.side === "YES" ? "Yes" : "No"),
                tokenId: p.asset || null,
                size,
                avgPrice: Number(p.avgPrice || p.price || 0),
                currentPrice,
                value: Number(value.toFixed(2)),
                pnl: Number(((currentPrice - Number(p.avgPrice || p.price || 0)) * size).toFixed(2)),
              };
            })
            .sort((a: any, b: any) => b.value - a.value)
            .slice(0, 20);

          if (balances.polymarket) {
            balances.polymarket.portfolioValue = Number(portfolioValue.toFixed(2));
            balances.polymarket.positionCount = rawPositions.filter((p: any) => Number(p.size || 0) > 0).length;
          }
        }
        walletInfo = { eoa: eoaAddress, proxy: proxyAddress !== eoaAddress ? proxyAddress : null, safe: safeAddress && safeAddress !== eoaAddress ? safeAddress : null };
      } else {
        balances.polymarket = { error: "Private key not configured" };
      }

      // Fetch Kalshi balance
      try {
        const kalshiBal = await fetchKalshiBalance();
        balances.kalshi = kalshiBal;
        console.log(`Kalshi balance: $${kalshiBal.balance}, portfolio: $${kalshiBal.portfolio_value}`);
      } catch (e) {
        console.error("Kalshi balance error:", e);
        balances.kalshi = { balance: 0, portfolio_value: 0, error: String(e) };
      }

      const { data: allTrades } = await supabase.from("polymarket_trades").select("size, profit_loss");
      const totalInvested = allTrades?.reduce((s, t) => s + (t.size || 0), 0) || 0;
      const totalProfit = allTrades?.reduce((s, t) => s + (t.profit_loss || 0), 0) || 0;

      

      return new Response(JSON.stringify({ balances, positions, portfolio: { totalInvested, totalProfit }, walletInfo }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ──── SCAN ────
    if (action === "scan") {
      const [polymarkets, kalshiMarkets, myriadMarkets] = await Promise.all([
        fetchPolymarkets(200),
        fetchKalshiMarkets(3),
        fetchMyriadMarkets(3),
      ]);

      console.log(`Scan: ${polymarkets.length} Poly × ${kalshiMarkets.length} Kalshi × ${myriadMarkets.length} Myriad`);

      // Cross-platform arbs across all pairs
      const arbs1 = findCrossPlatformArbs(polymarkets, kalshiMarkets, 0.15);
      const arbs2 = findCrossPlatformArbs(polymarkets, myriadMarkets, 0.15);
      const arbs3 = findCrossPlatformArbs(kalshiMarkets, myriadMarkets, 0.15);

      // Deduplicate by source market id
      const seen = new Set<string>();
      const allArbs: CrossPlatformArb[] = [];
      for (const a of [...arbs1, ...arbs2, ...arbs3].sort((a, b) => b.spread_pct - a.spread_pct)) {
        const key = `${a.poly_market.id}-${a.kalshi_market.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allArbs.push(a);
      }

      const arbs = allArbs.slice(0, 50);
      const realArbCount = arbs.filter((a) => a.is_arb).length;

      console.log(`Results: ${arbs.length} matches, ${realArbCount} real arbs`);
      if (arbs.length > 0) {
        console.log(`Top match: "${arbs[0].poly_market.question}" ↔ "${arbs[0].kalshi_market.question}" (score: ${arbs[0].match_score}, spread: ${arbs[0].spread_pct}%)`);
      }

      return new Response(
        JSON.stringify({
          markets: arbs,
          real_arb_count: realArbCount,
          poly_count: polymarkets.length,
          kalshi_count: kalshiMarkets.length,
          myriad_count: myriadMarkets.length,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ──── LIVE SCAN ────
    if (action === "live_scan") {
      const now = new Date();
      const soon = new Date(now.getTime() + 72 * 60 * 60 * 1000); // 72h window

      const [polymarkets, kalshiMarkets, myriadMarkets] = await Promise.all([
        fetchPolymarkets(200),
        fetchKalshiMarkets(3),
        fetchMyriadMarkets(3),
      ]);

      const filterSoon = (m: MarketData) => {
        if (!m.end_date) return false;
        const end = new Date(m.end_date);
        return end > now && end <= soon;
      };

      const soonPoly = polymarkets.filter(filterSoon);
      const soonKalshi = kalshiMarkets.filter(filterSoon);
      const soonMyriad = myriadMarkets.filter(filterSoon);

      // All cross-platform pairs
      const arbs1 = findCrossPlatformArbs(soonPoly, kalshiMarkets, 0.15);
      const arbs2 = findCrossPlatformArbs(polymarkets, soonKalshi, 0.15);
      const arbs3 = findCrossPlatformArbs(soonPoly, myriadMarkets, 0.15);
      const arbs4 = findCrossPlatformArbs(polymarkets, soonMyriad, 0.15);
      const arbs5 = findCrossPlatformArbs(soonKalshi, myriadMarkets, 0.15);
      const arbs6 = findCrossPlatformArbs(kalshiMarkets, soonMyriad, 0.15);

      // Deduplicate by source market id
      const seen = new Set<string>();
      const combined: (CrossPlatformArb & { hours_left: number })[] = [];
      for (const a of [...arbs1, ...arbs2, ...arbs3, ...arbs4, ...arbs5, ...arbs6]) {
        const key = `${a.poly_market.id}-${a.kalshi_market.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const endStr = a.poly_market.end_date || a.kalshi_market.end_date;
        const endDate = endStr ? new Date(endStr) : now;
        const hoursLeft = Math.max(0, (endDate.getTime() - now.getTime()) / (1000 * 60 * 60));
        combined.push({ ...a, hours_left: Number(hoursLeft.toFixed(1)) });
      }

      combined.sort((a, b) => b.spread_pct - a.spread_pct);

      return new Response(JSON.stringify({ live: combined.slice(0, 20) }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ──── EXECUTE ────
    if (action === "execute") {
      const totalCost = (buy_yes_price || 0) + (buy_no_price || 0);
      const arbProfit = 1 - totalCost;
      const tradeSize = size || 0.5;

      const { data: trades, error } = await supabase
        .from("polymarket_trades")
        .insert([
          {
            market_id: market_id || "cross-platform",
            market_question: question,
            token_id: buy_yes_platform || "cross",
            side: `BUY_YES@${(buy_yes_platform || "").toUpperCase()}`,
            price: buy_yes_price,
            size: tradeSize,
            status: "executed",
            profit_loss: arbProfit * tradeSize,
          },
          {
            market_id: market_id || "cross-platform",
            market_question: question,
            token_id: buy_no_platform || "cross",
            side: `BUY_NO@${(buy_no_platform || "").toUpperCase()}`,
            price: buy_no_price,
            size: tradeSize,
            status: "executed",
            profit_loss: 0,
          },
        ])
        .select();

      if (error) throw error;
      return new Response(JSON.stringify({ trades }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ──── STATUS ────
    if (action === "status") {
      const { data: settings } = await supabase
        .from("bot_settings")
        .select("*")
        .limit(1)
        .maybeSingle();

      const { data: trades } = await supabase
        .from("polymarket_trades")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      const { data: allTrades } = await supabase
        .from("polymarket_trades")
        .select("*");

      const totalTrades = allTrades?.length || 0;
      const totalProfit = allTrades?.reduce((sum, t) => sum + (t.profit_loss || 0), 0) || 0;
      const totalInvested = allTrades?.reduce((sum, t) => sum + (t.size || 0), 0) || 0;
      const arbCount = Math.floor(totalTrades / 2);

      return new Response(
        JSON.stringify({ settings, trades, stats: { totalTrades, totalProfit, totalInvested, arbCount } }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ──── TOGGLE ────
    if (action === "toggle") {
      const { data, error } = await supabase
        .from("bot_settings")
        .update({ is_running, updated_at: new Date().toISOString() })
        .eq("id", (await supabase.from("bot_settings").select("id").limit(1).single()).data?.id)
        .select()
        .single();

      if (error) throw error;
      return new Response(JSON.stringify({ settings: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ──── UPDATE SETTINGS ────
    if (action === "update_settings") {
      const { data: current } = await supabase.from("bot_settings").select("id").limit(1).single();
      const { data, error } = await supabase
        .from("bot_settings")
        .update({
          ...(trade_amount !== undefined && { trade_amount }),
          ...(interval_minutes !== undefined && { interval_minutes }),
          ...(min_confidence !== undefined && { min_confidence }),
          ...(max_open_trades !== undefined && { max_open_trades }),
          updated_at: new Date().toISOString(),
        })
        .eq("id", current?.id)
        .select()
        .single();

      if (error) throw error;
      return new Response(JSON.stringify({ settings: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ──── AUTO TRADE (real execution + balance-based sizing) ────
    if (action === "auto_trade") {
      const { data: settings } = await supabase
        .from("bot_settings")
        .select("*")
        .limit(1)
        .maybeSingle();

      if (!settings?.is_running) {
        return new Response(JSON.stringify({ skipped: true, reason: "Bot is not running" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Auto-sync: check if ≥5 trades are past resolution time and settle them
      const syncResult = await maybeAutoSync(supabase);
      if (syncResult && syncResult.synced > 0) {
        console.log(`Auto-sync completed before trade cycle: ${syncResult.synced} settled, $${syncResult.totalPnl.toFixed(2)} P&L`);
      }

      const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");
      if (!privateKey) {
        return new Response(JSON.stringify({ skipped: true, reason: "No private key configured" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Step 1: Fetch Kalshi balance for trade sizing
      const MIN_BALANCE_FLOOR = 0; // No reserve — use every cent
      let cashBalance = 0;
      try {
        const kalshiBal = await fetchKalshiBalance();
        cashBalance = kalshiBal.balance;
        console.log(`Auto-trade: Kalshi cash = $${cashBalance.toFixed(2)}`);
      } catch (e) {
        console.error("Failed to fetch Kalshi balance:", e);
      }

      const availableCash = Math.max(0, cashBalance - MIN_BALANCE_FLOOR);
      if (availableCash < 0.10) {
        console.log(`Auto-trade: skipped — available cash after $${MIN_BALANCE_FLOOR} floor = $${availableCash.toFixed(2)} (total: $${cashBalance.toFixed(2)})`);
        return new Response(JSON.stringify({ skipped: true, reason: `Balance too close to $${MIN_BALANCE_FLOOR} floor (available: $${availableCash.toFixed(2)})` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Step 2: Check LIVE on-chain positions (not DB records which include old/resolved trades)
      const wallet = new Wallet(privateKey);
      const eoaAddress = wallet.address;
      const proxyAddress = deriveProxyAddress(eoaAddress);
      const safeAddress = deriveSafeAddress(eoaAddress);
      const allAddresses = [eoaAddress, proxyAddress, safeAddress, KNOWN_WALLET, KNOWN_WALLET_2].filter((a, i, arr) => a && a !== "" && arr.indexOf(a) === i);

      const positionPromises = allAddresses.map(addr =>
        fetch(`https://data-api.polymarket.com/positions?user=${addr}`)
          .then(r => r.ok ? r.json() : [])
          .then(data => (data || []).filter((p: any) => Number(p.size || 0) > 0))
          .catch(() => [])
      );
      const posResults = await Promise.all(positionPromises);
      const livePositions = posResults.flat();
      const openPositions = livePositions.length;
      console.log(`Auto-trade: ${openPositions} live on-chain positions`);

      // Also get traded market IDs/questions from DB for duplicate prevention
      // FIX: check ALL active statuses, not just "executed" (trades are saved as "live")
      const MAX_PER_MARKET = 3; // Max trades per unique market question
      const { data: existingTrades } = await supabase
        .from("polymarket_trades")
        .select("market_id, market_question")
        .in("status", ["live", "executed", "pending"]);

      const tradedMarketIds = new Set((existingTrades || []).map((t: any) => t.market_id));
      const tradedQuestions = new Set<string>();
      const marketQuestionCounts = new Map<string, number>();
      for (const t of (existingTrades || [])) {
        const nq = normalize(t.market_question || "");
        const count = (marketQuestionCounts.get(nq) || 0) + 1;
        marketQuestionCounts.set(nq, count);
        if (count >= MAX_PER_MARKET) tradedQuestions.add(nq);
      }

      if (openPositions >= settings.max_open_trades) {
        console.log(`Auto-trade: skipped — ${openPositions}/${settings.max_open_trades} positions filled`);
        return new Response(JSON.stringify({ skipped: true, reason: "Max open arb positions reached" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Step 3: Size trades — spread across multiple slots
      const slotsAvailable = Math.min(3, settings.max_open_trades - openPositions); // Up to 3 trades per cycle
      const perTradeSize = Math.min(availableCash / Math.max(slotsAvailable, 1), MAX_SINGLE_TRADE_SIZE);

      if (perTradeSize < 0.10) {
        console.log(`Auto-trade: trade size too small ($${perTradeSize.toFixed(2)})`);
        return new Response(JSON.stringify({ skipped: true, reason: `Trade size too small: $${perTradeSize.toFixed(2)}` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`Auto-trade: sizing $${perTradeSize.toFixed(2)}/trade (${slotsAvailable} slots, $${availableCash.toFixed(2)} available, $${cashBalance.toFixed(2)} total)`);

      // Step 4: Find arbs — CAUTIOUS MODE: only guaranteed-profit trades resolving in 1-2 days
      const [polymarkets, kalshiMarkets, myriadMarkets] = await Promise.all([
        fetchPolymarkets(500),
        fetchKalshiMarkets(10),
        fetchMyriadMarkets(5),
      ]);

      const minSpread = (1 - settings.min_confidence) * 100;
      const now = Date.now();
      const MIN_MS = 100;                  // 0.1 second
      const MAX_MS = 72 * 60 * 60 * 1000;  // 72 hours — wider window for more opportunities

      // Find arbs across all platform pairs
      const timeFilter = (a: CrossPlatformArb) => {
        if (!a.is_arb || a.spread_pct < minSpread) return false;
        const endStr = a.poly_market.end_date || a.kalshi_market.end_date;
        if (!endStr) return false;
        const msLeft = new Date(endStr).getTime() - now;
        return msLeft >= MIN_MS && msLeft <= MAX_MS;
      };

      const allCrossArbs = [
        ...findCrossPlatformArbs(polymarkets, kalshiMarkets, 0.2),
        ...findCrossPlatformArbs(polymarkets, myriadMarkets, 0.2),
        ...findCrossPlatformArbs(kalshiMarkets, myriadMarkets, 0.2),
      ].filter(timeFilter);

      // Deduplicate
      const arbSeen = new Set<string>();
      const arbs: CrossPlatformArb[] = [];
      for (const a of allCrossArbs.sort((x, y) => y.spread_pct - x.spread_pct)) {
        const key = `${a.poly_market.id}-${a.kalshi_market.id}`;
        if (arbSeen.has(key)) continue;
        arbSeen.add(key);
        arbs.push(a);
      }

      console.log(`Auto-trade: ${arbs.length} arbs within 1min-2hr window`);

      const newArbs = arbs.filter((a) => {
        if (tradedMarketIds.has(a.poly_market.id)) return false;
        if (tradedQuestions.has(normalize(a.poly_market.question))) return false;
        return true;
      });

      const toExecute = newArbs.slice(0, Math.min(slotsAvailable, 3));

      // ── Kalshi-only internal arbs as fallback ──
      if (toExecute.length === 0) {
        console.log(`Auto-trade: no cross-platform arbs, trying Kalshi internal arbs...`);
        const kalshiArbs = findKalshiInternalArbs(kalshiMarkets);
        console.log(`Auto-trade: ${kalshiArbs.length} Kalshi internal arbs found`);

        const kalshiNew = kalshiArbs.filter(a => {
          if (tradedMarketIds.has(a.market.id)) return false;
          if (tradedQuestions.has(normalize(a.market.question))) return false;
          return true;
        });

        const kalshiToExecute = kalshiNew.slice(0, Math.min(slotsAvailable, 3));

        if (kalshiToExecute.length === 0) {
          // Fall back to ultra-safe value bets (≤5¢ threshold, 48h, $2 max)
          return await executeValueBets(supabase, kalshiMarkets, perTradeSize, MIN_BALANCE_FLOOR, slotsAvailable, tradedMarketIds, tradedQuestions);
        }

        const kalshiInserts = [];
        const kalshiResults = [];

        for (const arb of kalshiToExecute) {
          const ticker = arb.market.ticker;
          if (!ticker) continue;

          // Re-check balance before each trade
          const currentBal = await fetchKalshiBalance();
          const currentAvailable = Math.max(0, currentBal.balance - MIN_BALANCE_FLOOR);
          const tradeSize = Math.min(perTradeSize, currentAvailable * 0.5);
           if (tradeSize < 0.10) {
            console.log(`Auto-trade: stopping — available cash $${currentAvailable.toFixed(2)} too low`);
            break;
          }

          // Buy YES side
          let yesOrderId: string | null = null;
          try {
            const yesResult = await placeKalshiOrder(ticker, "yes", arb.yes_price, tradeSize);
            yesOrderId = yesResult?.order_id || yesResult?.id || null;
            console.log(`✅ Kalshi YES: ${ticker} @ ${(arb.yes_price * 100).toFixed(0)}¢`);
          } catch (e) {
            console.error(`❌ Kalshi YES order failed: ${e}`);
            continue;
          }

          // Buy NO side
          let noOrderId: string | null = null;
          try {
            const noResult = await placeKalshiOrder(ticker, "no", 1 - arb.no_price, tradeSize);
            noOrderId = noResult?.order_id || noResult?.id || null;
            console.log(`✅ Kalshi NO: ${ticker} @ ${(arb.no_price * 100).toFixed(0)}¢`);
          } catch (e) {
            console.error(`❌ Kalshi NO order failed: ${e}`);
            // YES already placed — record it anyway
          }

          const arbProfit = arb.guaranteed_profit * tradeSize;
          kalshiResults.push({ question: arb.market.question, spread: arb.spread_pct, ticker });

          kalshiInserts.push(
            {
              market_id: arb.market.id,
              market_question: arb.market.question,
              token_id: ticker,
              side: "BUY_YES@KALSHI",
              price: arb.yes_price,
              size: tradeSize,
              status: "live",
              order_id: yesOrderId,
              profit_loss: arbProfit,
              resolved_at: arb.market.end_date || null,
            },
            {
              market_id: arb.market.id,
              market_question: arb.market.question,
              token_id: ticker,
              side: "BUY_NO@KALSHI",
              price: arb.no_price,
              size: tradeSize,
              status: noOrderId ? "live" : "failed",
              order_id: noOrderId,
              profit_loss: 0,
              resolved_at: arb.market.end_date || null,
            }
          );
        }

        if (kalshiInserts.length > 0) {
          const { data: trades, error: tradeErr } = await supabase
            .from("polymarket_trades")
            .insert(kalshiInserts)
            .select();
          if (tradeErr) throw tradeErr;

          for (const r of kalshiResults) {
            console.log(`✅ Kalshi arb: ${r.question} | ${r.spread}% spread`);
          }

          return new Response(JSON.stringify({
            executed: true,
            strategy: "kalshi_internal",
            count: kalshiResults.length,
            trades,
            results: kalshiResults,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Fall back to ultra-safe value bets (≤5¢ threshold, 48h, $2 max)
        return await executeValueBets(supabase, kalshiMarkets, perTradeSize, MIN_BALANCE_FLOOR, slotsAvailable, tradedMarketIds, tradedQuestions);
      }

      // Step 5: Execute real orders on Polymarket + record in DB
      const allInserts = [];
      const executionResults = [];

      for (const arb of toExecute) {
        const arbProfit = arb.guaranteed_profit * perTradeSize;
        let polyOrderResult = null;
        let orderStatus = "executed";

        // Try to place real order on Polymarket leg
        const isPolyYes = arb.buy_yes_platform === "polymarket";
        const polyTokenId = isPolyYes ? arb.poly_market.token_id_yes : arb.poly_market.token_id_no;
        const polyPrice = isPolyYes ? arb.buy_yes_price : arb.buy_no_price;

        if (polyTokenId && polyPrice > 0) {
          try {
            polyOrderResult = await placePolymarketOrder(
              privateKey,
              polyTokenId,
              polyPrice,
              perTradeSize / polyPrice,
              "BUY",
              true
            );
            orderStatus = "live";
            console.log(`✅ LIVE Poly order: ${arb.poly_market.question} @ $${polyPrice}`);
          } catch (orderErr) {
            console.error(`❌ Poly order failed, skipping this arb: ${orderErr}`);
            continue; // Skip — no simulations
          }
        } else {
          console.log(`❌ No token ID for Poly leg, skipping`);
          continue; // Skip — no simulations
        }

        // Try to place real order on Kalshi leg
        let kalshiLegStatus = "simulated";
        let kalshiOrderId: string | null = null;
        const kalshiTicker = arb.kalshi_market.ticker;
        const isKalshiNo = isPolyYes; // if Poly=YES, Kalshi=NO
        const kalshiPrice = isKalshiNo ? arb.buy_no_price : arb.buy_yes_price;

        if (kalshiTicker && kalshiPrice > 0) {
          try {
            const kalshiResult = await placeKalshiOrder(
              kalshiTicker,
              isKalshiNo ? "no" : "yes",
              isKalshiNo ? (1 - kalshiPrice) : kalshiPrice,
              perTradeSize,
            );
            kalshiLegStatus = "live";
            kalshiOrderId = kalshiResult?.order_id || kalshiResult?.id || null;
            console.log(`✅ LIVE Kalshi order: ${kalshiTicker}`);
          } catch (kalshiErr) {
            console.error(`❌ Kalshi order failed, skipping this arb: ${kalshiErr}`);
            continue; // Skip — no simulations
          }
        } else {
          console.log(`❌ No Kalshi ticker, skipping`);
          continue; // Skip — no simulations
        }

        executionResults.push({ question: arb.poly_market.question, spread: arb.spread_pct, status: orderStatus, kalshiStatus: kalshiLegStatus, orderId: polyOrderResult?.orderID });

        const marketEndDate = arb.poly_market.end_date || arb.kalshi_market.end_date || null;

        allInserts.push(
          {
            market_id: arb.poly_market.id,
            market_question: arb.poly_market.question,
            token_id: polyTokenId || arb.buy_yes_platform,
            side: `BUY_${isPolyYes ? "YES" : "NO"}@POLYMARKET`,
            price: polyPrice,
            size: perTradeSize,
            status: orderStatus,
            order_id: polyOrderResult?.orderID || null,
            profit_loss: arbProfit,
            resolved_at: marketEndDate,
          },
          {
            market_id: arb.poly_market.id,
            market_question: arb.poly_market.question,
            token_id: arb.buy_no_platform === "kalshi" ? (arb.kalshi_market.ticker || "kalshi") : (arb.poly_market.token_id_no || "cross"),
            side: `BUY_${isPolyYes ? "NO" : "YES"}@KALSHI`,
            price: isPolyYes ? arb.buy_no_price : arb.buy_yes_price,
            size: perTradeSize,
            status: kalshiLegStatus,
            order_id: kalshiOrderId,
            profit_loss: 0,
            resolved_at: marketEndDate,
          }
        );
      }

      // If all cross-platform orders failed, fall back to Kalshi-only
      if (allInserts.length === 0) {
        console.log(`Auto-trade: all cross-platform orders failed, falling back to Kalshi internal arbs...`);
        const kalshiArbs = findKalshiInternalArbs(kalshiMarkets);
        console.log(`Auto-trade: ${kalshiArbs.length} Kalshi internal arbs found`);

        const kalshiNew = kalshiArbs.filter(a => {
          if (tradedMarketIds.has(a.market.id)) return false;
          if (tradedQuestions.has(normalize(a.market.question))) return false;
          return true;
        });

        const kalshiToExecute = kalshiNew.slice(0, Math.min(slotsAvailable, 3));
        const kalshiInserts = [];
        const kalshiResults = [];

        for (const arb of kalshiToExecute) {
          const ticker = arb.market.ticker;
          if (!ticker) continue;

          const currentBal = await fetchKalshiBalance();
          const currentAvailable = Math.max(0, currentBal.balance - MIN_BALANCE_FLOOR);
          const tradeSize = Math.min(perTradeSize, currentAvailable * 0.5);
          if (tradeSize < 0.10) {
            console.log(`Auto-trade: stopping — available cash $${currentAvailable.toFixed(2)} too low`);
            break;
          }

          let yesOrderId: string | null = null;
          try {
            const yesResult = await placeKalshiOrder(ticker, "yes", arb.yes_price, tradeSize);
            yesOrderId = yesResult?.order_id || yesResult?.id || null;
            console.log(`✅ Kalshi YES: ${ticker} @ ${(arb.yes_price * 100).toFixed(0)}¢`);
          } catch (e) {
            console.error(`❌ Kalshi YES failed: ${e}`);
            continue;
          }

          let noOrderId: string | null = null;
          try {
            const noResult = await placeKalshiOrder(ticker, "no", 1 - arb.no_price, tradeSize);
            noOrderId = noResult?.order_id || noResult?.id || null;
            console.log(`✅ Kalshi NO: ${ticker} @ ${(arb.no_price * 100).toFixed(0)}¢`);
          } catch (e) {
            console.error(`❌ Kalshi NO failed: ${e}`);
          }

          const arbProfit = arb.guaranteed_profit * tradeSize;
          kalshiResults.push({ question: arb.market.question, spread: arb.spread_pct, ticker });

          kalshiInserts.push(
            {
              market_id: arb.market.id, market_question: arb.market.question,
              token_id: ticker, side: "BUY_YES@KALSHI", price: arb.yes_price,
              size: tradeSize, status: "live", order_id: yesOrderId,
              profit_loss: arbProfit, resolved_at: arb.market.end_date || null,
            },
            {
              market_id: arb.market.id, market_question: arb.market.question,
              token_id: ticker, side: "BUY_NO@KALSHI", price: arb.no_price,
              size: tradeSize, status: noOrderId ? "live" : "failed", order_id: noOrderId,
              profit_loss: 0, resolved_at: arb.market.end_date || null,
            }
          );
        }

        if (kalshiInserts.length > 0) {
          const { data: trades, error: tradeErr } = await supabase
            .from("polymarket_trades").insert(kalshiInserts).select();
          if (tradeErr) throw tradeErr;
          return new Response(JSON.stringify({ executed: true, strategy: "kalshi_internal_fallback", count: kalshiResults.length, trades, results: kalshiResults }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Fall back to ultra-safe value bets (≤5¢ threshold, 48h, $2 max)
        return await executeValueBets(supabase, kalshiMarkets, perTradeSize, MIN_BALANCE_FLOOR, slotsAvailable, tradedMarketIds, tradedQuestions);
      }

      const { data: trades, error: tradeErr } = await supabase
        .from("polymarket_trades")
        .insert(allInserts)
        .select();

      if (tradeErr) throw tradeErr;

      for (const r of executionResults) {
        console.log(`✅ Arb: ${r.question} | ${r.spread}% spread | ${r.status}${r.orderId ? ` | orderID: ${r.orderId}` : ""}`);
      }

      return new Response(JSON.stringify({
        executed: true,
        count: toExecute.length,
        trades,
        cashUsed: perTradeSize * toExecute.length,
        perTradeSize,
        results: executionResults,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ──── TEST ORDER (debug geo-block) ────
    if (action === "test_order") {
      const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");
      if (!privateKey) throw new Error("No private key");

      // Use a real token ID from ETH market (YES side, very cheap test)
      const testTokenId = body.token_id || "58727333181627179512377681687586666008807822047430987604306144030899661571074";
      const testPrice = body.price || 0.99;
      const testSize = body.test_size || 0.01;

      console.log(`🔍 TEST ORDER: token=${testTokenId}, price=${testPrice}, size=${testSize}`);

      try {
        const result = await placePolymarketOrder(privateKey, testTokenId, testPrice, testSize / testPrice, "BUY", true);
        return new Response(JSON.stringify({ success: true, result }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`❌ TEST ORDER FAILED: ${errorMsg}`);
        return new Response(JSON.stringify({ success: false, error: errorMsg }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ──── VPS STATUS (Evoxt) ────
    if (action === "vps_status") {
      const publicKey = Deno.env.get("EVOXT_PUBLIC_KEY");
      const privateKey = Deno.env.get("EVOXT_PRIVATE_KEY");
      const username = Deno.env.get("EVOXT_USERNAME");
      if (!publicKey || !privateKey || !username) {
        return new Response(JSON.stringify({ error: "Evoxt credentials not configured" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      try {
        const auth = btoa(`${publicKey}:${privateKey}`);
        const res = await fetch(`https://api.evoxt.com/listservers?username=${encodeURIComponent(username)}`, {
          headers: { "Authorization": `Basic ${auth}` },
        });
        const data = await res.json();
        // Also return current proxy URL
        const currentProxy = await getProxyUrlFromEvoxt();
        return new Response(JSON.stringify({ servers: data, proxy_url: currentProxy }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ──── SELL POLYMARKET POSITION ────
    if (action === "sell_position") {
      const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");
      if (!privateKey) throw new Error("No private key configured");

      const { token_id, size: sellSize, price: sellPrice, neg_risk } = body;
      if (!token_id) throw new Error("token_id required");

      // If no price/size provided, look up from on-chain positions
      let finalSize = sellSize;
      let finalPrice = sellPrice;

      if (!finalSize || !finalPrice) {
        // Fetch positions to find the token
        const wallet = new Wallet(privateKey);
        const wallets = [wallet.address, KNOWN_WALLET, KNOWN_WALLET_2];
        let foundPosition: any = null;

        for (const addr of wallets) {
          try {
            const posRes = await proxiedFetch(
              `${CLOB_URL}/positions?address=${addr}`,
              { method: "GET", headers: { "Content-Type": "application/json" } }
            );
            if (posRes.ok) {
              const positions = await posRes.json();
              const match = positions?.find?.((p: any) => p.asset === token_id);
              if (match && Number(match.size) > 0) {
                foundPosition = match;
                break;
              }
            }
          } catch (_) {}
        }

        if (!foundPosition) throw new Error("Position not found on-chain");
        if (!finalSize) finalSize = Number(foundPosition.size);

        // Get current market price from orderbook
        if (!finalPrice) {
          try {
            const bookRes = await proxiedFetch(
              `${CLOB_URL}/book?token_id=${token_id}`,
              { method: "GET", headers: { "Content-Type": "application/json" } }
            );
            if (bookRes.ok) {
              const book = await bookRes.json();
              // Best bid is what we can sell at
              const bestBid = book?.bids?.[0]?.price;
              if (bestBid) {
                finalPrice = Number(bestBid);
              } else {
                // Fall back to mid price or current price
                finalPrice = Number(foundPosition.cur_price || foundPosition.avgPrice || 0.25);
              }
            }
          } catch (_) {
            finalPrice = 0.25; // fallback
          }
        }
      }

      console.log(`📤 SELL: token=${token_id}, size=${finalSize}, price=${finalPrice}`);

      const result = await placePolymarketOrder(
        privateKey,
        token_id,
        finalPrice,
        finalSize,
        "SELL",
        neg_risk !== false, // default true
      );

      // Record the sell in DB
      await supabase.from("polymarket_trades").insert({
        market_id: body.market_id || token_id,
        market_question: body.market_question || "Manual sell",
        token_id,
        side: "SELL@POLYMARKET",
        price: finalPrice,
        size: finalSize,
        status: "live",
        order_id: result?.orderID || result?.id || null,
      });

      return new Response(JSON.stringify({
        success: true,
        sold: { token_id, size: finalSize, price: finalPrice },
        result,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ──── SYNC KALSHI TRADES ────
    if (action === "sync_kalshi_trades") {
      const result = await syncKalshiTradesInternal(supabase);
      return new Response(JSON.stringify({
        synced: result.synced,
        won: result.won,
        lost: result.lost,
        total_pnl: result.totalPnl,
        still_active: result.stillActive,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
