'use strict';

// Apoio dos testes adversariais do Marketing (M9-D436): contagem de envios no sandbox, tarefa interna do lead novo e campanha agendada de e-mail. Não é teste.
const { sequelize } = require('../../../src/models');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const { adapters } = require('../../../src/features/marketing/publications');
const assert = require('node:assert/strict');
const env = require('./m9d425Env');
const { prepararTenants } = require('../../helpers/marketingExecucao');

const { q } = env;
const sandboxCount = (tenant, channel) => adapters.sandboxRecordCount(tenant.companyId, channel);
const taskOf = async (t, tenant, personId, title = 'Contatar lead novo') => (await q(t, "SELECT id, title FROM core.tasks WHERE company_id = :c AND (related_entity_id = :p OR related_entity_id IN (SELECT id FROM crm.opportunities WHERE person_id = :p)) AND title = :ti", { c: tenant.companyId, p: personId, ti: title }))[0] || null;

/** Campanha de e-mail agendada (começa em 01/12/2031) para as pessoas; devolve a linha da campanha. */
async function scheduledCampaign(t, tenant, personIds) {
  const templateId = await env.makeTemplate(t, tenant, { channel: 'EMAIL', official: null, body: 'Conheça o Aurora, um lançamento novo.', variables: [] });
  const base = env.completeBody({ templateId, personIds, startsAt: '2031-12-01T09:00:00', endsAt: '2031-12-10T18:00:00', audiences: [{ kind: 'PERSON_LIST', purpose: 'MARKETING', filter: { personIds } }] });
  const { campaign } = await campaigns.saveCampaign(tenant, tenant.userId, { ...base, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
  return campaign;
}
const deliveries = (t, campaignId) => q(t, 'SELECT person_id, status, reason FROM marketing.campaign_step_deliveries WHERE campaign_id = :c', { c: campaignId });

/**
 * Isolamento entre empresas (RLS FORCE): na MESMA transação do teste, troca o contexto para a outra empresa e confere que as linhas da dona (por tabela e ids) não aparecem; volta ao contexto
 * da dona e confere que continuam lá. `linhas`: [{ tabela, ids }].
 */
async function assertIsolated(t, owner, linhas) {
  const { tenantA, tenantB } = await prepararTenants();
  const other = owner.companyId === tenantA.companyId ? tenantB : tenantA;
  const contar = async (tenant, tabela, ids) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true), set_config(\'app.company_id\', :c, true)', { transaction: t, replacements: { g: tenant.groupId, c: tenant.companyId } });
    return (await q(t, `SELECT count(*)::int AS n FROM ${tabela} WHERE id = ANY(CAST(:ids AS uuid[]))`, { ids: `{${ids.join(',')}}` }))[0].n;
  };
  try {
    for (const { tabela, ids } of linhas) {
      assert.ok(ids.length > 0, `${tabela}: o teste de isolamento precisa de ao menos uma linha`);
      assert.equal(await contar(other, tabela, ids), 0, `${tabela}: a outra empresa não pode enxergar as linhas desta`);
      assert.equal(await contar(owner, tabela, ids), ids.length, `${tabela}: a dona continua enxergando as suas`);
    }
  } finally {
    await contar(owner, 'marketing.templates', ['00000000-0000-0000-0000-000000000000']);
  }
}

module.exports = { ...env, assertIsolated, sequelize, sandboxCount, taskOf, scheduledCampaign, deliveries, adapters };
