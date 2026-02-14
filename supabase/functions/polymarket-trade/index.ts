import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Wallet, utils } from "https://esm.sh/ethers@5.7.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GAMMA_URL = "https://gamma-api.polymarket.com";
const KALSHI_URL = "https://api.elections.kalshi.com/trade-api/v2";
const CLOB_URL = "https://clob.polymarket.com";

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
  // Count = number of contracts. Each contract pays $1. cost = count * price_cents / 100
  const count = Math.max(1, Math.round(sizeUsd / (priceCents / 100)));
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

// Fetch USDC cash balance
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

// ──────────── ORDER SIGNING & PLACEMENT ────────────

// Round price to nearest tick (0.01)
function roundToTick(price: number): number {
  return Math.round(price * 100) / 100;
}

// Create, sign, and post an order to Polymarket CLOB
async function placePolymarketOrder(
  privateKey: string,
  tokenId: string,
  price: number,
  size: number,
  side: "BUY",
  negRisk: boolean = true,
): Promise<any> {
  const wallet = new Wallet(privateKey);
  const creds = await deriveL2Creds(privateKey);

  // Round price to tick size
  const tickPrice = roundToTick(price);
  const sideInt = 0; // BUY
  const signatureType = 0; // EOA

  // Amounts in raw units (6 decimals for both USDC and tokens)
  const makerAmount = String(Math.round(tickPrice * size * 1e6)); // USDC to pay
  const takerAmount = String(Math.round(size * 1e6)); // tokens to receive

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

  // Post to CLOB
  const res = await fetch(`${CLOB_URL}/order`, {
    method: "POST",
    headers: { ...l2Headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      order: { ...order, signature, side: "BUY", signatureType },
      owner: wallet.address,
      orderType: "GTC",
    }),
  });

  const resData = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Order failed [${res.status}]: ${JSON.stringify(resData)}`);
  }

  console.log(`✅ Real order placed: ${tokenId} @ $${tickPrice} × ${size}`);
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
  platform: "polymarket" | "kalshi";
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

async function fetchKalshiMarkets(maxPages = 5): Promise<MarketData[]> {
  const allMarkets: MarketData[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      limit: "1000",
      status: "open",
      mve_filter: "exclude", // Only single binary markets
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

    for (const m of markets) {
      // ─── SKIP MVE / parlay markets (multi-leg combos) ───
      if (m.mve_collection_ticker) continue;
      if (m.market_type === "multi_variate") continue;
      const title = m.title || "";
      // MVE titles look like "yes Team1,yes Team2,no Team3"
      if (/^(yes|no) .+,(yes|no) /i.test(title)) continue;

      // ─── Use subtitle as primary (cleaner question format) ───
      const question = m.subtitle || m.title || m.yes_sub_title || "";
      if (question.length < 5) continue;

      // ─── Price: use midpoint of bid/ask for accuracy ───
      const yesBid = m.yes_bid ?? 0;
      const yesAsk = m.yes_ask ?? 0;
      const noBid = m.no_bid ?? 0;
      const noAsk = m.no_ask ?? 0;

      // Use ask for buying (worst case for us = conservative arb)
      const yesPrice = yesAsk > 0 ? yesAsk : (m.last_price ?? 0);
      const noPrice = noAsk > 0 ? noAsk : (100 - (m.last_price ?? 50));

      if (yesPrice <= 0 || noPrice <= 0) continue;
      if (yesPrice >= 99 || noPrice >= 99) continue; // Skip illiquid extremes

      allMarkets.push({
        id: m.ticker || "",
        question,
        yes_price: yesPrice / 100,
        no_price: noPrice / 100,
        platform: "kalshi" as const,
        volume: m.volume_24h || m.volume || 0,
        end_date: m.close_time || m.expiration_time,
        ticker: m.ticker,
        category: m.event_ticker || "",
      });
    }

    if (!cursor || markets.length < 1000) break;
  }

  console.log(`Kalshi: ${allMarkets.length} single-binary markets after filtering`);
  return allMarkets;
}

// ──────────── CROSS-PLATFORM ARB FINDER ────────────

interface CrossPlatformArb {
  poly_market: MarketData;
  kalshi_market: MarketData;
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
        const allAddresses = [eoaAddress, proxyAddress, safeAddress, KNOWN_WALLET].filter((a, i, arr) => a && a !== "" && arr.indexOf(a) === i);
        console.log(`EOA: ${eoaAddress}, Proxy: ${proxyAddress}, Safe: ${safeAddress}`);

        // Step 2: Fetch cash balance + positions for ALL derived addresses
        const positionPromises = allAddresses.map(addr =>
          fetch(`https://data-api.polymarket.com/positions?user=${addr}`)
            .then(r => r.ok ? r.json() : [])
            .then(data => { console.log(`Positions for ${addr}: ${(data || []).length}`); return data || []; })
            .catch(() => [])
        );

        const [balResult, ...posResults] = await Promise.allSettled([
          deriveAndFetchBalance(privateKey),
          ...positionPromises,
        ]);

        // Merge positions from all addresses
        const rawPositions = posResults.flatMap(r => r.status === "fulfilled" ? (r.value || []) : []);
        console.log(`Total positions found: ${rawPositions.length}`);

        // Cash balance
        if (balResult.status === "fulfilled") {
          const data = balResult.value;
          balances.polymarket = {
            balance: Number(data.balance || 0) / 1e6,
            allowance: Number(data.allowance || 0) / 1e6,
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
      const [polymarkets, kalshiMarkets] = await Promise.all([
        fetchPolymarkets(200),
        fetchKalshiMarkets(3),
      ]);

      console.log(`Scan: ${polymarkets.length} Poly × ${kalshiMarkets.length} Kalshi`);

      const arbs = findCrossPlatformArbs(polymarkets, kalshiMarkets, 0.15).slice(0, 50);
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
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ──── LIVE SCAN ────
    if (action === "live_scan") {
      const now = new Date();
      const soon = new Date(now.getTime() + 72 * 60 * 60 * 1000); // 72h window

      const [polymarkets, kalshiMarkets] = await Promise.all([
        fetchPolymarkets(200),
        fetchKalshiMarkets(3),
      ]);

      const filterSoon = (m: MarketData) => {
        if (!m.end_date) return false;
        const end = new Date(m.end_date);
        return end > now && end <= soon;
      };

      const soonPoly = polymarkets.filter(filterSoon);
      const soonKalshi = kalshiMarkets.filter(filterSoon);

      const arbs1 = findCrossPlatformArbs(soonPoly, kalshiMarkets, 0.15);
      const arbs2 = findCrossPlatformArbs(polymarkets, soonKalshi, 0.15);

      // Deduplicate by poly market id
      const seen = new Set<string>();
      const combined: (CrossPlatformArb & { hours_left: number })[] = [];
      for (const a of [...arbs1, ...arbs2]) {
        if (seen.has(a.poly_market.id)) continue;
        seen.add(a.poly_market.id);
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

      const privateKey = Deno.env.get("POLYMARKET_PRIVATE_KEY");
      if (!privateKey) {
        return new Response(JSON.stringify({ skipped: true, reason: "No private key configured" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Step 1: Fetch real USDC cash balance for sizing
      let cashBalance = 0;
      try {
        const bal = await fetchCashBalance(privateKey);
        cashBalance = bal.balance;
        console.log(`Auto-trade: cash balance = $${cashBalance.toFixed(2)}`);
      } catch (e) {
        console.error("Failed to fetch balance:", e);
      }

      if (cashBalance < 0.10) {
        console.log(`Auto-trade: skipped — insufficient cash ($${cashBalance.toFixed(2)})`);
        return new Response(JSON.stringify({ skipped: true, reason: `Insufficient cash balance: $${cashBalance.toFixed(2)}` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Step 2: Check existing positions
      const { data: existingTrades } = await supabase
        .from("polymarket_trades")
        .select("market_id, market_question")
        .eq("status", "executed");

      const tradedMarketIds = new Set((existingTrades || []).map((t) => t.market_id));
      const tradedQuestions = new Set((existingTrades || []).map((t) => normalize(t.market_question || "")));
      const openPositions = tradedMarketIds.size / 2;

      if (openPositions >= settings.max_open_trades) {
        console.log(`Auto-trade: skipped — ${openPositions}/${settings.max_open_trades} positions filled`);
        return new Response(JSON.stringify({ skipped: true, reason: "Max open arb positions reached" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Step 3: Calculate per-trade size from balance
      const slotsAvailable = settings.max_open_trades - openPositions;
      const perTradeSize = Math.min(
        Math.floor(cashBalance / Math.min(slotsAvailable, 3) * 100) / 100, // spread across up to 3 slots
        cashBalance * 0.5 // never use more than 50% on a single trade
      );

      if (perTradeSize < 0.10) {
        console.log(`Auto-trade: trade size too small ($${perTradeSize.toFixed(2)})`);
        return new Response(JSON.stringify({ skipped: true, reason: `Trade size too small: $${perTradeSize.toFixed(2)}` }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`Auto-trade: sizing $${perTradeSize.toFixed(2)}/trade (${slotsAvailable} slots, $${cashBalance.toFixed(2)} cash)`);

      // Step 4: Find arbs
      const [polymarkets, kalshiMarkets] = await Promise.all([
        fetchPolymarkets(500),
        fetchKalshiMarkets(5),
      ]);

      const minSpread = (1 - settings.min_confidence) * 100;
      const now = Date.now();
      const MIN_MS = 1 * 60 * 1000;        // 1 minute
      const MAX_MS = 2 * 60 * 60 * 1000;   // 2 hours

      const arbs = findCrossPlatformArbs(polymarkets, kalshiMarkets, 0.2)
        .filter((a) => {
          if (!a.is_arb || a.spread_pct < minSpread) return false;
          // Only trade markets resolving between 1 min and 2 hours from now
          const endStr = a.poly_market.end_date || a.kalshi_market.end_date;
          if (!endStr) return false;
          const msLeft = new Date(endStr).getTime() - now;
          return msLeft >= MIN_MS && msLeft <= MAX_MS;
        });

      console.log(`Auto-trade: ${arbs.length} arbs within 1min-2hr window`);

      const newArbs = arbs.filter((a) => {
        if (tradedMarketIds.has(a.poly_market.id)) return false;
        if (tradedQuestions.has(normalize(a.poly_market.question))) return false;
        return true;
      });

      const toExecute = newArbs.slice(0, Math.min(slotsAvailable, 3));

      if (toExecute.length === 0) {
        console.log(`Auto-trade: no new arbs (${arbs.length} found, all already traded)`);
        return new Response(JSON.stringify({ skipped: true, reason: "No new cross-platform arbs" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
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
              perTradeSize / polyPrice, // shares = USDC / price
              "BUY",
              true // neg risk (most markets)
            );
            orderStatus = "live";
            console.log(`✅ REAL order placed: ${arb.poly_market.question} @ $${polyPrice} | order: ${JSON.stringify(polyOrderResult).slice(0, 200)}`);
          } catch (orderErr) {
            console.error(`⚠️ Real order failed, recording as simulated: ${orderErr}`);
            orderStatus = "simulated";
          }
        } else {
          orderStatus = "simulated";
          console.log(`⚠️ No token ID for Poly leg, recording as simulated`);
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
              isKalshiNo ? (1 - kalshiPrice) : kalshiPrice, // yes_price for the API
              perTradeSize,
            );
            kalshiLegStatus = "live";
            kalshiOrderId = kalshiResult?.order_id || kalshiResult?.id || null;
            console.log(`✅ Kalshi order: ${kalshiTicker} | ${kalshiLegStatus}`);
          } catch (kalshiErr) {
            console.error(`⚠️ Kalshi order failed: ${kalshiErr}`);
            kalshiLegStatus = "simulated";
          }
        }

        executionResults.push({ question: arb.poly_market.question, spread: arb.spread_pct, status: orderStatus, kalshiStatus: kalshiLegStatus, orderId: polyOrderResult?.orderID });

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
          }
        );
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
