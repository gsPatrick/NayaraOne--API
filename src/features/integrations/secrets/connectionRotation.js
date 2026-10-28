'use strict';

const { carregarTravada } = require('../registry/connections.service');
const { exigirMfaEmProducao } = require('../registry/registry.auditoria');
const { REF_RE, assertRefBelongsToCompany } = require('./secretRef');
const { secretNotFound } = require('./secrets.errors');
const { getSecretStore } = require('./secretStoreFactory');
const { readSecretParams } = require('./secretParams');
const { domainOf, assertDriverAllowed, exigirMfaSegredoBank } = require('./secretPolicy');
const { rotateStoredSecret } = require('./secretRotation');
const { auditarSegredo } = require('./secretAudit');
const { clearConnectionCache } = require('./secretCache');

/** Rotação do segredo de uma connection (a rota HTTP é da M9-D250): cofre + datas da connection + auditoria só com versões. */
async function rotateConnectionSecret(connectionId, { newValue, expiresAt = null, testConnection }, ctx, transaction, { store, now = Date.now() } = {}) {
  const c = await carregarTravada(connectionId, ctx, transaction);
  const domain = await domainOf(c, transaction);
  if (!c.secretRef || !REF_RE.test(c.secretRef)) throw secretNotFound();
  assertRefBelongsToCompany(c.secretRef, c.companyId, { requirePrefix: false });
  const cofre = store || getSecretStore();
  assertDriverAllowed({ domain, environment: c.environment, driver: cofre.driver });
  await exigirMfaEmProducao(c.environment, ctx, transaction);
  await exigirMfaSegredoBank(domain, ctx, transaction);
  const params = await readSecretParams(ctx, transaction);

  const r = await rotateStoredSecret(cofre, c.secretRef, { newValue, expiresAt, graceMs: params.graceMin * 60 * 1000, testConnection, now });
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  c.lastSecretRotationAt = new Date(nowMs);
  c.secretExpiresAt = expiresAt ? new Date(expiresAt) : null;
  c.updatedBy = ctx.userId || null;
  await c.save({ transaction });
  clearConnectionCache(c.companyId, c.id);
  await auditarSegredo(ctx, 'integration.secret.rotated', c,
    { fromVersion: r.previousVersion, toVersion: r.version, graceUntil: r.graceUntil, domain }, 'Credencial rotacionada.', transaction);
  return { connectionId: c.id, ...r };
}

module.exports = { rotateConnectionSecret };
