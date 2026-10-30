'use strict';

const { IntegrationConnection, IntegrationProvider } = require('../../../models');
const adapterRegistry = require('../registry/adapterRegistry');
const { getServerEnvironment } = require('../registry/registry.helpers');
const { readStorageParams } = require('./storage.params');

/** Garante os drivers de armazenamento no registro (o servidor os registra no boot; scripts e testes de serviço usam este atalho). */
function ensureStorageRegistered() {
  const { StorageLocalDiskAdapter } = require('../providers/storage/storage-local-disk.adapter');
  const { StorageSandboxAdapter } = require('../providers/storage/storage-sandbox.adapter');
  const { StorageS3Adapter } = require('../providers/storage/storage-s3.adapter');
  [StorageLocalDiskAdapter, StorageSandboxAdapter, StorageS3Adapter].forEach((A) => { if (!adapterRegistry.has(new A(null).providerCode())) adapterRegistry.register(A); });
}

/** Códigos dos fornecedores da família STORAGE (o catálogo é da plataforma e muda raramente: guardado por 30 s para não repetir a consulta a cada arquivo). */
let codesCache = { at: 0, codes: [] };
async function storageCodes(transaction) {
  if (Date.now() - codesCache.at > 30000 || !codesCache.codes.length) {
    codesCache = { at: Date.now(), codes: (await IntegrationProvider.findAll({ where: { domain: 'STORAGE' }, attributes: ['code'], transaction })).map((p) => p.code) };
  }
  return codesCache.codes;
}

/** Contexto mínimo do driver embutido (sem connection): nada de rede nem segredo. */
const builtinCtx = (providerCode) => Object.freeze({
  connection: Object.freeze({ id: `builtin:${providerCode}`, providerCode, environment: 'LOCAL', apiVersion: null, config: {} }), policy: {}, timeouts: {}, http: null, secret: null,
});

/**
 * Qual armazenamento a empresa usa (M9-D242): a connection ACTIVE da família STORAGE (a mais antiga, ou a do driver padrão se houver mais de uma); sem nenhuma, o driver
 * embutido configurado em `integration.storage.default_provider` (padrão: o disco do servidor, o que o sistema já usava). Devolve { adapter, ctx, connection, params }.
 */
async function resolveStorage(tenant, transaction) {
  ensureStorageRegistered();
  const params = await readStorageParams(tenant, transaction);
  const codes = await storageCodes(transaction);
  const ativas = await IntegrationConnection.findAll({
    where: { companyId: tenant.companyId, environment: getServerEnvironment(), status: 'ACTIVE', providerCode: codes }, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction,
  });
  if (ativas.length) {
    const escolhida = ativas.find((c) => c.providerCode === params.defaultProvider) || ativas[0];
    return { adapter: await adapterRegistry.resolve(escolhida, tenant, transaction), connection: escolhida, params };
  }
  const adapter = adapterRegistry.instantiate(params.defaultProvider);
  adapter.ctx = builtinCtx(params.defaultProvider);
  return { adapter, connection: null, params };
}

module.exports = { resolveStorage, ensureStorageRegistered, builtinCtx };
