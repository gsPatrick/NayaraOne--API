'use strict';

const { Readable } = require('node:stream');
const { StorageAdapter } = require('./storage.port');
const { classifyHttpError } = require('../../registry/classifyHttpError');
const { assertCompanyKey } = require('./storage.key');
const { toBuffer, checkSha256, sha256Of } = require('./storage.body');
const { notFound, integrity } = require('./storage.errors');
const defaults = require('./storage.defaults');
const disk = require('./storage.localdisk.fs');

const STATUS = Object.freeze({ STORED: 'STORED', FOUND: 'FOUND', DELETED: 'DELETED', OK: 'OK' });

/**
 * storage-local-disk (M9-D242 3.1): o armazenamento que o sistema já usa (arquivos cifrados em `uploads/`, `UPLOADS_DIR`), atrás do port. É o driver de DEV e o padrão
 * quando a empresa não configurou outro. Não tem URL assinada (não há servidor de objetos): a leitura passa sempre pela API, com a permissão do módulo dono.
 * O layout em disco é o do sistema (o caminho relativo da chave, sem o prefixo `company/<id>/`), para os arquivos antigos continuarem legíveis.
 */
class StorageLocalDiskAdapter extends StorageAdapter {
  providerCode() { return 'storage-local-disk'; }

  capabilities() { return ['putObject', 'getObject', 'deleteObject', 'headObject']; }

  supportedVersions() { return ['v1']; }

  async healthCheck() { return { ok: true, latencyMs: 0, detail: 'Disco local do servidor: não depende de rede.' }; }

  classifyError(e) { return classifyHttpError(e); }

  mapStatus(externalStatus) {
    const s = String(externalStatus ?? '').toUpperCase();
    return Object.prototype.hasOwnProperty.call(STATUS, s) ? STATUS[s] : null;
  }

  async putObject(_ctx, request) {
    const relative = assertCompanyKey(request.companyId, request.key);
    const plain = await toBuffer(request.stream ?? request.body, request.maxBytes ?? defaults.maxObjectBytes);
    checkSha256(plain, request.sha256);
    const r = disk.write(relative, plain, { contentType: request.contentType, metadata: request.metadata });
    return { externalRequestId: null, externalResourceId: request.key, status: 'STORED', sha256: r.sha256, sizeBytes: r.sizeBytes };
  }

  async getObject(_ctx, request) {
    const relative = assertCompanyKey(request.companyId, request.key);
    const { plain, encryptedAtRest, meta } = disk.read(relative, { expectEncrypted: request.expectEncrypted === true });
    const esperado = request.expectedSha256 || (meta && meta.sha256);
    if (esperado && sha256Of(plain) !== String(esperado).toLowerCase()) throw integrity('SHA256_MISMATCH');
    return {
      externalRequestId: null, externalResourceId: request.key, status: 'FOUND', stream: Readable.from([plain]), sizeBytes: plain.length,
      contentType: meta ? meta.contentType : null, sha256: meta ? meta.sha256 : null, encryptedAtRest,
    };
  }

  async headObject(_ctx, request) {
    const h = disk.head(assertCompanyKey(request.companyId, request.key));
    if (!h) throw notFound();
    return { externalRequestId: null, externalResourceId: request.key, status: 'FOUND', ...h };
  }

  async deleteObject(_ctx, request) {
    disk.remove(assertCompanyKey(request.companyId, request.key));
    return { externalRequestId: null, externalResourceId: request.key, status: 'DELETED' };
  }
}

module.exports = { StorageLocalDiskAdapter };
