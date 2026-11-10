'use strict';

// Livro do Marco 3 §10 (Funil CRM): NEW, QUALIFIED, MATCHING, VISIT_SCHEDULED, VISITED, PROPOSAL, FINANCING, CONTRACT,
// WON, LOST, NURTURE. O funil é catálogo fechado; WON/LOST do livro são gravados como CLOSED_WON/CLOSED_LOST.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const opportunitiesService = require('../src/features/crm/opportunities.service');
const { ACTIVE_STAGES, STAGES } = require('../src/features/crm/opportunityStages');

let tenant;
const FUTURE = () => new Date(Date.now() + 86400000).toISOString();

before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

async function lead(t) {
  return peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Funil ${uniqueSuffix()}` }, tenant.userId, t);
}
function create(t, personId, extra = {}) {
  return opportunitiesService.createOpportunity(
    { groupId: tenant.groupId, companyId: tenant.companyId, personId, nextAction: 'Ligar', nextActionDueAt: FUTURE(), ...extra },
    tenant.userId,
    t
  );
}
const invalid = (err) => err.statusCode === 400 && err.code === 'OPPORTUNITY_STAGE_INVALID';

test('funil do livro: catálogo tem exatamente os 9 estágios ativos do §10 e os terminais CLOSED_WON/CLOSED_LOST/WITHDRAWN', () => {
  assert.deepEqual([...ACTIVE_STAGES], ['NEW', 'QUALIFIED', 'MATCHING', 'VISIT_SCHEDULED', 'VISITED', 'PROPOSAL', 'FINANCING', 'CONTRACT', 'NURTURE']);
  assert.deepEqual(STAGES.slice(ACTIVE_STAGES.length), ['CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN']);
});

test('funil do livro: sem estágio a oportunidade nasce NEW; cada estágio ativo do livro é aceito na criação e na mudança', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await lead(t);
    const nova = await create(t, person.id);
    assert.equal(nova.stage, 'NEW');
    for (const stage of ACTIVE_STAGES) {
      const criada = await create(t, person.id, { stage: stage.toLowerCase() });
      assert.equal(criada.stage, stage);
    }
    let atual = nova;
    for (const stage of ACTIVE_STAGES.slice(1)) {
      atual = await opportunitiesService.updateOpportunity(atual.id, { stage }, tenant.userId, t);
      assert.equal(atual.stage, stage);
      assert.equal(atual.closedAt, null);
    }
  });
});

test('funil do livro: WON e LOST viram CLOSED_WON e CLOSED_LOST, com o motivo estruturado obrigatório', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await lead(t);
    const a = await create(t, person.id, { stage: 'PROPOSAL' });
    await assert.rejects(opportunitiesService.updateOpportunity(a.id, { stage: 'WON' }, tenant.userId, t), (err) => err.code === 'OPPORTUNITY_OUTCOME_REASON_REQUIRED');
    const ganha = await opportunitiesService.updateOpportunity(a.id, { stage: 'WON', wonReason: 'PRICE_ACCEPTED' }, tenant.userId, t);
    assert.equal(ganha.stage, 'CLOSED_WON');
    assert.ok(ganha.closedAt);
    const b = await create(t, person.id, { stage: 'VISITED' });
    await assert.rejects(opportunitiesService.updateOpportunity(b.id, { stage: 'lost' }, tenant.userId, t), (err) => err.code === 'OPPORTUNITY_OUTCOME_REASON_REQUIRED');
    const perdida = await opportunitiesService.updateOpportunity(b.id, { stage: 'lost', lostReason: 'COMPETITOR' }, tenant.userId, t);
    assert.equal(perdida.stage, 'CLOSED_LOST');
    const c = await opportunitiesService.createOpportunity({ groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, stage: 'LOST', lostReason: 'LOCATION' }, tenant.userId, t);
    assert.equal(c.stage, 'CLOSED_LOST');
  });
});

test('funil do livro: estágio fora do catálogo é recusado na criação e na mudança, sem alterar a oportunidade', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await lead(t);
    for (const stage of ['NOVO', 'QUALIFYING', 'NEGOTIATION', 'CLOSED', '']) {
      await assert.rejects(create(t, person.id, { stage: stage || ' ' }), invalid);
    }
    const ativa = await create(t, person.id, { stage: 'MATCHING' });
    await assert.rejects(opportunitiesService.updateOpportunity(ativa.id, { stage: 'FECHADO' }, tenant.userId, t), invalid);
    await assert.rejects(opportunitiesService.updateOpportunity(ativa.id, { stage: null }, tenant.userId, t), invalid);
    const depois = await opportunitiesService.getOpportunity(ativa.id, t);
    assert.equal(depois.stage, 'MATCHING');
  });
});
