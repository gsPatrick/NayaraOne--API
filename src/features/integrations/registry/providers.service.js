'use strict';

const { IntegrationProvider } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { acharSegredo } = require('./secretScan');
const { CRITICALITIES, PROVIDER_STATUSES, ANTES_CRIACAO, CODE_RE } = require('./registry.constants');
const { ctxOk, texto, comPlataforma } = require('./registry.helpers');
const { recusarSegredo } = require('./registry.segredo');
const { assertDomain, assertCapabilitiesForDomain } = require('../providers/catalog.validate');
const { validatePolicyJson } = require('../dispatch/retry/retry.limits');

/** Catálogo global de fornecedores (`integration.providers`, M9-D200). */

function validarProvider(p, { parcial = false } = {}) {
  const saida = {};
  if (!parcial || p.displayName !== undefined) saida.displayName = texto(p.displayName, 'nome', 120, { obrigatorio: true });
  if (!parcial || p.domain !== undefined) {
    assertDomain(p.domain);
    saida.domain = p.domain;
  }
  if (!parcial || p.criticality !== undefined) {
    if (!CRITICALITIES.includes(p.criticality)) throw AppError.badRequest(`Criticidade inválida. Use: ${CRITICALITIES.join(', ')}.`, 'VALIDATION_ERROR');
    saida.criticality = p.criticality;
  }
  if (p.status !== undefined) {
    if (!PROVIDER_STATUSES.includes(p.status)) throw AppError.badRequest(`Status inválido. Use: ${PROVIDER_STATUSES.join(', ')}.`, 'VALIDATION_ERROR');
    saida.status = p.status;
  }
  for (const campo of ['capabilities', 'supportedVersions']) {
    if (!parcial || p[campo] !== undefined) {
      if (!Array.isArray(p[campo]) || p[campo].some((x) => typeof x !== 'string' || !x.trim())) {
        throw AppError.badRequest(`O campo "${campo}" deve ser uma lista de textos.`, 'VALIDATION_ERROR');
      }
      saida[campo] = p[campo];
    }
  }
  for (const campo of ['defaultPolicyJson', 'configSchema']) {
    if (p[campo] !== undefined) {
      if (p[campo] === null || typeof p[campo] !== 'object' || Array.isArray(p[campo])) {
        throw AppError.badRequest(`O campo "${campo}" deve ser um objeto.`, 'VALIDATION_ERROR');
      }
      if (campo === 'defaultPolicyJson' && acharSegredo(p[campo])) throw recusarSegredo();
      if (campo === 'defaultPolicyJson') validatePolicyJson(p[campo]);
      saida[campo] = p[campo];
    }
  }
  if (!parcial || p.sandboxAvailable !== undefined) {
    if (typeof p.sandboxAvailable !== 'boolean') throw AppError.badRequest('O campo "sandboxAvailable" deve ser verdadeiro ou falso.', 'VALIDATION_ERROR');
    saida.sandboxAvailable = p.sandboxAvailable;
  }
  return saida;
}

async function listProviders(filtro, transaction) {
  const where = {};
  if (filtro?.domain) where.domain = filtro.domain;
  if (filtro?.status) where.status = filtro.status;
  return IntegrationProvider.findAll({ where, order: [['domain', 'ASC'], ['code', 'ASC']], transaction });
}

async function createProvider(payload, ctx, transaction) {
  ctxOk(ctx);
  const code = String(payload?.code || '').trim();
  if (!CODE_RE.test(code)) {
    throw AppError.badRequest('O código do fornecedor usa só letras minúsculas, números, "-" e "_" (até 48).', 'VALIDATION_ERROR');
  }
  const dados = validarProvider({ status: 'ACTIVE', defaultPolicyJson: {}, configSchema: {}, ...payload });
  assertCapabilitiesForDomain(dados.domain, dados.capabilities);
  if (await IntegrationProvider.findByPk(code, { transaction })) {
    throw AppError.conflict('Já existe um fornecedor com este código.', 'INTEGRATION_PROVIDER_DUPLICATE');
  }
  await comPlataforma(transaction);
  const criado = await IntegrationProvider.create({ code, ...dados }, { transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'integration.provider.changed', entityType: 'IntegrationProvider', entityId: null,
    beforeJson: { registro: ANTES_CRIACAO }, afterJson: criado.toJSON(), reason: `Fornecedor "${code}" cadastrado no catálogo de integrações.`,
  }, transaction);
  return criado;
}

async function updateProvider(code, payload, ctx, transaction) {
  ctxOk(ctx);
  // A marca de plataforma vem ANTES da leitura com lock: SELECT ... FOR UPDATE exige a política de UPDATE e, sem a marca, a linha ficava invisível (422).
  await comPlataforma(transaction);
  const provider = await IntegrationProvider.findByPk(code, { transaction, lock: transaction.LOCK.UPDATE });
  if (!provider) throw AppError.unprocessable('Fornecedor não cadastrado no catálogo de integrações.', 'INTEGRATION_PROVIDER_UNKNOWN');
  const antes = provider.toJSON();
  const mudancas = validarProvider(payload || {}, { parcial: true });
  if (mudancas.domain !== undefined || mudancas.capabilities !== undefined) {
    assertCapabilitiesForDomain(mudancas.domain ?? provider.domain, mudancas.capabilities ?? provider.capabilities);
  }
  Object.assign(provider, mudancas);
  await provider.save({ transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'integration.provider.changed', entityType: 'IntegrationProvider', entityId: null,
    beforeJson: antes, afterJson: provider.toJSON(), reason: `Fornecedor "${code}" alterado no catálogo de integrações.`,
  }, transaction);
  return provider;
}

module.exports = { listProviders, createProvider, updateProvider };
