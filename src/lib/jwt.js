// Minimal stateless JWT (HS256) implementation using Web Crypto.
// No external dependencies - Workers runtime provides crypto.subtle natively.

import { b64, unb64 } from "./util.js";

function textToB64(obj) {
  return b64(new TextEncoder().encode(JSON.stringify(obj)));
}

function b64ToObj(str) {
  return JSON.parse(new TextDecoder().decode(unb64(str)));
}

async function getKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signJwt(payload, secret, expiresInSeconds) {
  const header = { alg: "HS256", typ: "JWT" };
  const body = { ...payload, iat: Math.floor(Date.now() / 1000) };
  if (expiresInSeconds) body.exp = body.iat + expiresInSeconds;
  const unsigned = `${textToB64(header)}.${textToB64(body)}`;
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64(new Uint8Array(sig))}`;
}

export async function verifyJwt(token, secret) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await getKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC", key, unb64(s), new TextEncoder().encode(`${h}.${p}`)
  );
  if (!valid) return null;
  const payload = b64ToObj(p);
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}
