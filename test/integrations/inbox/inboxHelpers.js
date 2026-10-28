'use strict';

// Apoio dos testes da caixa de entrada de webhooks (M9-D203): contexto de empresa com COMMIT (as corridas precisam de
// transações reais) e criação de eventos.
const { sequelize, getSeedTenant, uniqueSuffix } = require('../../testHelpers');
const { Group, Company } = require('../../../src/models');
const { receiveEvent } = require('../../../src/features/integrations/inbox');

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

const corpo = (extra = {}) => Buffer.from(JSON.stringify({ valor: '100.00', ...extra }));

/** Recebe um evento (commit) com o fornecedor de teste e devolve o resultado. */
function receber(tenant, provider, eventId, opts = {}) {
  const raw = opts.raw || corpo({ e: eventId });
  return comTenant(tenant, (t) => receiveEvent(
    { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId },
    { providerCode: provider, externalEventId: eventId, rawBody: raw, body: JSON.parse(raw.toString()), headers: opts.headers || {}, eventType: 'qa.evento' },
    t
  ));
}

const prefixo = () => `qa-m9-d203-${uniqueSuffix()}`;

module.exports = { sequelize, comTenant, carregarTenants, corpo, receber, prefixo, uniqueSuffix };
