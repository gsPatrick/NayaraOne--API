'use strict';

/**
 * Testes de aceitação do CRM — Marco 3, segundo lote:
 *   M3-11 — Tarefas no ciclo de vida da Oportunidade (core.tasks passa a ser usada pelo CRM)
 *   M3-16 — Idempotência do Radar: reler/rerodar o matching nunca gera efeito colateral
 *   M3-19 — Timeline/interações omnichannel unificada da Oportunidade
 *
 * Tudo roda contra o banco REAL (homologação) via `nayara_runtime`, com RLS de verdade. Os
 * testes de M3-11/M3-19 usam `withRollbackTenantTransaction` (nada fica persistido). O teste
 * de M3-16 PRECISA de commit (o job abre as próprias transações, então não enxergaria dado
 * não commitado) — por isso usa `withCommittedTenantTransaction` e limpa o que criou no final.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const opportunitiesService = require('../src/features/crm/opportunities.service');
const visitsService = require('../src/features/crm/visits.service');
const messagesService = require('../src/features/crm/messages.service');
const proposalsService = require('../src/features/crm/proposals.service');
const opportunityTasksService = require('../src/features/crm/opportunityTasks.service');
const { getOpportunityTimeline } = require('../src/features/crm/opportunityTimeline.service');
const radarService = require('../src/features/radar/radar.service');
const { runRadarMatchingJob } = require('../src/engines/jobs/radarMatchingJob');
const { Task, AuditLog, Company, OutboxEvent, Notification, PropertyRadar } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

const FUTURE = (ms = 86400000) => new Date(Date.now() + ms);

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

async function createLead(transaction, label) {
  return peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: label },
    tenant.userId,
    transaction
  );
}

async function createActiveOpportunity(transaction, personId, extra = {}) {
  return opportunitiesService.createOpportunity(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personId,
      stage: 'QUALIFYING',
      nextAction: 'Ligar para o cliente',
      nextActionDueAt: FUTURE(),
      ...extra,
    },
    tenant.userId,
    transaction
  );
}

// ---------------------------------------------------------------------------
// M3-11 — Tarefas da oportunidade
// ---------------------------------------------------------------------------

test('M3-11: cria tarefa vinculada à oportunidade em core.tasks, lista de volta e audita', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M311 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    const task = await opportunityTasksService.createOpportunityTask(
      opportunity.id,
      {
        title: `Enviar documentação ${suffix}`,
        description: 'Reunir RG/CPF do comprador.',
        assignedToUserId: tenant.userId,
        dueAt: FUTURE(2 * 86400000),
        priority: 'HIGH',
      },
      tenant.userId,
      transaction
    );

    // A tarefa é uma linha REAL em core.tasks, com o vínculo polimórfico preenchido.
    assert.equal(task.relatedEntityType, 'crm.opportunities');
    assert.equal(task.relatedEntityId, opportunity.id);
    assert.equal(task.groupId, tenant.groupId);
    assert.equal(task.companyId, tenant.companyId);
    assert.equal(task.status, 'OPEN');
    assert.equal(task.priority, 'HIGH');

    const persisted = await Task.findByPk(task.id, { transaction });
    assert.ok(persisted, 'a tarefa precisa existir de fato em core.tasks');

    const listed = await opportunityTasksService.listOpportunityTasks(opportunity.id, transaction);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, task.id);

    const audit = await AuditLog.findAll({
      where: { entityType: 'Task', entityId: task.id, action: 'opportunity.task_create' },
      transaction,
    });
    assert.equal(audit.length, 1, 'toda mutação de CRM precisa gravar auditoria');
  });
});

test('M3-11: tarefas de uma oportunidade não vazam para outra oportunidade nem para outra empresa (RLS)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M311 RLS ${suffix}`);
    const opportunityA = await createActiveOpportunity(transaction, person.id);
    const opportunityB = await createActiveOpportunity(transaction, person.id);

    const task = await opportunityTasksService.createOpportunityTask(
      opportunityA.id,
      { title: `Tarefa exclusiva de A ${suffix}` },
      tenant.userId,
      transaction
    );

    const tasksB = await opportunityTasksService.listOpportunityTasks(opportunityB.id, transaction);
    assert.equal(tasksB.some((t) => t.id === task.id), false, 'tarefa de A não pode aparecer em B');

    // Agora o "atacante" autenticado em outra empresa do mesmo grupo: o RLS de core.tasks
    // impede até a leitura direta por id, e a oportunidade nem é encontrada (404).
    const vizinha = await Company.create(
      { groupId: tenant.groupId, name: `QA M311 — Empresa vizinha ${suffix}`, status: 'ACTIVE' },
      { transaction }
    );
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: vizinha.id }, transaction });

    assert.equal(await Task.findByPk(task.id, { transaction }), null, 'RLS não pode devolver tarefa de outra empresa');
    await assert.rejects(
      () => opportunityTasksService.listOpportunityTasks(opportunityA.id, transaction),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_NOT_FOUND');
        return true;
      }
    );

    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
  });
});

test('M3-11: tarefa sem título, com status/prioridade fora do enum ou em oportunidade inexistente é rejeitada', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M311 VAL ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    await assert.rejects(
      () => opportunityTasksService.createOpportunityTask(opportunity.id, { title: '   ' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_TASK_VALIDATION');
        return true;
      }
    );
    await assert.rejects(
      () =>
        opportunityTasksService.createOpportunityTask(
          opportunity.id,
          { title: 'x', status: 'QUASE_PRONTO' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_TASK_VALIDATION');
        return true;
      }
    );
    await assert.rejects(
      () =>
        opportunityTasksService.createOpportunityTask(
          opportunity.id,
          { title: 'x', priority: 'SUPER_URGENTE' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_TASK_VALIDATION');
        return true;
      }
    );
    await assert.rejects(
      () =>
        opportunityTasksService.createOpportunityTask(
          '00000000-0000-4000-8000-000000000000',
          { title: 'x' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_NOT_FOUND');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// M3-19 — Timeline unificada
// ---------------------------------------------------------------------------

test('M3-19: timeline traz mensagem, visita e mudança de estágio da MESMA oportunidade, do mais recente para o mais antigo', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M319 ${suffix}`);
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel M319 ${suffix}`,
        internalCode: `M319-${suffix}`,
        propertyType: 'RESIDENTIAL',
        city: `CidadeM319${suffix}`,
      },
      tenant.userId,
      transaction
    );
    const opportunity = await createActiveOpportunity(transaction, person.id, { propertyId: property.id });

    const message = await messagesService.createMessage(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        opportunityId: opportunity.id,
        channel: 'WHATSAPP',
        direction: 'INBOUND',
        authorType: 'CLIENT',
        body: 'Tenho interesse nesse imóvel.',
      },
      tenant.userId,
      transaction
    );

    // Visita agendada para daqui a 3 dias — é o item MAIS FUTURO, logo o primeiro da lista.
    const visit = await visitsService.createVisit(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        personId: person.id,
        opportunityId: opportunity.id,
        scheduledAt: FUTURE(3 * 86400000),
      },
      tenant.userId,
      transaction
    );

    await opportunitiesService.updateOpportunity(
      opportunity.id,
      { stage: 'PROPOSAL', nextAction: 'Enviar proposta', nextActionDueAt: FUTURE() },
      tenant.userId,
      transaction
    );

    const timeline = await getOpportunityTimeline(opportunity.id, transaction);

    const byType = (type) => timeline.filter((item) => item.type === type);
    assert.equal(byType('MESSAGE').length, 1);
    assert.equal(byType('VISIT').length, 1);
    assert.equal(byType('STAGE_CHANGE').length, 1);
    assert.equal(byType('MESSAGE')[0].id, message.id);
    assert.equal(byType('VISIT')[0].id, visit.id);

    // Ordem: mais recente primeiro — a visita (D+3) vem antes de tudo que aconteceu agora.
    assert.equal(timeline[0].type, 'VISIT');
    const times = timeline.map((item) => new Date(item.occurredAt).getTime());
    for (let i = 1; i < times.length; i += 1) {
      assert.ok(times[i - 1] >= times[i], 'a timeline precisa estar ordenada do mais recente para o mais antigo');
    }

    // O item de mudança de estágio carrega de onde para onde foi.
    const stageChange = byType('STAGE_CHANGE')[0];
    assert.equal(stageChange.data.fromStage, 'QUALIFYING');
    assert.equal(stageChange.data.toStage, 'PROPOSAL');

    // E a criação da oportunidade também aparece, como o item mais antigo do funil.
    assert.equal(byType('OPPORTUNITY_CREATED').length, 1);
  });
});

test('M3-19: timeline também unifica proposta e tarefa, e o filtro por tipo devolve só o pedido', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M319b ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    const proposal = await proposalsService.createProposal(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        opportunityId: opportunity.id,
        value: 350000,
      },
      tenant.userId,
      transaction
    );
    const task = await opportunityTasksService.createOpportunityTask(
      opportunity.id,
      { title: `Follow-up ${suffix}` },
      tenant.userId,
      transaction
    );

    const full = await getOpportunityTimeline(opportunity.id, transaction);
    assert.ok(full.some((item) => item.type === 'PROPOSAL' && item.id === proposal.id));
    assert.ok(full.some((item) => item.type === 'TASK' && item.id === task.id));

    const onlyProposals = await getOpportunityTimeline(opportunity.id, transaction, { types: ['PROPOSAL'] });
    assert.equal(onlyProposals.length, 1);
    assert.equal(onlyProposals[0].id, proposal.id);
    assert.equal(onlyProposals[0].data.versionNumber, 1);
  });
});

test('M3-19: timeline de oportunidade de outra empresa é 404 (RLS), nunca uma lista vazia "ok"', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M319 RLS ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);
    const vizinha = await Company.create(
      { groupId: tenant.groupId, name: `QA M319 — Empresa vizinha ${suffix}`, status: 'ACTIVE' },
      { transaction }
    );

    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: vizinha.id }, transaction });
    await assert.rejects(
      () => getOpportunityTimeline(opportunity.id, transaction),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_NOT_FOUND');
        return true;
      }
    );
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
  });
});

// ---------------------------------------------------------------------------
// M3-16 — Idempotência do Radar
// ---------------------------------------------------------------------------

test('M3-16: reler o matching do Radar N vezes é 100% sem efeito colateral (função pura de leitura)', async () => {
  const suffix = uniqueSuffix();
  const city = `RadarIdem${suffix}`;
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M316 ${suffix}`);
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel M316 ${suffix}`,
        internalCode: `M316-${suffix}`,
        propertyType: 'RESIDENTIAL',
        city,
      },
      tenant.userId,
      transaction
    );
    await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 400000 }, tenant.userId, transaction);

    const { radar } = await radarService.createRadar(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city, minPrice: 100000, maxPrice: 900000 },
      },
      tenant.userId,
      transaction
    );

    const outboxBefore = await OutboxEvent.count({
      where: { aggregateType: 'PropertyRadar', aggregateId: radar.id },
      transaction,
    });
    const notificationsBefore = await Notification.count({ where: { userId: tenant.userId }, transaction });

    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      runs.push(await radarService.getRadarMatches(radar.id, transaction));
    }

    // Mesmo conjunto de matches em todas as leituras...
    const ids = runs.map((r) => r.map((p) => p.id).sort().join(','));
    assert.equal(new Set(ids).size, 1, 'a mesma leitura precisa devolver sempre o mesmo resultado');
    assert.ok(runs[0].some((p) => p.id === property.id));

    // ...e ZERO efeito colateral: nenhuma leitura publicou evento nem notificou ninguém.
    assert.equal(
      await OutboxEvent.count({ where: { aggregateType: 'PropertyRadar', aggregateId: radar.id }, transaction }),
      outboxBefore
    );
    assert.equal(await Notification.count({ where: { userId: tenant.userId }, transaction }), notificationsBefore);
  });
});

test('M3-16: rodar o job do Radar DUAS vezes seguidas não republica evento nem duplica Notification', async () => {
  const suffix = uniqueSuffix();
  const city = `RadarJob${suffix}`;
  const created = {};

  try {
    // Dados COMMITADOS — o job abre as próprias transações e não enxergaria dado não commitado.
    Object.assign(
      created,
      await withCommittedTenantTransaction(tenant, async (transaction) => {
        const person = await createLead(transaction, `Lead M316 job ${suffix}`);
        const property = await propertiesService.createProperty(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            title: `Imóvel M316 job ${suffix}`,
            internalCode: `M316J-${suffix}`,
            propertyType: 'RESIDENTIAL',
            city,
          },
          tenant.userId,
          transaction
        );
        const offer = await offersService.createOffer(
          property.id,
          { offerType: 'SALE', askingPrice: 400000 },
          tenant.userId,
          transaction
        );
        const { radar } = await radarService.createRadar(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            personId: person.id,
            criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city, minPrice: 100000, maxPrice: 900000 },
          },
          tenant.userId,
          transaction
        );
        return { personId: person.id, propertyId: property.id, offerId: offer.id, radarId: radar.id };
      })
    );

    const countState = async () =>
      withCommittedTenantTransaction(tenant, async (t) => ({
        outbox: await OutboxEvent.count({
          where: { aggregateType: 'PropertyRadar', aggregateId: created.radarId, eventType: 'radar.matched' },
          transaction: t,
        }),
        notifications: await Notification.count({
          where: { userId: tenant.userId, title: 'Novo match no Radar' },
          transaction: t,
        }),
      }));

    const before = await countState();

    await runRadarMatchingJob();
    const afterFirst = await countState();

    await runRadarMatchingJob();
    const afterSecond = await countState();

    // Primeira rodada: encontra o match novo, publica UM evento e notifica UMA vez.
    assert.equal(afterFirst.outbox - before.outbox, 1, 'a 1ª rodada deve publicar exatamente 1 radar.matched');
    // >= 1 e não "== 1": o job varre TODOS os radares ativos do tenant, então outros radares
    // pré-existentes podem legitimamente gerar notificações nesta mesma rodada. O que o teste
    // prova é a rodada SEGUINTE não gerar mais nada.
    assert.ok(afterFirst.notifications - before.notifications >= 1, 'a 1ª rodada deve criar ao menos 1 Notification');

    // Segunda rodada, mesmíssimo estado: NADA acontece de novo (idempotência via
    // idempotencyKey `radar.matched:<radarId>:<propertyId>` no outbox).
    assert.equal(afterSecond.outbox, afterFirst.outbox, 'a 2ª rodada não pode republicar o mesmo match');
    assert.equal(afterSecond.notifications, afterFirst.notifications, 'a 2ª rodada não pode duplicar a Notification');
  } finally {
    // Limpeza do que foi commitado (a auditoria é append-only e fica, por design).
    await withCommittedTenantTransaction(tenant, async (t) => {
      if (created.radarId) {
        await Notification.destroy({
          where: { userId: tenant.userId, title: 'Novo match no Radar' },
          transaction: t,
        });
        await OutboxEvent.destroy({
          where: { aggregateType: 'PropertyRadar', aggregateId: created.radarId },
          transaction: t,
        });
        await PropertyRadar.destroy({ where: { id: created.radarId }, force: true, transaction: t });
      }
      if (created.propertyId) {
        // property_price_history referencia a oferta — precisa sair antes dela.
        await sequelize.query(
          'DELETE FROM "real_estate"."property_price_history" WHERE offer_id IN (SELECT id FROM "real_estate"."property_offers" WHERE property_id = :id)',
          { replacements: { id: created.propertyId }, transaction: t }
        );
        await sequelize.query('DELETE FROM "real_estate"."property_offers" WHERE property_id = :id', {
          replacements: { id: created.propertyId },
          transaction: t,
        });
        await sequelize.query('DELETE FROM "real_estate"."properties" WHERE id = :id', {
          replacements: { id: created.propertyId },
          transaction: t,
        });
      }
      if (created.personId) {
        await sequelize.query('DELETE FROM "people"."persons" WHERE id = :id', {
          replacements: { id: created.personId },
          transaction: t,
        });
      }
    });
  }
});
