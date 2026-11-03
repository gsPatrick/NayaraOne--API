'use strict';

const { UniqueConstraintError } = require('sequelize');
const { ProviderAccount } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const ANTES_CRIACAO = 'Não existia (registro criado nesta ação)';

const CAMPOS_DE_SEGREDO = [
  'secret',
  'password',
  'token',
  'apikey',
  'api_key',
  'webhooksecret',
  'authorization',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'client_secret',
  'privatekey',
  'private_key',
];

function pareceSegredoEmbutido(valor) {
  const texto = String(valor || '');
  return /postgres(ql)?:\/\//i.test(texto)
    || /^bearer\s/i.test(texto)
    || /-----BEGIN /.test(texto)
    || /:\/\/[^/\s]*:[^@\s]*@/.test(texto) // endereço com usuário e senha
    || /^(sk|pk|rk)_(live|test)_/i.test(texto) // chaves de API com prefixo conhecido
    || /\bAKIA[0-9A-Z]{16}\b/.test(texto)
    || /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(texto); // token JWT
}

function validateText(valor, nome, max) {
  const texto = String(valor ?? '').trim();
  if (!texto) return null;
  if (texto.length > max) {
    throw AppError.badRequest(`O campo "${nome}" deve ter até ${max} caracteres.`, 'PROVIDER_ACCOUNT_VALIDATION');
  }
  return texto;
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
  const { listFinancingProviderCodes } = require('./adapters/resolveFinancingProviderAdapter');
  const knownProviders = listFinancingProviderCodes();
  if (!providerCode || !knownProviders.includes(String(providerCode).toLowerCase())) {
    throw AppError.badRequest(`Informe o provider da conta. Os disponíveis são: ${knownProviders.join(', ')}.`, 'PROVIDER_ACCOUNT_VALIDATION');
  }
  const cleanLabel = validateText(label, 'nome da conta', 120);
  if (!cleanLabel) {
    throw AppError.badRequest('Informe o nome da conta.', 'PROVIDER_ACCOUNT_VALIDATION');
  }
  const cleanSecretRef = validateText(secretRef, 'referência do cofre', 160);
  if (!cleanSecretRef) {
    throw AppError.badRequest('A referência do cofre é obrigatória.', 'PROVIDER_ACCOUNT_SECRET_REF_REQUIRED');
  }

  const enviado = payload || {};
  for (const campo of Object.keys(enviado)) {
    if (CAMPOS_DE_SEGREDO.includes(campo.toLowerCase()) && enviado[campo] !== undefined && enviado[campo] !== null && String(enviado[campo]) !== '') {
      throw AppError.unprocessable(
        'O segredo do provider não entra no banco. Informe só a referência do cofre em "secretRef".',
        'PROVIDER_ACCOUNT_SECRET_FORBIDDEN'
      );
    }
  }
  if (pareceSegredoEmbutido(cleanSecretRef)) {
    throw AppError.unprocessable(
      'A referência do cofre não pode ser o segredo, uma string de conexão ou um token.',
      'PROVIDER_ACCOUNT_SECRET_FORBIDDEN'
    );
  }

  const { Op, where: sqlWhere, fn, col } = require('sequelize');
  const sameName = await ProviderAccount.findOne({ where: { groupId, companyId, providerCode: String(providerCode).toLowerCase(), active: true, [Op.and]: [sqlWhere(fn('lower', col('label')), cleanLabel.toLowerCase())] }, transaction });
  if (sameName) {
    throw AppError.conflict('Já existe uma conta ativa deste provider com este nome. Edite a existente ou escolha outro nome.', 'PROVIDER_ACCOUNT_DUPLICATE');
  }
  let account;
  try {
    account = await ProviderAccount.create(
      {
        groupId,
        companyId,
        providerCode: String(providerCode).toLowerCase(),
        label: cleanLabel,
        secretRef: cleanSecretRef,
        createdBy: actorUserId || null,
      },
      { transaction }
    );
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw AppError.conflict('Já existe uma conta ativa deste provider com este nome. Edite a existente ou escolha outro nome.', 'PROVIDER_ACCOUNT_DUPLICATE');
    }
    throw err;
  }

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

/**
 * updateProviderAccount — troca o nome, rotaciona a referência do cofre ou ativa/desativa a conta. Nada é
 * apagado; a auditoria guarda o antes e o depois (referência do cofre, nunca segredo).
 */
async function updateProviderAccount(accountId, payload, actorUserId, groupId, companyId, transaction) {
  const account = await ProviderAccount.findOne({ where: { id: accountId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!account) {
    throw AppError.notFound('Conta do provider não encontrada.', 'PROVIDER_ACCOUNT_NOT_FOUND');
  }
  const enviado = payload || {};
  for (const campo of Object.keys(enviado)) {
    if (CAMPOS_DE_SEGREDO.includes(campo.toLowerCase()) && enviado[campo]) {
      throw AppError.unprocessable('O segredo do provider não entra no banco. Informe só a referência do cofre.', 'PROVIDER_ACCOUNT_SECRET_FORBIDDEN');
    }
  }
  const before = { label: account.label, secretRef: account.secretRef, active: account.active };
  if (enviado.label !== undefined) {
    const cleanLabel = validateText(enviado.label, 'nome da conta', 120);
    if (!cleanLabel) throw AppError.badRequest('Informe o nome da conta.', 'PROVIDER_ACCOUNT_VALIDATION');
    account.label = cleanLabel;
  }
  if (enviado.secretRef !== undefined) {
    const cleanRef = validateText(enviado.secretRef, 'referência do cofre', 160);
    if (!cleanRef) throw AppError.badRequest('A referência do cofre é obrigatória.', 'PROVIDER_ACCOUNT_SECRET_REF_REQUIRED');
    if (pareceSegredoEmbutido(cleanRef)) {
      throw AppError.unprocessable('A referência do cofre não pode ser o segredo, uma string de conexão ou um token.', 'PROVIDER_ACCOUNT_SECRET_FORBIDDEN');
    }
    account.secretRef = cleanRef;
  }
  if (enviado.active !== undefined) {
    if (typeof enviado.active !== 'boolean') throw AppError.badRequest('O campo "ativa" precisa ser verdadeiro ou falso.', 'PROVIDER_ACCOUNT_VALIDATION');
    account.active = enviado.active;
  }
  if (account.active) {
    const { Op, where: sqlWhere, fn, col } = require('sequelize');
    const sameName = await ProviderAccount.findOne({ where: { groupId, companyId, providerCode: account.providerCode, active: true, id: { [Op.ne]: account.id }, [Op.and]: [sqlWhere(fn('lower', col('label')), account.label.toLowerCase())] }, transaction });
    if (sameName) throw AppError.conflict('Já existe uma conta ativa deste provider com este nome.', 'PROVIDER_ACCOUNT_DUPLICATE');
  }
  await account.save({ transaction });
  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.provider_account.updated',
      entityType: 'ProviderAccount', entityId: account.id,
      beforeJson: before,
      afterJson: { label: account.label, secretRef: account.secretRef, active: account.active },
      reason: `Conta do provider "${account.providerCode}" atualizada${enviado.active === false ? ' e desativada' : ''}.`,
    },
    transaction
  );
  return account;
}

module.exports = { registerProviderAccount, listProviderAccounts, updateProviderAccount };
