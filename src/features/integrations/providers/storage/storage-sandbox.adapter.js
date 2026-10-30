'use strict';

const { Readable } = require('node:stream');
const { StorageAdapter } = require('./storage.port');
const { classifyHttpError } = require('../../registry/classifyHttpError');
const { raiseFault, faultOf } = require('../../registry/sandboxFaults');
const { assertCompanyKey } = require('./storage.key');
const { toBuffer, checkSha256, sha256Of } = require('./storage.body');
const { notFound, integrity } = require('./storage.errors');
const { clampTtl, signSandboxUrl } = require('./storage.signedUrl');
const defaults = require('./storage.defaults');
const store = require('./sandbox/storage.sandbox.store');

const STATUS = Object.freeze({ STORED: 'STORED', FOUND: 'FOUND', DELETED: 'DELETED', OK: 'OK' });
const HOST = 'storage-sandbox.invalid';

/**
 * storage-sandbox (M9-D242): armazenamento de objetos simulado em memória, sem rede. Confere o prefixo `company/<id>/`, o SHA-256 no envio e na leitura, e emite URL assinada
 * (HMAC) com expiração limitada pelo máximo da configuração. Falhas por cabeçalho `x-sandbox-fail`. Um serviço S3 compatível real entra como outro adapter (storage-s3).
 */
class StorageSandboxAdapter extends StorageAdapter {
  providerCode() { return 'storage-sandbox'; }

  capabilities() { return ['putObject', 'getObject', 'deleteObject', 'headObject', 'getSignedUrl']; }

  supportedVersions() { return ['v1']; }

  async healthCheck(ctx, opts) {
    try { return faultOf(ctx || this.ctx, opts || {}) ? { ok: false, latencyMs: 0, detail: 'Falha simulada pelo sandbox.' } : { ok: true, latencyMs: 0, detail: 'Sandbox local: não faz chamada externa.' }; } catch { return { ok: false, latencyMs: 0, detail: 'Falha ao testar o sandbox.' }; }
  }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  async putObject(ctx, request) {
    assertCompanyKey(request.companyId, request.key);
    await raiseFault(ctx, request, 'write');
    const plain = await toBuffer(request.stream ?? request.body, request.maxBytes ?? defaults.maxObjectBytes);
    const sha256 = checkSha256(plain, request.sha256);
    store.put(ctx.connection.id, request.key, { plain, sha256, contentType: request.contentType || 'application/octet-stream', metadata: request.metadata || {} });
    return { externalRequestId: null, externalResourceId: request.key, status: 'STORED', sha256, sizeBytes: plain.length };
  }

  async getObject(ctx, request) {
    assertCompanyKey(request.companyId, request.key);
    await raiseFault(ctx, request, 'read');
    const o = store.get(ctx.connection.id, request.key);
    if (!o) throw notFound();
    const esperado = request.expectedSha256 || o.sha256;
    if (sha256Of(o.plain) !== String(esperado).toLowerCase()) throw integrity('SHA256_MISMATCH');
    return { externalRequestId: null, externalResourceId: request.key, status: 'FOUND', stream: Readable.from([o.plain]), sizeBytes: o.plain.length, contentType: o.contentType, sha256: o.sha256, encryptedAtRest: true };
  }

  async headObject(ctx, request) {
    assertCompanyKey(request.companyId, request.key);
    await raiseFault(ctx, request, 'read');
    const o = store.get(ctx.connection.id, request.key);
    if (!o) throw notFound();
    return { externalRequestId: null, externalResourceId: request.key, status: 'FOUND', sizeBytes: o.plain.length, contentType: o.contentType, sha256: o.sha256 };
  }

  async deleteObject(ctx, request) {
    assertCompanyKey(request.companyId, request.key);
    await raiseFault(ctx, request, 'write');
    store.remove(ctx.connection.id, request.key);
    return { externalRequestId: null, externalResourceId: request.key, status: 'DELETED' };
  }

  /** O TTL pedido é limitado de novo aqui (`maxTtlSeconds`): o adapter nunca confia só em quem chama. */
  async getSignedUrl(ctx, request) {
    assertCompanyKey(request.companyId, request.key);
    await raiseFault(ctx, request, 'read');
    if (!store.get(ctx.connection.id, request.key)) throw notFound();
    const ttl = clampTtl(request.ttlSeconds, request.maxTtlSeconds ?? defaults.maxTtlSeconds);
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return { externalRequestId: null, externalResourceId: request.key, status: 'OK', url: signSandboxUrl(store.SECRET, HOST, request.key, request.method, exp), ttlSeconds: ttl, expiresAt: new Date(exp * 1000).toISOString() };
  }
}

module.exports = { StorageSandboxAdapter, SANDBOX_HOST: HOST };
