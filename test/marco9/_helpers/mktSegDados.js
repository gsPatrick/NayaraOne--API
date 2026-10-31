'use strict';

// Apoio dos testes de segurança do Marketing (M9-D441): popula as 15 tabelas do livro numa empresa (dentro da transação do teste) e troca o contexto de RLS. Não é teste.
const { sequelize } = require('../../../src/models');
const { popular, mkVersion } = require('../../helpers/marketingExecucao');
const { makePerson, makeTemplate, q, uid } = require('../../helpers/m9d412Fixtures');

/** Uma linha em cada uma das 15 tabelas do livro para a empresa `tenant` (devolve o id da campanha e da pessoa). */
async function popular15(t, tenant) {
  const person = await makePerson(t, tenant); // antes do popular: o pedido de avaliação precisa de uma pessoa da empresa
  await popular(tenant, t); // jobs, resultados, fluxos, versões de automação, runs, supressão, links, eventos de atribuição e pedido de avaliação
  await mkVersion(tenant, t); // template, item de conteúdo e versão
  const g = tenant.groupId; const c = tenant.companyId;
  const campaign = (await q(t, `INSERT INTO marketing.campaigns (group_id, company_id, code, name, objective, owner_user_id) VALUES (:g, :c, :code, 'QA-M9 RLS', 'objetivo de teste longo', :o) RETURNING id`,
    { g, c, code: `QA-${uid().slice(0, 8)}`, o: tenant.userId }))[0].id;
  await q(t, `INSERT INTO marketing.campaign_audiences (group_id, company_id, campaign_id, kind, purpose) VALUES (:g, :c, :camp, 'PERSON_LIST', 'X') RETURNING id`, { g, c, camp: campaign });
  const tpl = await makeTemplate(t, tenant);
  await q(t, `INSERT INTO marketing.campaign_steps (group_id, company_id, campaign_id, step_no, channel, template_id) VALUES (:g, :c, :camp, 1, 'EMAIL', :tpl) RETURNING id`, { g, c, camp: campaign, tpl });
  return { campaign, person };
}

/** Troca o contexto de RLS da transação (grupo e empresa); `null` limpa os dois (sem contexto). */
async function setContext(t, tenant) {
  await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true)", { transaction: t, replacements: { g: tenant ? tenant.groupId : '', c: tenant ? tenant.companyId : '' } });
}

module.exports = { popular15, setContext };
