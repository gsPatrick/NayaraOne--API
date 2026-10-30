'use strict';

const crypto = require('node:crypto');
const { IntegrationConnection, TenantSetting } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getSetting, getDecryptedSetting } = require('../../settings/settings.service');
const registry = require('../../integrations/registry/registry.service');
const { transitionConnection } = require('../../integrations/registry/connections.transition');
const { getSecretStore } = require('../../integrations/secrets');
const { ensureAdapterRegistered } = require('./signature.boot');

/** `legal.signature_provider` (configuração da empresa) -> código do catálogo de integrações (M9-D236). */
const PROVIDER_CODES = Object.freeze({ sandbox: 'signature-sandbox', 'sandbox-alt': 'signature-alt-sandbox', clicksign: 'signature-clicksign', zapsign: 'signature-zapsign' });
const REAL = Object.freeze({ clicksign: 'legal.clicksign_api_token', zapsign: 'legal.zapsign_api_token' });

const findActive = (ctx, providerCode, environment, transaction) => IntegrationConnection.findOne({
  where: { companyId: ctx.companyId, providerCode, environment, status: 'ACTIVE' }, order: [['created_at', 'ASC']], transaction,
});

/** Fornecedor de laboratório: ganha a connection sozinho em ambiente que não é produção (a empresa que assinava pelo sandbox antes do registro segue funcionando). */
async function ensureSandbox(ctx, key, environment, transaction) {
  const providerCode = PROVIDER_CODES[key];
  const ativa = await findActive(ctx, providerCode, environment, transaction);
  if (ativa) return ativa;
  if (environment === 'PRODUCTION') {
    throw AppError.conflict('Assinatura simulada não é aceita em produção: cadastre e ative a integração de um fornecedor real em Integrações.', 'LEGAL_SANDBOX_WEBHOOK_FORBIDDEN_IN_PRODUCTION');
  }
  const existentes = await IntegrationConnection.findAll({ where: { companyId: ctx.companyId, providerCode, environment }, order: [['created_at', 'ASC']], transaction });
  if (existentes.some((c) => ['PAUSED', 'AUTH_FAILED'].includes(c.status))) {
    throw AppError.notFound('A integração de assinatura está parada: ative-a em Integrações.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  }
  const rascunho = existentes.find((c) => c.status === 'DRAFT');
  if (rascunho) return transitionConnection(rascunho.id, 'ACTIVE', ctx, transaction);
  const sufixo = existentes.length ? ` #${existentes.length + 1}-${crypto.randomBytes(3).toString('hex')}` : '';
  const criada = await registry.createConnection({ providerCode, environment, label: `Assinatura: ${providerCode} (${ctx.companyId.slice(0, 8)})${sufixo}` }, ctx, transaction);
  return transitionConnection(criada.id, 'ACTIVE', ctx, transaction);
}

/**
 * Fornecedor real configurado só nas configurações da empresa (token em tenant_settings): cria a connection, leva o token ao cofre (SecretStore) e tira o valor das configurações.
 * Sem token ou sem cofre configurado devolve null (o chamador cai para o sandbox, como sempre: a falta de configuração nunca quebra o pedido de assinatura).
 */
async function createRealFromSettings(ctx, key, environment, transaction) {
  const tokenKey = REAL[key];
  const token = await getDecryptedSetting(tokenKey, ctx, transaction, null);
  if (!token) return null;
  let store;
  try { store = getSecretStore(); } catch { return null; }
  const providerCode = PROVIDER_CODES[key];
  const secretRef = `company/${ctx.companyId}/signature/${providerCode}`;
  const clickEnv = key === 'clicksign' ? await getSetting('legal.clicksign_environment', ctx, transaction, 'production') : null;
  const configJson = key === 'clicksign' ? { baseUrl: clickEnv === 'sandbox' ? 'https://sandbox.clicksign.com/api/v3' : 'https://app.clicksign.com/api/v3' } : {};
  const criada = await registry.createConnection({ providerCode, environment, label: `Assinatura: ${providerCode} (${ctx.companyId.slice(0, 8)})`, secretRef, configJson }, ctx, transaction);
  await store.put(secretRef, token, {});
  await TenantSetting.destroy({ where: { companyId: ctx.companyId, key: tokenKey }, force: true, transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: null, action: 'legal.signature.credential_migrated_to_vault', entityType: 'IntegrationConnection', entityId: criada.id,
    beforeJson: { connectionId: null, origem: 'tenant_settings', setting: tokenKey, secretRef: null }, afterJson: { secretRef, providerCode }, reason: `A credencial de "${providerCode}" passou para o cofre de segredos e saiu das configurações da empresa.`,
  }, transaction);
  return transitionConnection(criada.id, 'ACTIVE', ctx, transaction);
}

/**
 * A connection de assinatura da empresa (M9-D236): a do fornecedor escolhido em `legal.signature_provider`. Fornecedor real sem connection ativa e sem credencial para criá-la
 * cai para o sandbox. Devolve a connection ACTIVE do ambiente do servidor.
 */
async function pickConnection(ctx, transaction) {
  const escolhido = await getSetting('legal.signature_provider', ctx, transaction, 'sandbox');
  const key = PROVIDER_CODES[escolhido] ? escolhido : 'sandbox';
  const environment = registry.getServerEnvironment();
  if (REAL[key]) {
    const ativa = await findActive(ctx, PROVIDER_CODES[key], environment, transaction);
    if (ativa) return ativa;
    const criada = await createRealFromSettings(ctx, key, environment, transaction);
    if (criada) return criada;
    return ensureSandbox(ctx, 'sandbox', environment, transaction);
  }
  return ensureSandbox(ctx, key, environment, transaction);
}

async function ensureSignatureConnection(ctx, transaction) {
  const connection = await pickConnection(ctx, transaction);
  ensureAdapterRegistered(connection.providerCode);
  return connection;
}

module.exports = { ensureSignatureConnection, PROVIDER_CODES, REAL };
