'use strict';

const { carregarTravada } = require('../../registry/connections.service');
const { REF_RE, assertRefBelongsToCompany } = require('../../secrets/secretRef');
const { secretNotFound } = require('../../secrets/secrets.errors');
const { getSecretStore } = require('../../secrets/secretStoreFactory');
const { readSecretParams } = require('../../secrets/secretParams');
const { domainOf, assertDriverAllowed } = require('../../secrets/secretPolicy');
const { rotateStoredSecret } = require('../../secrets/secretRotation');
const { auditarSegredo } = require('../../secrets/secretAudit');
const { clearConnectionCache } = require('../../secrets/secretCache');

/**
 * Guarda a credencial que o fornecedor acabou de emitir (`adapter.renewCredential()`, ex.: refresh OAuth) como NOVA versão no
 * cofre, com a janela de graça da rotação (M9-D202). Ação do sistema: não pede MFA. A resposta do fornecedor é a prova da credencial,
 * por isso o teste de promoção aceita a candidata. Sem referência no cofre não há onde guardar: falha e a connection é pausada.
 * `credential`: { newValue, expiresAt? }.
 */
async function storeRenewedCredential(ctx, connectionId, credential, transaction) {
  const c = await carregarTravada(connectionId, ctx, transaction);
  if (!c.secretRef || !REF_RE.test(c.secretRef)) throw secretNotFound();
  assertRefBelongsToCompany(c.secretRef, c.companyId, { requirePrefix: false });
  const cofre = getSecretStore();
  assertDriverAllowed({ domain: await domainOf(c, transaction), environment: c.environment, driver: cofre.driver });
  const params = await readSecretParams(ctx, transaction);
  const expiresAt = credential && credential.expiresAt ? new Date(credential.expiresAt) : null;
  const r = await rotateStoredSecret(cofre, c.secretRef, { newValue: credential && credential.newValue, expiresAt, graceMs: params.graceMin * 60 * 1000, testConnection: async () => true });
  c.lastSecretRotationAt = new Date();
  c.secretExpiresAt = expiresAt;
  await c.save({ transaction });
  clearConnectionCache(c.companyId, c.id);
  await auditarSegredo(ctx, 'integration.secret.rotated', c, { fromVersion: r.previousVersion, toVersion: r.version, origin: 'AUTO_RENEWAL' }, 'Credencial renovada pelo fornecedor após recusa (renovação automática).', transaction);
  return r;
}

module.exports = { storeRenewedCredential };
