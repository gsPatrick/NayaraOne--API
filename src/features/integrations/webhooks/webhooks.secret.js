'use strict';

const { IntegrationConnection } = require('../../../models');
const { getSecretStore } = require('../secrets/secretStoreFactory');
const { REF_RE, webhookRefOf, assertRefBelongsToCompany } = require('../secrets/secretRef');
const { domainOf, isBank, assertDriverAllowed } = require('../secrets/secretPolicy');
const { auditarSegredo } = require('../secrets/secretAudit');

/**
 * Segredos aceitos do webhook da connection (M9-D211 passo 5): o cofre (SecretStore, referência irmã `<secretRef>/webhook-secret`) devolve a versão
 * corrente e, durante a janela de graça da rotação (M9-D202), também a anterior. Sem referência, sem cofre ou sem segredo gravado: lista vazia, e a rota
 * recusa a assinatura como inválida (nunca aceita sem segredo). Nada do valor sai deste módulo além do texto entregue ao verificador.
 */
async function acceptedWebhookSecrets(conn, transaction) {
  const connection = await IntegrationConnection.findOne({ where: { id: conn.connectionId, companyId: conn.companyId }, transaction });
  if (!connection || !connection.secretRef || !REF_RE.test(connection.secretRef)) return { secrets: [], reason: 'segredo do webhook não configurado' };
  assertRefBelongsToCompany(connection.secretRef, connection.companyId, { requirePrefix: false });
  let store;
  try { store = getSecretStore(); } catch { return { secrets: [], reason: 'cofre de segredos indisponível' }; }
  const domain = await domainOf(connection, transaction);
  assertDriverAllowed({ domain, environment: connection.environment, driver: store.driver });
  let versoes;
  try {
    versoes = await store.getAcceptedVersions(webhookRefOf(connection.secretRef));
  } catch (err) {
    if (err && err.code === 'INTEGRATION_SECRET_NOT_FOUND') return { secrets: [], reason: 'segredo do webhook não configurado' };
    throw err;
  }
  if (isBank(domain)) {
    await auditarSegredo({ groupId: conn.groupId, companyId: conn.companyId, userId: null }, 'integration.secret.read', connection,
      { purpose: 'webhook', kind: 'webhook', versions: versoes.map((v) => v.version), domain, cache: false }, 'Leitura de credencial (webhook).', transaction);
  }
  return { secrets: versoes.map((v) => v.value.reveal()), reason: versoes.length ? null : 'segredo do webhook não configurado', connection };
}

module.exports = { acceptedWebhookSecrets };
