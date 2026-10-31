'use strict';

const { Readable } = require('node:stream');
const { StorageAdapter } = require('./storage.port');
const { classifyHttpError } = require('../../registry/classifyHttpError');
const { assertCompanyKey } = require('./storage.key');
const { toBuffer, checkSha256, sha256Of } = require('./storage.body');
const { notFound, integrity } = require('./storage.errors');
const { clampTtl } = require('./storage.signedUrl');
const { signRequest, presignUrl } = require('./storage.s3.sigv4');
const defaults = require('./storage.defaults');
const { s3Target } = require('./storage.s3.target');

const STATUS = Object.freeze({ STORED: 'STORED', FOUND: 'FOUND', DELETED: 'DELETED', OK: 'OK' });

/**
 * storage-s3 (M9-D242 3.1): qualquer serviço de armazenamento de objetos compatível com S3 (AWS, MinIO, R2...). A conta real é configuração da connection:
 * `config.endpoint` (host), `config.region`, `config.bucket`, `config.pathStyle`; a chave de acesso vem do cofre (JSON `{ accessKeyId, secretAccessKey }`). O conteúdo
 * fica cifrado em repouso pelo próprio serviço (SSE AES256, gerida pelo provider); assim a URL assinada entrega o arquivo legível a quem a recebe. O host precisa estar na lista de saída da connection (policy.egressHosts).
 */
class StorageS3Adapter extends StorageAdapter {
  providerCode() { return 'storage-s3'; }

  capabilities() { return ['putObject', 'getObject', 'deleteObject', 'headObject', 'getSignedUrl']; }

  supportedVersions() { return ['v1']; }

  async healthCheck(ctx) {
    const t0 = Date.now();
    try { await this.credentials(ctx || this.ctx); return { ok: true, latencyMs: Date.now() - t0, detail: 'Credencial lida do cofre; sem chamada de teste ao serviço.' }; } catch { return { ok: false, latencyMs: Date.now() - t0, detail: 'Credencial indisponível no cofre.' }; }
  }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  async credentials(ctx) { return JSON.parse(await ctx.secret('storage')); }

  /** host e caminho do objeto conforme o estilo (path-style ou virtual-hosted) da connection. */
  target(ctx, key) {
    return s3Target(ctx.connection.config, key, { privateHosts: ctx.privateHosts || [] });
  }

  async call(ctx, method, key, { body = Buffer.alloc(0), headers = {} } = {}) {
    const { accessKeyId, secretAccessKey } = await this.credentials(ctx);
    const t = this.target(ctx, key);
    const assinados = signRequest({ method, host: t.host, path: t.path, headers, body, accessKeyId, secretAccessKey, region: t.region });
    return ctx.http.request({ method, url: `https://${t.host}${t.path}`, headers: assinados, body: method === 'PUT' ? body : undefined });
  }

  async putObject(ctx, request) {
    assertCompanyKey(request.companyId, request.key);
    const plain = await toBuffer(request.stream ?? request.body, request.maxBytes ?? defaults.maxObjectBytes);
    const sha256 = checkSha256(plain, request.sha256);
    const r = await this.call(ctx, 'PUT', request.key, { body: plain, headers: { 'content-type': request.contentType || 'application/octet-stream', 'x-amz-server-side-encryption': 'AES256', 'x-amz-meta-sha256': sha256 } });
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error('O serviço de armazenamento recusou a gravação.'), { status: r.status });
    return { externalRequestId: r.headers.get('x-amz-request-id'), externalResourceId: request.key, status: 'STORED', sha256, sizeBytes: plain.length };
  }

  async getObject(ctx, request) {
    assertCompanyKey(request.companyId, request.key);
    const r = await this.call(ctx, 'GET', request.key);
    if (r.status === 404) throw notFound();
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error('O serviço de armazenamento recusou a leitura.'), { status: r.status });
    const plain = Buffer.from(await r.arrayBuffer());
    const esperado = request.expectedSha256 || r.headers.get('x-amz-meta-sha256');
    if (esperado && sha256Of(plain) !== String(esperado).toLowerCase()) throw integrity('SHA256_MISMATCH');
    return { externalRequestId: r.headers.get('x-amz-request-id'), externalResourceId: request.key, status: 'FOUND', stream: Readable.from([plain]), sizeBytes: plain.length, contentType: r.headers.get('content-type'), sha256: esperado || null, encryptedAtRest: true };
  }

  async headObject(ctx, request) {
    assertCompanyKey(request.companyId, request.key);
    const r = await this.call(ctx, 'HEAD', request.key);
    if (r.status === 404) throw notFound();
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error('O serviço de armazenamento recusou a consulta.'), { status: r.status });
    return { externalRequestId: r.headers.get('x-amz-request-id'), externalResourceId: request.key, status: 'FOUND', sizeBytes: Number(r.headers.get('content-length')) || null, contentType: r.headers.get('content-type'), sha256: r.headers.get('x-amz-meta-sha256') };
  }

  async deleteObject(ctx, request) {
    assertCompanyKey(request.companyId, request.key);
    const r = await this.call(ctx, 'DELETE', request.key);
    if (r.status !== 404 && (r.status < 200 || r.status >= 300)) throw Object.assign(new Error('O serviço de armazenamento recusou a remoção.'), { status: r.status });
    return { externalRequestId: r.headers.get('x-amz-request-id'), externalResourceId: request.key, status: 'DELETED' };
  }

  async getSignedUrl(ctx, request) {
    assertCompanyKey(request.companyId, request.key);
    const { accessKeyId, secretAccessKey } = await this.credentials(ctx);
    const t = this.target(ctx, request.key);
    const ttl = clampTtl(request.ttlSeconds, request.maxTtlSeconds ?? defaults.maxTtlSeconds);
    const url = presignUrl({ method: String(request.method || 'GET').toUpperCase(), host: t.host, path: t.path, accessKeyId, secretAccessKey, region: t.region, expiresS: ttl });
    return { externalRequestId: null, externalResourceId: request.key, status: 'OK', url, ttlSeconds: ttl, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }
}

module.exports = { StorageS3Adapter };
