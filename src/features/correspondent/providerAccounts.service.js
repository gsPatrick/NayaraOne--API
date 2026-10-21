'use strict';

const { ProviderAccount } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const ANTES_CRIACAO = 'Não existia (registro criado nesta ação)';

const CAMPOS_DE_SEGREDO = [
  'secret',
  'password',
  'token',
  'apiKey',
  'api_key',
  'webhookSecret',
  'authorization',
  'accessToken',
  'refreshToken',
];

function pareceSegredoEmbutido(valor) {
  const texto = String(valor || '');
  return /postgres:\/\//i.test(texto) || /^bearer\s/i.test(texto) || /-----BEGIN /.test(texto);
}

/**
 * Registra a conta do provider. O banco guarda só a referência do cofre (secretRef).
 * Caderno: "Secrets ficam em cofre/secret manager, nunca no código ou log."
 */
async function registerProviderAccount(payload, actorUserId, transaction) {
  const { groupId, companyId, providerCode, label, secretRef } = payload || {};
  if (!groupId || !companyId) {
    throw AppError.badRequest('Empresa do caso é obrigatória.', 'PROVIDER_ACCOUNT_VALIDATION');
  }
  if (!providerCode || String(providerCode).length > 32) {
    throw AppError.badRequest('"providerCode" é obrigatório.', 'PROVIDER_ACCOUNT_VALIDATION');
  }
  if (!label || String(label).trim() === '') {
    throw AppError.badRequest('"label" é obrigatório.', 'PROVIDER_ACCOUNT_VALIDATION');
  }
  if (!secretRef || String(secretRef).trim() === '') {
    throw AppError.badRequest('"secretRef" é a referência do cofre e é obrigatória.', 'PROVIDER_ACCOUNT_SECRET_REF_REQUIRED');
  }

  const enviado = payload || {};
  for (const campo of CAMPOS_DE_SEGREDO) {
    if (enviado[campo] !== undefined && enviado[campo] !== null && String(enviado[campo]) !== '') {
      throw AppError.unprocessable(
        'O segredo do provider não entra no banco. Informe só a referência do cofre em "secretRef".',
        'PROVIDER_ACCOUNT_SECRET_FORBIDDEN'
      );
    }
  }
  if (pareceSegredoEmbutido(secretRef)) {
    throw AppError.unprocessable(
      'A referência do cofre não pode ser o segredo, uma string de conexão ou um token.',
      'PROVIDER_ACCOUNT_SECRET_FORBIDDEN'
    );
  }

  const account = await ProviderAccount.create(
    {
      groupId,
      companyId,
      providerCode: String(providerCode),
      label: String(label).trim(),
      secretRef: String(secretRef).trim(),
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.provider_account.created',
      entityType: 'ProviderAccount',
      entityId: account.id,
      beforeJson: { registro: ANTES_CRIACAO },
      afterJson: {
        id: account.id,
        providerCode: account.providerCode,
        label: account.label,
        secretRef: account.secretRef,
      },
      reason: `Conta do provider "${account.providerCode}" registrada com referência de cofre.`,
    },
    transaction
  );

  return account;
}

async function listProviderAccounts(groupId, companyId, transaction) {
  return ProviderAccount.findAll({
    where: { groupId, companyId },
    order: [['created_at', 'DESC']],
    transaction,
  });
}

module.exports = { registerProviderAccount, listProviderAccounts };
