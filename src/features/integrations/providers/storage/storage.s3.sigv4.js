'use strict';

const crypto = require('node:crypto');

/** AWS Signature V4 (Marco 9, M9-D242): cabeçalho Authorization e URL pré-assinada para qualquer serviço S3 compatível. Só `node:crypto`, sem SDK. */
const hmac = (key, texto) => crypto.createHmac('sha256', key).update(texto).digest();
const hex = (texto) => crypto.createHash('sha256').update(texto).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const stamp = (now) => now.toISOString().replace(/[:-]|\.\d{3}/g, '');

const canonicalPath = (p) => p.split('/').map(enc).join('/');
const canonicalQuery = (q) => Object.keys(q).sort().map((k) => `${enc(k)}=${enc(String(q[k]))}`).join('&');

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/** Assinatura sobre a requisição canônica. `headers`: já em minúsculas. */
function signature({ method, path, query, headers, payloadHash, secretAccessKey, region, service, amzDate }) {
  const nomes = Object.keys(headers).sort();
  const canonical = [method, canonicalPath(path), canonicalQuery(query), nomes.map((n) => `${n}:${String(headers[n]).trim()}\n`).join(''), nomes.join(';'), payloadHash].join('\n');
  const date = amzDate.slice(0, 8);
  const alvo = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, alvo, hex(canonical)].join('\n');
  return { signature: crypto.createHmac('sha256', signingKey(secretAccessKey, date, region, service)).update(toSign).digest('hex'), signedHeaders: nomes.join(';'), scope: alvo };
}

/** Cabeçalhos assinados de uma chamada (PUT/GET/HEAD/DELETE). Devolve os cabeçalhos finais, com `authorization`. */
function signRequest({ method, host, path, query = {}, headers = {}, body = Buffer.alloc(0), accessKeyId, secretAccessKey, region, service = 's3', now = new Date() }) {
  const amzDate = stamp(now);
  const payloadHash = hex(body);
  const todos = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const s = signature({ method, path, query, headers: todos, payloadHash, secretAccessKey, region, service, amzDate });
  return { ...todos, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${s.scope}, SignedHeaders=${s.signedHeaders}, Signature=${s.signature}` };
}

/** URL pré-assinada (GET ou PUT) válida por `expiresS` segundos. */
function presignUrl({ method = 'GET', host, path, accessKeyId, secretAccessKey, region, service = 's3', expiresS, now = new Date(), protocol = 'https' }) {
  const amzDate = stamp(now);
  const query = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${accessKeyId}/${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`, 'X-Amz-Date': amzDate, 'X-Amz-Expires': expiresS, 'X-Amz-SignedHeaders': 'host' };
  const s = signature({ method, path, query, headers: { host }, payloadHash: 'UNSIGNED-PAYLOAD', secretAccessKey, region, service, amzDate });
  return `${protocol}://${host}${canonicalPath(path)}?${canonicalQuery({ ...query, 'X-Amz-Signature': s.signature })}`;
}

module.exports = { signRequest, presignUrl, canonicalPath };
