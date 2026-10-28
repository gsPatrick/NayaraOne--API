'use strict';

const { Op, UniqueConstraintError } = require('sequelize');
const { sequelize, IntegrationProvider, IntegrationConnection } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getSetting } = require('../../settings/settings.service');
const { acharSegredo, chaveParecidaComSegredo, textoParecidoComSegredoEmbutido, TAMANHO_MINIMO_PADRAO } = require('./secretScan');
const { validar: validarSchema } = require('./jsonSchemaLite');

/**
 * Registro de integração (Marco 9, M9-D200): `integration.providers` diz QUAIS fornecedores
 * existem; `integration.connections` diz COMO cada empresa liga cada um em cada ambiente.
 * Nenhum segredo entra aqui: só `secret_ref`, a referência opaca do cofre (M9-D202).
 */

const DOMAINS = ['MESSAGING', 'EMAIL', 'SITE', 'PORTAL', 'SIGNATURE', 'BANK', 'INSURANCE', 'FINANCING', 'FISCAL', 'SOCIAL', 'STORAGE', 'IDENTITY', 'AI', 'ANALYTICS'];
const CRITICALITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const PROVIDER_STATUSES = ['ACTIVE', 'DEPRECATED', 'DISABLED'];
const ENVIRONMENTS = ['SANDBOX', 'HOMOLOG', 'PRODUCTION'];
const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'AUTH_FAILED', 'DISABLED'];

// Transições do livro (D200 3.2 f). `DISABLED` é final.
const TRANSITIONS = {
  DRAFT: ['ACTIVE', 'DISABLED'],
  ACTIVE: ['PAUSED', 'AUTH_FAILED', 'DISABLED'],
  PAUSED: ['ACTIVE', 'DISABLED'],
  AUTH_FAILED: ['ACTIVE', 'DISABLED'],
  DISABLED: [],
};

const ANTES_CRIACAO = 'Não existia (registro criado nesta ação)';
const CODE_RE = /^[a-z0-9_-]{1,48}$/;
const CAMPOS_CONEXAO_EDITAVEIS = ['label', 'configJson', 'policyJson', 'apiVersion', 'secretRef', 'webhookChannel'];

function ctxOk(ctx) {
  if (!ctx || !ctx.groupId || !ctx.companyId) {
    throw AppError.badRequest('Contexto da empresa é obrigatório.', 'VALIDATION_ERROR');
  }
}

/** O ambiente vem da configuração do servidor, nunca do pedido do usuário (D200 3.3). */
function getServerEnvironment() {
  const explicito = process.env.INTEGRATION_ENVIRONMENT;
  if (explicito) {
    const valor = String(explicito).trim().toUpperCase();
    if (!ENVIRONMENTS.includes(valor)) {
      throw AppError.internal(`INTEGRATION_ENVIRONMENT inválido no servidor. Use: ${ENVIRONMENTS.join(', ')}.`, 'INTEGRATION_ENVIRONMENT_INVALID');
    }
    return valor;
  }
  if (process.env.DEPLOY_ENVIRONMENT === 'staging') return 'HOMOLOG';
  if (process.env.DEPLOY_ENVIRONMENT === 'production' || process.env.NODE_ENV === 'production') return 'PRODUCTION';
  return 'SANDBOX';
}

async function tamanhoMinimoDeSegredo(ctx, transaction) {
  const valor = await getSetting('integration.registry.secret_scan_min_length', ctx, transaction, TAMANHO_MINIMO_PADRAO);
  return Number.isInteger(valor) ? valor : TAMANHO_MINIMO_PADRAO;
}

function recusarSegredo() {
  return AppError.unprocessable(
    'O segredo não entra na configuração. Informe somente a referência do cofre em "secretRef".',
    'INTEGRATION_SECRET_IN_CONFIG'
  );
}

async function conferirSemSegredo(payload, ctx, transaction) {
  const tamanhoMinimo = await tamanhoMinimoDeSegredo(ctx, transaction);
  for (const campo of ['configJson', 'policyJson']) {
    if (payload[campo] === undefined) continue;
    if (payload[campo] === null || typeof payload[campo] !== 'object' || Array.isArray(payload[campo])) {
      throw AppError.badRequest(`O campo "${campo}" deve ser um objeto.`, 'VALIDATION_ERROR');
    }
    if (acharSegredo(payload[campo], { tamanhoMinimo })) throw recusarSegredo();
  }
  // Campo de segredo solto no corpo (apiKey, token...), fora dos campos conhecidos.
  for (const [chave, valor] of Object.entries(payload)) {
    if (CAMPOS_CONEXAO_EDITAVEIS.includes(chave) || chave === 'providerCode' || chave === 'environment' || chave === 'status') continue;
    if (chaveParecidaComSegredo(chave) && valor !== undefined && valor !== null && String(valor) !== '') throw recusarSegredo();
  }
  if (payload.secretRef !== undefined && payload.secretRef !== null && textoParecidoComSegredoEmbutido(payload.secretRef)) throw recusarSegredo();
}

function texto(valor, nome, max, { obrigatorio = false } = {}) {
  const t = String(valor ?? '').trim();
  if (!t) {
    if (obrigatorio) throw AppError.badRequest(`Informe o campo "${nome}".`, 'VALIDATION_ERROR');
    return null;
  }
  if (t.length > max) throw AppError.badRequest(`O campo "${nome}" deve ter até ${max} caracteres.`, 'VALIDATION_ERROR');
  return t;
}

/** Visão da connection sem nenhum campo secreto (nem a referência do cofre). */
function serializeConnection(c) {
  return {
    id: c.id,
    groupId: c.groupId,
    companyId: c.companyId,
    providerCode: c.providerCode,
    environment: c.environment,
    label: c.label,
    status: c.status,
    secretRefConfigured: Boolean(c.secretRef),
    configJson: c.configJson,
    apiVersion: c.apiVersion,
    webhookChannelConfigured: Boolean(c.webhookChannel),
    policyJson: c.policyJson,
    productionReleasedAt: c.productionReleasedAt,
    productionReleasedBy: c.productionReleasedBy,
    lastSecretRotationAt: c.lastSecretRotationAt,
    secretExpiresAt: c.secretExpiresAt,
    createdBy: c.createdBy,
    updatedBy: c.updatedBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function auditar(ctx, c, antes, depois, motivo, transaction) {
  await registrarAuditoria(
    {
      groupId: ctx.groupId,
      companyId: ctx.companyId,
      actorUserId: ctx.userId || null,
      action: 'integration.connection.changed',
      entityType: 'IntegrationConnection',
      entityId: c.id,
      beforeJson: antes || { registro: ANTES_CRIACAO },
      afterJson: depois,
      reason: motivo,
    },
    transaction
  );
}

/** MFA recente para mudar conexão de PRODUÇÃO (INT-P091 e regra do projeto); configurável. */
async function exigirMfaEmProducao(environment, ctx, transaction, { system = false } = {}) {
  if (environment !== 'PRODUCTION' || system) return;
  const exige = await getSetting('integration.admin.mfa_on_prod_connection_change', ctx, transaction, true);
  if (exige === false) return;
  const { assertRecentMfa } = require('../../users/mfa.service');
  await assertRecentMfa(ctx.userId, transaction);
}

// ------------------------------------------------------------------ providers (catálogo global)

async function comPlataforma(transaction) {
  await sequelize.query("SET LOCAL app.integration_platform_admin = 'on'", { transaction });
}

function validarProvider(p, { parcial = false } = {}) {
  const saida = {};
  if (!parcial || p.displayName !== undefined) saida.displayName = texto(p.displayName, 'nome', 120, { obrigatorio: true });
  if (!parcial || p.domain !== undefined) {
    if (!DOMAINS.includes(p.domain)) throw AppError.badRequest(`Domínio inválido. Use: ${DOMAINS.join(', ')}.`, 'VALIDATION_ERROR');
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
  const provider = await IntegrationProvider.findByPk(code, { transaction, lock: transaction.LOCK.UPDATE });
  if (!provider) throw AppError.unprocessable('Fornecedor não cadastrado no catálogo de integrações.', 'INTEGRATION_PROVIDER_UNKNOWN');
  const antes = provider.toJSON();
  Object.assign(provider, validarProvider(payload || {}, { parcial: true }));
  await comPlataforma(transaction);
  await provider.save({ transaction });
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId,
    action: 'integration.provider.changed', entityType: 'IntegrationProvider', entityId: null,
    beforeJson: antes, afterJson: provider.toJSON(), reason: `Fornecedor "${code}" alterado no catálogo de integrações.`,
  }, transaction);
  return provider;
}

// ------------------------------------------------------------------ connections

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

async function createConnection(payload, ctx, transaction) {
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
  conferirConfigContraSchema(provider, configJson);
  const apiVersion = texto(p.apiVersion, 'versão da API', 16);
  conferirVersao(provider, apiVersion);
  const secretRef = texto(p.secretRef, 'referência do cofre', 160);
  const webhookChannel = texto(p.webhookChannel, 'canal do webhook', 48);

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

async function updateConnection(id, patch, ctx, transaction) {
  const c = await carregarTravada(id, ctx, transaction);
  const p = patch || {};
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
  if (p.configJson !== undefined) { conferirConfigContraSchema(provider, p.configJson); c.configJson = p.configJson; }
  if (p.policyJson !== undefined) c.policyJson = p.policyJson;
  if (p.apiVersion !== undefined) { const v = texto(p.apiVersion, 'versão da API', 16); conferirVersao(provider, v); c.apiVersion = v; }
  if (p.secretRef !== undefined) c.secretRef = texto(p.secretRef, 'referência do cofre', 160);
  if (p.webhookChannel !== undefined) c.webhookChannel = texto(p.webhookChannel, 'canal do webhook', 48);
  if (await rotuloEmUso(c, transaction)) {
    throw AppError.conflict('Já existe uma integração deste fornecedor, neste ambiente, com este nome.', 'INTEGRATION_CONNECTION_DUPLICATE_LABEL');
  }
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

/**
 * Muda o status. `opts.system` = ação do sistema (só ela leva ACTIVE -> AUTH_FAILED);
 * `opts.testConnectionOk` = test-connection verde (só ele leva AUTH_FAILED -> ACTIVE, D250).
 */
async function transitionConnection(id, toStatus, ctx, transaction, opts = {}) {
  const c = await carregarTravada(id, ctx, transaction);
  const de = c.status;
  const invalida = () => AppError.conflict(`Transição de status inválida: ${de} -> ${toStatus}.`, 'INTEGRATION_CONNECTION_INVALID_TRANSITION');
  if (!STATUSES.includes(toStatus) || !(TRANSITIONS[de] || []).includes(toStatus)) throw invalida();
  if (toStatus === 'AUTH_FAILED' && !opts.system) throw invalida();
  if (de === 'AUTH_FAILED' && toStatus === 'ACTIVE' && !opts.testConnectionOk) throw invalida();
  await exigirMfaEmProducao(c.environment, ctx, transaction, { system: Boolean(opts.system) });

  if (toStatus === 'ACTIVE') {
    if (c.environment === 'PRODUCTION' && !c.productionReleasedAt) {
      throw AppError.conflict('Esta integração ainda não foi liberada para produção.', 'INTEGRATION_PRODUCTION_NOT_RELEASED');
    }
    const outra = await IntegrationConnection.findOne({
      where: { companyId: c.companyId, providerCode: c.providerCode, environment: c.environment, status: 'ACTIVE', id: { [Op.ne]: c.id } },
      transaction,
    });
    if (outra) throw AppError.conflict('Já existe uma integração ativa deste fornecedor neste ambiente.', 'INTEGRATION_CONNECTION_DUPLICATE_ACTIVE');
  }
  const antes = serializeConnection(c);
  c.status = toStatus;
  c.updatedBy = ctx.userId || null;
  try {
    await c.save({ transaction });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw AppError.conflict('Já existe uma integração ativa deste fornecedor neste ambiente.', 'INTEGRATION_CONNECTION_DUPLICATE_ACTIVE');
    }
    throw err;
  }
  await auditar(ctx, c, antes, serializeConnection(c), `Integração "${c.label}": status ${de} -> ${toStatus}.`, transaction);
  return c;
}

/**
 * Devolve a connection ACTIVE da empresa para o fornecedor ou domínio. O ambiente é o do servidor:
 * qualquer `environment` vindo do pedido é ignorado.
 */
async function resolveConnection({ companyId, providerCode, domain }, transaction) {
  if (!companyId || (!providerCode && !domain)) {
    throw AppError.badRequest('Informe a empresa e o fornecedor ou o domínio.', 'VALIDATION_ERROR');
  }
  const environment = getServerEnvironment();
  const where = { companyId, environment, status: 'ACTIVE' };
  if (providerCode) where.providerCode = String(providerCode);
  else {
    const providers = await IntegrationProvider.findAll({ where: { domain: String(domain) }, attributes: ['code'], transaction });
    where.providerCode = { [Op.in]: providers.map((x) => x.code) };
  }
  const candidatas = await IntegrationConnection.findAll({ where, order: [['created_at', 'ASC'], ['id', 'ASC']], transaction });
  if (candidatas.length === 0) {
    throw AppError.notFound('Nenhuma integração ativa para este recurso: configure em Integrações.', 'INTEGRATION_CONNECTION_NOT_FOUND');
  }
  if (candidatas.length > 1 && !providerCode) {
    const regra = await getSetting('integration.registry.domain_resolution', { companyId }, transaction, 'error_if_multiple');
    if (regra === 'oldest_active') return candidatas[0];
    if (regra === 'newest_active') return candidatas[candidatas.length - 1];
    throw AppError.conflict('Há mais de uma integração ativa neste domínio: informe o fornecedor ou ajuste a regra de escolha em Configurações.', 'INTEGRATION_CONNECTION_AMBIGUOUS');
  }
  return candidatas[0];
}

/**
 * Copia correspondent.provider_accounts da empresa atual para connections (domínio FINANCING),
 * de forma idempotente (o id da conta é o id da connection). A conta ativa mais antiga de cada
 * fornecedor fica ACTIVE; as demais ativas ficam PAUSED; inativas ficam DISABLED. O livro não
 * traz ambiente para a conta legada: SANDBOX (DI-007).
 */
const COPIA_LEGADO_SQL = `
INSERT INTO "integration"."connections"
  (id, group_id, company_id, provider_code, environment, label, status, secret_ref, config_json, policy_json, created_by, updated_by, created_at, updated_at)
SELECT s.id, s.group_id, s.company_id, lower(s.provider_code), 'SANDBOX',
       CASE WHEN s.rn = 1 THEN s.label ELSE left(s.label, 74) || ' (' || s.rn || ')' END,
       CASE WHEN NOT s.active THEN 'DISABLED'
            WHEN s.ordem_ativa = 1 AND NOT EXISTS (
              SELECT 1 FROM "integration"."connections" x
               WHERE x.company_id = s.company_id AND x.provider_code = lower(s.provider_code)
                 AND x.environment = 'SANDBOX' AND x.status = 'ACTIVE') THEN 'ACTIVE'
            ELSE 'PAUSED' END,
       s.secret_ref, '{}'::jsonb, '{}'::jsonb, s.created_by, s.created_by, s.created_at, s.updated_at
FROM (
  SELECT a.*,
         row_number() OVER (PARTITION BY a.company_id, lower(a.provider_code), lower(a.label) ORDER BY a.active DESC, a.created_at, a.id) AS rn,
         CASE WHEN a.active THEN row_number() OVER (PARTITION BY a.company_id, lower(a.provider_code), a.active ORDER BY a.created_at, a.id) END AS ordem_ativa
  FROM "correspondent"."provider_accounts" a
  WHERE a.company_id = :companyId AND lower(a.provider_code) ~ '^[a-z0-9_-]{1,48}$'
    AND EXISTS (SELECT 1 FROM "integration"."providers" p WHERE p.code = lower(a.provider_code))
) s
ON CONFLICT DO NOTHING
RETURNING id;
`;

async function migrateLegacyProviderAccounts(ctx, transaction) {
  ctxOk(ctx);
  const [rows] = await sequelize.query(COPIA_LEGADO_SQL, { replacements: { companyId: ctx.companyId }, transaction });
  for (const { id } of rows) {
    const c = await IntegrationConnection.findByPk(id, { transaction });
    await auditar(ctx, c, null, serializeConnection(c), `Conta de provider legada migrada para a integração "${c.label}".`, transaction);
  }
  return { inserted: rows.length };
}

module.exports = {
  DOMAINS, CRITICALITIES, PROVIDER_STATUSES, ENVIRONMENTS, STATUSES, TRANSITIONS,
  getServerEnvironment, serializeConnection,
  listProviders, createProvider, updateProvider,
  createConnection, getConnection, listConnections, updateConnection, transitionConnection,
  resolveConnection, migrateLegacyProviderAccounts,
};
