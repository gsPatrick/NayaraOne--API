'use strict';

const crypto = require('node:crypto');
const AppError = require('../../../../utils/AppError');
const { assertRecentMfa } = require('../../../users/mfa.service');
const { getSecretStore } = require('../../secrets/secretStoreFactory');
const { rotateConnectionSecret } = require('../../secrets/connectionRotation');
const { assertRefFormat, assertRefBelongsToCompany } = require('../../secrets/secretRef');
const { readActionParams } = require('./actions.params');
const { parseRotateBody } = require('./actions.body');
const { resolveActionConnection } = require('./actions.connection');
const { runConnectionProbe } = require('./testConnection.probe');

/** O novo valor da credencial: lido do cofre na referência informada (o valor nunca trafega pelo pedido) ou gerado aqui, aleatório de 256 bits. */
async function newSecretValue(body, connection, ctx, store) {
  if (body.generate) return crypto.randomBytes(32).toString('base64url');
  assertRefFormat(body.newSecretRef);
  assertRefBelongsToCompany(body.newSecretRef, ctx.companyId, { requirePrefix: false });
  if (body.newSecretRef === connection.secretRef) {
    throw AppError.unprocessable('A referência do novo valor precisa ser diferente da referência em uso.', 'INTEGRATION_SECRET_REF_INVALID');
  }
  const entrega = await store.get(body.newSecretRef);
  return entrega.value.reveal();
}

/**
 * POST /admin/integrations/:provider/rotate-secret (M9-D250 3.3 e M9-D202): gira a credencial da connection com janela de graça. `integration:manage` + MFA recente
 * (parâmetro integration.admin.mfa_on_secret_rotation; em produção a regra de mudar conexão em produção vale sempre). O novo valor entra como candidato, passa pelo mesmo teste da
 * rota de teste de conexão e só então é promovido; se o teste falha a anterior continua. A resposta traz só versões e a data do fim da graça, nunca o valor.
 */
async function rotateSecret(providerCode, rawBody, ctx, transaction, { store } = {}) {
  const body = parseRotateBody(rawBody);
  const params = await readActionParams(ctx, transaction);
  if (params.mfaOnRotation) await assertRecentMfa(ctx.userId, transaction);
  const { connection, provider } = await resolveActionConnection(providerCode, body, ctx, transaction);
  const cofre = store || getSecretStore();
  const newValue = await newSecretValue(body, connection, ctx, cofre);
  const testConnection = async ({ value, version }) => {
    const r = await runConnectionProbe(connection, provider, ctx, transaction, { timeoutMs: params.testTimeoutMs, secretOverride: { value: value.reveal(), version } });
    return r.ok;
  };
  return rotateConnectionSecret(connection.id, { newValue, expiresAt: body.expiresAt, testConnection }, ctx, transaction, { store: cofre });
}

module.exports = { rotateSecret };
