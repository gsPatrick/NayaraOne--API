'use strict';

const { IntegrationConnection } = require('../../models');
const registry = require('../integrations/registry/registry.service');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const ANTES_CRIACAO = 'Não existia (registro criado nesta ação)';

// Marco 9, M9-D200: a conta do provider do Correspondente vive em integration.connections
// (domínio FINANCING). correspondent.provider_accounts é legado somente leitura. A resposta
// mantém o formato antigo da conta (id, providerCode, label, secretRef, active).
function paraConta(c) {
  return {
    id: c.id,
    groupId: c.groupId,
    companyId: c.companyId,
    providerCode: c.providerCode,
    label: c.label,
    secretRef: c.secretRef,
    active: c.status === 'ACTIVE',
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function ctxDe(groupId, companyId, userId) {
  return { groupId, companyId, userId: userId || null };
}

async function nomeEmUso(companyId, providerCode, label, exceptId, transaction) {
  const { Op, where: sqlWhere, fn, col } = require('sequelize');
  return IntegrationConnection.findOne({
    where: {
      companyId, providerCode, status: { [Op.ne]: 'DISABLED' },
      ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}),
      [Op.and]: [sqlWhere(fn('lower', col('label')), label.toLowerCase())],
    },
    transaction,
  });
}

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

  const code = String(providerCode).toLowerCase();
  if (await nomeEmUso(companyId, code, cleanLabel, null, transaction)) {
    throw AppError.conflict('Já existe uma conta ativa deste provider com este nome. Edite a existente ou escolha outro nome.', 'PROVIDER_ACCOUNT_DUPLICATE');
  }
  const ctx = ctxDe(groupId, companyId, actorUserId);
  let connection;
  try {
    connection = await registry.createConnection(
      { providerCode: code, environment: registry.getServerEnvironment(), label: cleanLabel, secretRef: cleanSecretRef },
      ctx,
      transaction
    );
  } catch (err) {
    if (err.code === 'INTEGRATION_CONNECTION_DUPLICATE_LABEL') {
      throw AppError.conflict('Já existe uma conta ativa deste provider com este nome. Edite a existente ou escolha outro nome.', 'PROVIDER_ACCOUNT_DUPLICATE');
    }
    if (err.code === 'INTEGRATION_SECRET_IN_CONFIG') {
      throw AppError.unprocessable('A referência do cofre não pode ser o segredo, uma string de conexão ou um token.', 'PROVIDER_ACCOUNT_SECRET_FORBIDDEN');
    }
    throw err;
  }
  // Conta nova nasce ativa quando pode: sem outra ativa do mesmo provider/ambiente e, em produção, já liberada.
  try {
    connection = await registry.transitionConnection(connection.id, 'ACTIVE', ctx, transaction);
  } catch (err) {
    if (!['INTEGRATION_CONNECTION_DUPLICATE_ACTIVE', 'INTEGRATION_PRODUCTION_NOT_RELEASED'].includes(err.code)) throw err;
  }
  const account = paraConta(connection);

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
  const connections = await registry.listConnections(ctxDe(groupId, companyId), { domain: 'FINANCING' }, transaction);
  return connections
    .map(paraConta)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * updateProviderAccount — troca o nome, rotaciona a referência do cofre ou ativa/desativa a conta. Nada é
 * apagado; a auditoria guarda o antes e o depois (referência do cofre, nunca segredo).
 */
async function updateProviderAccount(accountId, payload, actorUserId, groupId, companyId, transaction) {
  const ctx = ctxDe(groupId, companyId, actorUserId);
  let atual;
  try {
    atual = await registry.getConnection(accountId, ctx, transaction);
  } catch (err) {
    if (err.code === 'INTEGRATION_CONNECTION_NOT_FOUND') throw AppError.notFound('Conta do provider não encontrada.', 'PROVIDER_ACCOUNT_NOT_FOUND');
    throw err;
  }
  const enviado = payload || {};
  for (const campo of Object.keys(enviado)) {
    if (CAMPOS_DE_SEGREDO.includes(campo.toLowerCase()) && enviado[campo]) {
      throw AppError.unprocessable('O segredo do provider não entra no banco. Informe só a referência do cofre.', 'PROVIDER_ACCOUNT_SECRET_FORBIDDEN');
    }
  }
  const before = { label: atual.label, secretRef: atual.secretRef, active: atual.status === 'ACTIVE' };
  const patch = {};
  if (enviado.label !== undefined) {
    const cleanLabel = validateText(enviado.label, 'nome da conta', 120);
    if (!cleanLabel) throw AppError.badRequest('Informe o nome da conta.', 'PROVIDER_ACCOUNT_VALIDATION');
    patch.label = cleanLabel;
  }
  if (enviado.secretRef !== undefined) {
    const cleanRef = validateText(enviado.secretRef, 'referência do cofre', 160);
    if (!cleanRef) throw AppError.badRequest('A referência do cofre é obrigatória.', 'PROVIDER_ACCOUNT_SECRET_REF_REQUIRED');
    if (pareceSegredoEmbutido(cleanRef)) {
      throw AppError.unprocessable('A referência do cofre não pode ser o segredo, uma string de conexão ou um token.', 'PROVIDER_ACCOUNT_SECRET_FORBIDDEN');
    }
    patch.secretRef = cleanRef;
  }
  if (enviado.active !== undefined && typeof enviado.active !== 'boolean') {
    throw AppError.badRequest('O campo "ativa" precisa ser verdadeiro ou falso.', 'PROVIDER_ACCOUNT_VALIDATION');
  }
  if (patch.label && patch.label.toLowerCase() !== atual.label.toLowerCase() && await nomeEmUso(companyId, atual.providerCode, patch.label, atual.id, transaction)) {
    throw AppError.conflict('Já existe uma conta ativa deste provider com este nome.', 'PROVIDER_ACCOUNT_DUPLICATE');
  }
  let connection = atual;
  try {
    if (Object.keys(patch).length) connection = await registry.updateConnection(atual.id, patch, ctx, transaction);
    if (enviado.active === false && connection.status === 'ACTIVE') {
      connection = await registry.transitionConnection(connection.id, 'PAUSED', ctx, transaction);
    } else if (enviado.active === true && connection.status !== 'ACTIVE') {
      connection = await registry.transitionConnection(connection.id, 'ACTIVE', ctx, transaction);
    }
  } catch (err) {
    if (err.code === 'INTEGRATION_CONNECTION_DUPLICATE_LABEL') throw AppError.conflict('Já existe uma conta ativa deste provider com este nome.', 'PROVIDER_ACCOUNT_DUPLICATE');
    if (err.code === 'INTEGRATION_CONNECTION_DUPLICATE_ACTIVE') throw AppError.conflict('Já existe outra conta ativa deste provider neste ambiente. Desative-a antes.', 'PROVIDER_ACCOUNT_DUPLICATE');
    if (err.code === 'INTEGRATION_SECRET_IN_CONFIG') throw AppError.unprocessable('A referência do cofre não pode ser o segredo, uma string de conexão ou um token.', 'PROVIDER_ACCOUNT_SECRET_FORBIDDEN');
    throw err;
  }
  const account = paraConta(connection);
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
