'use strict';

// Origem do lead obrigatória na criação da oportunidade (segunda leva de 16/11/2026, item 7; DI-BI2-4). M9:610 trata "Lead source" como dado
// da atribuição e o KPI M9:784 "Leads por origem" precisa da origem de cada lead. Pelo serviço real, com rollback:
//  - sem origem: 422 OPPORTUNITY_LEAD_SOURCE_REQUIRED e nada é gravado (antes a oportunidade nascia sem origem e ficava fora do KPI);
//  - origem fora do catálogo: o mesmo erro do rastreio (400 MKT_VALIDATION), também antes de gravar; PARTNER entrou no catálogo;
//  - a edição não apaga a origem gravada;
//  - os canais preenchem sozinhos: WhatsApp grava WHATSAPP e a importação BCP (visita e proposta) grava FORM. A API de parceiro (PARTNER) é
//    conferida pela rota em test/marco9/governanca/m9d844.dados.http.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { QueryTypes } = require('sequelize');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { OutboxEvent } = require('../src/models');
const opportunityService = require('../src/features/crm/opportunity.service');
const { LEAD_SOURCES } = require('../src/features/marketing/tracking/tracking.catalog');
const { resolveSender } = require('../src/features/crm/messaging/messaging.sender');
const { ensureOpportunity } = require('../src/features/core-governance/bcp/import/adapters/proposal');
const { createOpportunity, createPerson, createTestProperty } = require('./helpers/m3caCrm');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const errorOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
};
const sourceOf = async (t, id) => (await sequelize.query('SELECT lead_source FROM crm.opportunities WHERE id = :id', { replacements: { id }, transaction: t, type: QueryTypes.SELECT }))[0].lead_source;
const countOf = async (t, personId) => (await sequelize.query('SELECT count(*)::int AS n FROM crm.opportunities WHERE person_id = :p', { replacements: { p: personId }, transaction: t, type: QueryTypes.SELECT }))[0].n;

test('origem do lead: sem origem a oportunidade é recusada com 422 OPPORTUNITY_LEAD_SOURCE_REQUIRED e nada é gravado', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await createPerson(tenant, t, 'Sem origem');
    for (const vazio of [undefined, null, '', '   ']) {
      const err = await errorOf(createOpportunity(tenant, t, { personId: person.id, leadSource: vazio }));
      assert.ok(err, `origem ${JSON.stringify(vazio)} precisa ser recusada`);
      assert.deepEqual([err.statusCode, err.code], [422, 'OPPORTUNITY_LEAD_SOURCE_REQUIRED'], `origem ${JSON.stringify(vazio)}`);
      assert.equal(err.details.field, 'leadSource');
    }
    assert.equal(await countOf(t, person.id), 0, 'nenhuma oportunidade gravada');
    const eventos = await OutboxEvent.count({ where: { eventType: 'crm.opportunity.created' }, transaction: t });
    const criada = await createOpportunity(tenant, t, { personId: person.id });
    assert.equal(await OutboxEvent.count({ where: { eventType: 'crm.opportunity.created' }, transaction: t }), eventos + 1, 'só a criada com origem publica o evento');
    assert.equal(await sourceOf(t, criada.id), 'FORM');
  });
});

test('origem do lead: fora do catálogo dá o erro do rastreio antes de gravar; minúscula é normalizada; PARTNER é do catálogo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await createPerson(tenant, t, 'Origem inventada');
    const err = await errorOf(createOpportunity(tenant, t, { personId: person.id, leadSource: 'FEIRA' }));
    assert.deepEqual([err && err.statusCode, err && err.code], [400, 'MKT_VALIDATION']);
    assert.deepEqual(err.details.allowed, LEAD_SOURCES);
    assert.equal(await countOf(t, person.id), 0, 'a origem é conferida antes de gravar');
    assert.ok(LEAD_SOURCES.includes('PARTNER'), 'o lead da API de parceiro tem código próprio');
    const parceiro = await createOpportunity(tenant, t, { personId: person.id, leadSource: ' partner ' });
    assert.equal(await sourceOf(t, parceiro.id), 'PARTNER');
  });
});

test('origem do lead: a edição não apaga nem troca a origem gravada', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const opp = await createOpportunity(tenant, t, { leadSource: 'SITE' });
    await opportunityService.updateOpportunity(opp.id, { leadSource: null, temperature: 'HOT', nextAction: 'Enviar opções', nextActionDueAt: new Date(Date.now() + 86400000) }, tenant.userId, t);
    assert.equal(await sourceOf(t, opp.id), 'SITE', 'leadSource nulo na edição é ignorado');
    await opportunityService.updateOpportunity(opp.id, { leadSource: 'PHONE', stage: 'QUALIFIED' }, tenant.userId, t);
    assert.equal(await sourceOf(t, opp.id), 'SITE', 'a origem é a da chegada do lead');
  });
});

test('origem do lead: quem chega pelo WhatsApp nasce com WHATSAPP e a importação BCP nasce com FORM', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const from = `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    const quem = await resolveSender({ groupId: tenant.groupId, companyId: tenant.companyId }, { from, name: 'Contato Origem WhatsApp' }, t);
    assert.equal(quem.provisional, true, 'remetente desconhecido vira lead provisório');
    assert.equal(await sourceOf(t, quem.opportunityId), 'WHATSAPP');

    const person = await createPerson(tenant, t, 'Proponente BCP');
    const property = await createTestProperty(tenant, t);
    const operation = { manualReference: `BCP-QA-${randomUUID().slice(0, 6)}` };
    const { opportunity, created } = await ensureOpportunity({ tenant, actorUserId: tenant.userId, operation, person, property }, t);
    assert.equal(created, true);
    assert.equal(await sourceOf(t, opportunity.id), 'FORM', 'formulário em papel da contingência');
  });
});
