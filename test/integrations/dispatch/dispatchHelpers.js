'use strict';

// Apoio dos testes dos envios (M9-D205): contexto de empresa com COMMIT, conexões de teste e criação de envios.
const { sequelize, getSeedTenant, uniqueSuffix } = require('../../testHelpers');
const { Group, Company, IntegrationProvider } = require('../../../src/models');
const registry = require('../../../src/features/integrations/registry/registry.service');
const settingsService = require('../../../src/features/settings/settings.service');
const dispatch = require('../../../src/features/integrations/dispatch');

async function comTenant(t0, fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: t0.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: t0.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: t0.userId }, transaction: t });
    const out = await fn(t);
    await t.commit();
    return out;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function carregarTenants() {
  const tenant = await getSeedTenant();
  const grupoB = await Group.findOne({ where: { name: 'CI — Grupo Fictício B' } });
  let outro = null;
  if (grupoB) {
    const empresaB = await sequelize.transaction(async (t) => {
      await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: grupoB.id }, transaction: t });
      return Company.findOne({ where: { groupId: grupoB.id, name: 'CI — Empresa Fictícia B' }, transaction: t });
    });
    if (empresaB) outro = { groupId: grupoB.id, companyId: empresaB.id, userId: tenant.userId };
  }
  return { tenant, outro };
}

const ctxDe = (t, extra = {}) => ({ groupId: t.groupId, companyId: t.companyId, userId: t.userId, ...extra });

/** Conexão de teste de um domínio (sandbox). */
async function conexao(tenant, domain = 'BANK') {
  const provider = await IntegrationProvider.findOne({ where: { domain, status: 'ACTIVE', sandboxAvailable: true } });
  return comTenant(tenant, (t) => registry.createConnection({ providerCode: provider.code, environment: 'SANDBOX', label: `QA-M9 ${uniqueSuffix()}` }, ctxDe(tenant), t));
}

const config = (tenant, chave, valor) => comTenant(tenant, (t) => settingsService.upsertSetting(chave, valor, tenant, tenant.userId, t, { platform: true })); // fixture de plataforma: grava também as chaves só da plataforma

/** Cria um envio (commit). */
function criar(tenant, connectionId, key, extra = {}) {
  return comTenant(tenant, (t) => dispatch.createDispatch(ctxDe(tenant), {
    connectionId, operation: extra.operation || 'submitPayment', idempotencyKey: key, snapshot: extra.snapshot || { valor: '100.00', favorecido: 'X' }, criticalityOp: extra.criticalityOp,
  }, t));
}

/** Prepara estado direto no banco (a máquina de estados é do serviço; o teste monta o cenário). */
const forcar = (tenant, id, patchSql) => comTenant(tenant, (t) => sequelize.query(`UPDATE integration.dispatches SET ${patchSql} WHERE id = :id`, { replacements: { id }, transaction: t }));
const ler = (tenant, id) => comTenant(tenant, async (t) => (await sequelize.query('SELECT * FROM integration.dispatches WHERE id = :id', { replacements: { id }, transaction: t }))[0][0]);
const chave = () => `qa-m9-d205-${uniqueSuffix()}`;

module.exports = { sequelize, comTenant, carregarTenants, ctxDe, conexao, config, criar, forcar, ler, chave, uniqueSuffix, dispatch };
