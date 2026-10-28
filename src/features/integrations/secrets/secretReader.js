'use strict';

const AppError = require('../../../utils/AppError');
const { ctxOk } = require('../registry/registry.helpers');
const { REF_RE, webhookRefOf, assertRefBelongsToCompany } = require('./secretRef');
const { secretNotFound, secretExpired } = require('./secrets.errors');
const { getSecretStore } = require('./secretStoreFactory');
const { readSecretParams } = require('./secretParams');
const { domainOf, isBank, assertPurposeAllowed, assertDriverAllowed } = require('./secretPolicy');
const { evaluateConnectionSecret } = require('./secretExpiry');
const { auditarSegredo } = require('./secretAudit');
const { keyOf, getCached, setCached } = require('./secretCache');

/**
 * Leitura do segredo de uma connection (M9-D202). Valida finalidade, empresa dona, driver e vencimento; usa o
 * cache pelo TTL configurado e audita (BANK: toda leitura; demais: leitura que foi ao cofre). Devolve
 * { value: SecretValue, version, expiresAt }; o texto só sai por value.reveal().
 */
async function readConnectionSecret(connection, ctx, { purpose, kind = 'api', version, transaction, store, now = Date.now() } = {}) {
  ctxOk(ctx);
  if (!connection || connection.companyId !== ctx.companyId) throw AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  const domain = await domainOf(connection, transaction);
  assertPurposeAllowed(domain, purpose);
  const base = connection.secretRef;
  if (!base || !REF_RE.test(base)) throw secretNotFound();
  assertRefBelongsToCompany(base, connection.companyId, { requirePrefix: false });
  const ref = kind === 'webhook' ? webhookRefOf(base) : base;
  const cofre = store || getSecretStore();
  assertDriverAllowed({ domain, environment: connection.environment, driver: cofre.driver });

  const avaliacao = await evaluateConnectionSecret(connection, { domain, now, transaction, ctx });
  if (avaliacao.state === 'EXPIRED') throw secretExpired();

  const params = await readSecretParams(ctx, transaction);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const chave = keyOf(ctx.companyId, connection.id, ref, version);
  const emCache = getCached(chave, nowMs);
  const entrega = emCache || await cofre.get(ref, { version });
  if (!emCache) setCached(chave, entrega, params.cacheTtlS, nowMs);
  if (!emCache || isBank(domain)) {
    await auditarSegredo(ctx, 'integration.secret.read', connection,
      { purpose, kind, version: entrega.version, domain, cache: Boolean(emCache) }, `Leitura de credencial (${purpose}).`, transaction);
  }
  return entrega;
}

module.exports = { readConnectionSecret };
