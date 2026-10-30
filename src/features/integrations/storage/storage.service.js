'use strict';

const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { validar } = require('../registry/jsonSchemaLite');
const { requestInvalid } = require('../registry/adapters.errors');
const { assertCompanyKey } = require('../providers/storage/storage.key');
const { toBuffer } = require('../providers/storage/storage.body');
const { deleteForbidden } = require('../providers/storage/storage.errors');
const { clampTtl } = require('../providers/storage/storage.signedUrl');
const { resolveStorage } = require('./storage.resolve');

/** Quem pode remover objeto (M9-D242 3.1): a retenção de dados e a compensação de uma gravação desfeita; nenhum usuário nem módulo de negócio. */
const DELETE_PURPOSES = Object.freeze(['RETENTION', 'ROLLBACK_CLEANUP']);

const unsupported = () => AppError.unprocessable('Operação não suportada por este fornecedor.', 'INTEGRATION_CAPABILITY_UNSUPPORTED');

/** Chama a operação do adapter da empresa depois de conferir a capability, o pedido contra o schema do port e a chave contra a empresa. */
async function run(tenant, operation, request, transaction) {
  assertCompanyKey(tenant.companyId, request.key); // o isolamento por empresa vem antes de qualquer outra regra
  const { adapter, params } = await resolveStorage(tenant, transaction);
  if (!adapter.supports(operation)) throw unsupported();
  const pedido = { ...request, companyId: tenant.companyId };
  const problemas = validar(adapter.constructor.operations[operation].inputSchema, pedido);
  if (problemas.length) throw requestInvalid(operation, problemas);
  const resposta = await adapter[operation](adapter.ctx, pedido, { tenant, transaction });
  return { resposta, params, adapter };
}

const audit = (tenant, action, key, reason, transaction) => registrarAuditoria({
  groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId || null, action, entityType: 'StorageObject', entityId: null, afterJson: { key }, reason,
}, transaction);

/** Grava o objeto. `body`: Buffer, texto ou stream. O hash informado é conferido (422 INTEGRATION_STORAGE_SHA256_MISMATCH). Devolve { key, sha256, sizeBytes }. */
async function putObject(tenant, { key, body, contentType, sha256, metadata }, transaction) {
  const { params } = await resolveStorage(tenant, transaction);
  const buffer = await toBuffer(body, params.maxObjectBytes);
  const { resposta } = await run(tenant, 'putObject', { key, body: buffer, contentType, sha256, metadata, maxBytes: params.maxObjectBytes }, transaction);
  return { key, sha256: resposta.sha256, sizeBytes: resposta.sizeBytes };
}

/** Lê o objeto como Buffer, conferindo o hash (o gravado e, se informado, `expectedSha256`). `sensitive` registra o acesso na auditoria. */
async function getObject(tenant, { key, expectedSha256, expectEncrypted, sensitive }, transaction) {
  const { resposta } = await run(tenant, 'getObject', { key, expectedSha256, expectEncrypted }, transaction);
  if (sensitive) await audit(tenant, 'integration.storage.read_sensitive', key, 'Leitura de objeto sensível.', transaction);
  const buffer = await toBuffer(resposta.stream);
  return { buffer, contentType: resposta.contentType || null, sha256: resposta.sha256 || null, sizeBytes: buffer.length, encryptedAtRest: Boolean(resposta.encryptedAtRest) };
}

const headObject = async (tenant, { key }, transaction) => {
  const { resposta } = await run(tenant, 'headObject', { key }, transaction);
  return { sizeBytes: resposta.sizeBytes, contentType: resposta.contentType || null, sha256: resposta.sha256 || null };
};

/** URL assinada com a validade limitada por `integration.storage.signed_url_max_ttl_s`. Devolve { url, ttlSeconds, expiresAt }. */
async function getSignedUrl(tenant, { key, ttlSeconds, method, sensitive }, transaction) {
  const { params } = await resolveStorage(tenant, transaction);
  const ttl = clampTtl(ttlSeconds, params.signedUrlMaxTtlS);
  const { resposta } = await run(tenant, 'getSignedUrl', { key, ttlSeconds: ttl, maxTtlSeconds: params.signedUrlMaxTtlS, method: method || 'GET' }, transaction);
  if (sensitive) await audit(tenant, 'integration.storage.signed_url_sensitive', key, `URL assinada de objeto sensível emitida (${ttl} s).`, transaction);
  return { url: resposta.url, ttlSeconds: resposta.ttlSeconds, expiresAt: resposta.expiresAt };
}

/** Remove o objeto. Só com `purpose` RETENTION (módulo de retenção) ou ROLLBACK_CLEANUP; qualquer outro: 403 INTEGRATION_STORAGE_DELETE_FORBIDDEN. */
async function deleteObject(tenant, { key, purpose }, transaction) {
  if (!DELETE_PURPOSES.includes(purpose)) throw deleteForbidden();
  await run(tenant, 'deleteObject', { key }, transaction);
  return { key, deleted: true };
}

/**
 * Prepara a remoção de um objeto recém-gravado caso a transação volte (compensação, não remoção de usuário): resolve o armazenamento AGORA, dentro da transação, e devolve
 * a função que apaga depois do rollback (que não pode mais consultar o banco). A função nunca lança.
 */
async function prepareRollbackCleanup(tenant, key, transaction) {
  const { adapter } = await resolveStorage(tenant, transaction);
  const pedido = { key, companyId: tenant.companyId };
  return async () => { try { await adapter.deleteObject(adapter.ctx, pedido); } catch { /* compensação best-effort */ } };
}

module.exports = { prepareRollbackCleanup, putObject, getObject, headObject, getSignedUrl, deleteObject, DELETE_PURPOSES };
