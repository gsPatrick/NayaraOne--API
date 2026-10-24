'use strict';

/**
 * CICLO 4 (Marco 3): os 6 eventos mínimos novos da seção 17 do Caderno (commit bb9fa88)
 * incluem crm.opportunity.lost/won, disparados em updateOpportunity() na transição para
 * CLOSED_LOST/CLOSED_WON. Esse arquivo prova, com corrida REAL (duas transações commitadas em
 * paralelo, não chamadas sequenciais), que duas tentativas simultâneas de fechar a MESMA
 * oportunidade como CLOSED_LOST não duplicam o evento no outbox nem corrompem o estado — o
 * FOR UPDATE já existente em getOpportunity(..., { lock: true }) deve serializar a segunda
 * chamada atrás da primeira.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, uniqueSuffix } = require('./testHelpers');
const personService = require('../src/features/people/person.service');
const opportunityService = require('../src/features/crm/opportunity.service');
const { OutboxEvent, Opportunity } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function withCommittedTenantTransaction(tenantCtx, fn) {
  const t = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantCtx.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantCtx.companyId }, transaction: t });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenantCtx.userId }, transaction: t });
    const result = await fn(t);
    await t.commit();
    return result;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

test('crm.opportunity.lost: duas chamadas CONCORRENTES fechando a mesma oportunidade como CLOSED_LOST não duplicam o evento no outbox', async () => {
  const suffix = uniqueSuffix();
  const created = {};

  try {
    Object.assign(
      created,
      await withCommittedTenantTransaction(tenant, async (transaction) => {
        const person = await personService.createPerson(
          { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Corrida Lost ${suffix}`, allowDuplicate: true },
          tenant.userId,
          transaction
        );
        const opportunity = await opportunityService.createOpportunity(
          { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + 86400000) },
          tenant.userId,
          transaction
        );
        return { personId: person.id, opportunityId: opportunity.id };
      })
    );

    // Corrida REAL: duas transações commitadas em paralelo, ambas tentando fechar a MESMA
    // oportunidade como CLOSED_LOST com o mesmo motivo.
    const results = await Promise.allSettled([
      withCommittedTenantTransaction(tenant, (t) =>
        opportunityService.updateOpportunity(created.opportunityId, { stage: 'CLOSED_LOST', lostReason: 'PRICE_TOO_HIGH' }, tenant.userId, t)
      ),
      withCommittedTenantTransaction(tenant, (t) =>
        opportunityService.updateOpportunity(created.opportunityId, { stage: 'CLOSED_LOST', lostReason: 'PRICE_TOO_HIGH' }, tenant.userId, t)
      ),
    ]);

    // Ambas devem ter sucesso (o lock serializa, não rejeita) — a segunda só reafirma um
    // estado que já é CLOSED_LOST depois da primeira commitar.
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(okCount, 2, 'as duas chamadas devem ter sucesso — FOR UPDATE serializa, não rejeita');

    const finalOpportunity = await withCommittedTenantTransaction(tenant, (t) => Opportunity.findByPk(created.opportunityId, { transaction: t }));
    assert.equal(finalOpportunity.stage, 'CLOSED_LOST');

    const lostEvents = await withCommittedTenantTransaction(tenant, (t) =>
      OutboxEvent.findAll({
        where: { eventType: 'crm.opportunity.lost' },
        transaction: t,
      })
    );
    const eventsForThisOpportunity = lostEvents.filter((e) => e.payloadJson?.id === created.opportunityId);
    assert.equal(
      eventsForThisOpportunity.length,
      1,
      'a corrida não deve duplicar crm.opportunity.lost — só a transação que efetivamente mudou o stage publica'
    );
  } finally {
    if (created.opportunityId) {
      await withCommittedTenantTransaction(tenant, async (t) => {
        await sequelize.query('DELETE FROM "integration"."outbox_events" WHERE (payload_json->>\'id\')::uuid = :id', {
          replacements: { id: created.opportunityId },
          transaction: t,
        });
        await sequelize.query('DELETE FROM "crm"."opportunities" WHERE id = :id', { replacements: { id: created.opportunityId }, transaction: t });
        if (created.personId) {
          await sequelize.query('DELETE FROM "people"."persons" WHERE id = :id', { replacements: { id: created.personId }, transaction: t });
        }
      });
    }
  }
});
