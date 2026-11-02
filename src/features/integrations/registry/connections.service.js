'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const { IntegrationProvider, IntegrationConnection } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { validar: validarSchema } = require('./jsonSchemaLite');
const { ENVIRONMENTS } = require('./registry.constants');
const { ctxOk, texto } = require('./registry.helpers');
const { conferirSemSegredo } = require('./registry.segredo');
const { serializeConnection, auditar, exigirMfaEmProducao } = require('./registry.auditoria');
const { validarSecretRefDaConexao } = require('../secrets/secretRefRules');
const { exigirMfaSegredoBank } = require('../secrets/secretPolicy');
const { validarRegrasIA, exigirSegredoParaAtivarIA } = require('./connections.aiRules');
const { validarEnderecosDaConfig } = require('./connections.urlRules');
const { validatePolicyJson } = require('../dispatch/retry/retry.limits');
const { generateChannelToken } = require('../webhooks/webhooks.channel');
const { CHANNEL_RE } = require('../webhooks/webhooks.resolve');

/** Conexões de cada empresa com cada fornecedor, por ambiente (`integration.connections`). */

async function carregarProvider(code, transaction) {
  const provider = await IntegrationProvider.findByPk(String(code || ''), { transaction });
  if (!provider) throw AppError.unprocessable('Fornecedor não cadastrado no catálogo de integrações.', 'INTEGRATION_PROVIDER_UNKNOWN');
  return provider;
}

function conferirConfigContraSchema(provider, configJson) {
  const problemas = validarSchema(provider.configSchema, configJson);
  if (problemas.length) {
    throw AppError.unprocessable(`A configuração não confere com o formato do fornecedor: ${problemas.slice(0, 5).join('; ')}.`, 'INTEGRATION_CONFIG_INVALID', { problemas });
  }
}

function conferirVersao(provider, apiVersion) {
  if (apiVersion && Array.isArray(provider.supportedVersions) && provider.supportedVersions.length && !provider.supportedVersions.includes(apiVersion)) {
    throw AppError.unprocessable(`Versão da API não suportada por este fornecedor. Use: ${provider.supportedVersions.join(', ')}.`, 'INTEGRATION_API_VERSION_UNSUPPORTED');
  }
}

async function rotuloEmUso(c, transaction) {
  return IntegrationConnection.findOne({
    where: { companyId: c.companyId, providerCode: c.providerCode, environment: c.environment, label: c.label, ...(c.id ? { id: { [Op.ne]: c.id } } : {}) },
    transaction,
  });
}

async function createConnection(payload, ctx, transaction, opts = {}) {
  ctxOk(ctx);
  const p = payload || {};
  if (!ENVIRONMENTS.includes(p.environment)) {
    throw AppError.badRequest(`Ambiente inválido. Use: ${ENVIRONMENTS.join(', ')}.`, 'VALIDATION_ERROR');
  }
  await conferirSemSegredo(p, ctx, transaction);
  await exigirMfaEmProducao(p.environment, ctx, transaction);
  const provider = await carregarProvider(p.providerCode, transaction);
  if (provider.status === 'DISABLED') {
    throw AppError.unprocessable('Este fornecedor está desativado no catálogo de integrações.', 'INTEGRATION_PROVIDER_DISABLED');
  }
  if (p.status !== undefined && p.status !== 'DRAFT') {
    throw AppError.conflict(`Transição de status inválida: (nova) -> ${p.status}.`, 'INTEGRATION_CONNECTION_INVALID_TRANSITION');
  }
  const label = texto(p.label, 'nome', 80, { obrigatorio: true });
  const configJson = p.configJson ?? {};
  const policyJson = p.policyJson ?? {};
  validatePolicyJson(policyJson);
  conferirConfigContraSchema(provider, configJson);
  validarRegrasIA(provider, configJson, null, ctx);
  await validarEnderecosDaConfig(provider, configJson, { ...ctx, environment: p.environment }, transaction); // M9-D245
  const apiVersion = texto(p.apiVersion, 'versão da API', 16);
  conferirVersao(provider, apiVersion);
  const secretRef = texto(p.secretRef, 'referência do cofre', 160);
  // M9-D211: o canal é um token opaco aleatório (24 a 48 caracteres); quem não informa recebe um gerado pelo servidor.
  const canalInformado = texto(p.webhookChannel, 'canal do webhook', 48);
  if (canalInformado && !CHANNEL_RE.test(canalInformado)) throw AppError.badRequest('O canal do webhook deve ter de 24 a 48 caracteres (letras, números, - e _).', 'VALIDATION_ERROR');
  const webhookChannel = canalInformado || await generateChannelToken(ctx, transaction);
  await validarSecretRefDaConexao({ secretRef, companyId: ctx.companyId, legacy: opts.legacySecretRef, ctx, transaction });
  if (secretRef) await exigirMfaSegredoBank(provider.domain, ctx, transaction);

  const novo = {
    groupId: ctx.groupId, companyId: ctx.companyId, providerCode: provider.code, environment: p.environment,
    label, status: 'DRAFT', secretRef, configJson, apiVersion, webhookChannel, policyJson,
    createdBy: ctx.userId || null, updatedBy: ctx.userId || null,
  };
  if (await rotuloEmUso(novo, transaction)) {
    throw AppError.conflict('Já existe uma integração deste fornecedor, neste ambiente, com este nome.', 'INTEGRATION_CONNECTION_DUPLICATE_LABEL');
  }
  let criada;
  try {
    criada = await IntegrationConnection.create(novo, { transaction });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw AppError.conflict('Já existe uma integração deste fornecedor, neste ambiente, com este nome ou canal de webhook.', 'INTEGRATION_CONNECTION_DUPLICATE_LABEL');
    }
    throw err;
  }
  await auditar(ctx, criada, null, serializeConnection(criada), `Integração "${criada.label}" (${criada.providerCode}, ${criada.environment}) criada.`, transaction);
  return criada;
}

async function carregarTravada(id, ctx, transaction) {
  ctxOk(ctx);
  const c = await IntegrationConnection.findOne({ where: { id: String(id), companyId: ctx.companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!c) throw AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  return c;
}

async function getConnection(id, ctx, transaction) {
  ctxOk(ctx);
  const c = await IntegrationConnection.findOne({ where: { id: String(id), companyId: ctx.companyId }, transaction });
  if (!c) throw AppError.notFound('Integração não encontrada.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  return c;
}

async function listConnections(ctx, filtro, transaction) {
  ctxOk(ctx);
  const where = { companyId: ctx.companyId };
  if (filtro?.environment) where.environment = filtro.environment;
  if (filtro?.status) where.status = filtro.status;
  if (filtro?.providerCode) where.providerCode = filtro.providerCode;
  if (filtro?.domain) {
    const providers = await IntegrationProvider.findAll({ where: { domain: filtro.domain }, attributes: ['code'], transaction });
    where.providerCode = filtro.providerCode ? { [Op.and]: [filtro.providerCode, { [Op.in]: providers.map((x) => x.code) }] } : { [Op.in]: providers.map((x) => x.code) };
  }
  return IntegrationConnection.findAll({ where, order: [['providerCode', 'ASC'], ['environment', 'ASC'], ['label', 'ASC']], transaction });
}

/** Campos que a edição altera de fato (ambiente, fornecedor e status só são conferidos: não mudam por aqui). */
const CAMPOS_EDITAVEIS = ['label', 'configJson', 'policyJson', 'apiVersion', 'secretRef', 'webhookChannel'];

async function updateConnection(id, patch, ctx, transaction, opts = {}) {
  const p = patch || {};
  if (!CAMPOS_EDITAVEIS.some((campo) => p[campo] !== undefined)) {
    throw AppError.badRequest('Informe ao menos um campo para alterar.', 'VALIDATION_ERROR');
  }
  const c = await carregarTravada(id, ctx, transaction);
  if (p.environment !== undefined && p.environment !== c.environment) {
    throw AppError.badRequest('O ambiente de uma integração não muda: crie outra.', 'VALIDATION_ERROR');
  }
  if (p.providerCode !== undefined && p.providerCode !== c.providerCode) {
    throw AppError.badRequest('O fornecedor de uma integração não muda: crie outra.', 'VALIDATION_ERROR');
  }
  if (p.status !== undefined && p.status !== c.status) {
    throw AppError.badRequest('O status muda pela ação de transição, não pela edição.', 'VALIDATION_ERROR');
  }
  await conferirSemSegredo(p, ctx, transaction);
  await exigirMfaEmProducao(c.environment, ctx, transaction);
  if (c.status === 'DISABLED') {
    throw AppError.conflict('Integração desativada não pode ser alterada: crie outra.', 'INTEGRATION_CONNECTION_INVALID_TRANSITION');
  }
  const antes = serializeConnection(c);
  const provider = await carregarProvider(c.providerCode, transaction);
  if (p.label !== undefined) c.label = texto(p.label, 'nome', 80, { obrigatorio: true });
  if (p.configJson !== undefined) {
    conferirConfigContraSchema(provider, p.configJson); validarRegrasIA(provider, p.configJson, c.configJson, ctx);
    await validarEnderecosDaConfig(provider, p.configJson, { ...ctx, environment: c.environment }, transaction); // M9-D245
    c.configJson = p.configJson;
  }
  if (p.policyJson !== undefined) { validatePolicyJson(p.policyJson); c.policyJson = p.policyJson; }
  if (p.apiVersion !== undefined) { const v = texto(p.apiVersion, 'versão da API', 16); conferirVersao(provider, v); c.apiVersion = v; }
  if (p.secretRef !== undefined) {
    const novoRef = texto(p.secretRef, 'referência do cofre', 160);
    if (novoRef !== c.secretRef) {
      await validarSecretRefDaConexao({ secretRef: novoRef, companyId: c.companyId, connectionId: c.id, legacy: opts.legacySecretRef, ctx, transaction });
      if (novoRef) await exigirMfaSegredoBank(provider.domain, ctx, transaction);
    }
    c.secretRef = novoRef;
  }
  if (p.webhookChannel !== undefined) {
    const canal = texto(p.webhookChannel, 'canal do webhook', 48);
    if (canal && !CHANNEL_RE.test(canal)) throw AppError.badRequest('O canal do webhook deve ter de 24 a 48 caracteres (letras, números, - e _).', 'VALIDATION_ERROR');
    c.webhookChannel = canal || await generateChannelToken(ctx, transaction); // vazio troca por um canal novo: a connection nunca fica sem canal
  }
  if (await rotuloEmUso(c, transaction)) {
    throw AppError.conflict('Já existe uma integração deste fornecedor, neste ambiente, com este nome.', 'INTEGRATION_CONNECTION_DUPLICATE_LABEL');
  }
  if (c.status === 'ACTIVE') exigirSegredoParaAtivarIA(provider, c);
  c.updatedBy = ctx.userId || null;
  try {
    await c.save({ transaction });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw AppError.conflict('Já existe uma integração deste fornecedor, neste ambiente, com este nome ou canal de webhook.', 'INTEGRATION_CONNECTION_DUPLICATE_LABEL');
    }
    throw err;
  }
  await auditar(ctx, c, antes, serializeConnection(c), `Integração "${c.label}" alterada.`, transaction);
  return c;
}

module.exports = { carregarTravada, createConnection, getConnection, listConnections, updateConnection };
