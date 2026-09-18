'use strict';

/**
 * Testes de aceitação do pacote CRM — Caderno CURRENT, Marco 3:
 *   M3-12        — motivos estruturados de ganho, perda e desistência
 *   M3-13 / M3-25 — entidade real de Proposta (append-only por versão) + jornada E2E
 *   M3-15        — explicação do score/critérios do Radar
 *   M3-17        — indicadores do painel calculados pela MESMA fonte das listas
 *   M3-20        — reclamações/elogios/conflitos com SLA e escalonamento
 *   M3-21        — exportação sensível limitada e auditada
 *
 * Tudo roda contra o banco REAL (homologação) via `nayara_runtime`, com RLS de verdade: toda
 * query está dentro de `withRollbackTenantTransaction` (SET LOCAL app.group_id/company_id/
 * user_id + rollback no final), então nenhum dado de teste fica persistido.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const opportunitiesService = require('../src/features/crm/opportunities.service');
const proposalsService = require('../src/features/crm/proposals.service');
const dashboardService = require('../src/features/crm/dashboard.service');
const feedbackCasesService = require('../src/features/crm/feedbackCases.service');
const exportService = require('../src/features/crm/opportunitiesExport.service');
const radarService = require('../src/features/radar/radar.service');
const { explainMatch } = require('../src/features/radar/radarMatching.service');
const { escalateOverdueFeedbackCases } = require('../src/engines/jobs/feedbackCaseAlertJob');
const { AuditLog, Notification, Proposal, FeedbackCase } = require('../src/models');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

const FUTURE = () => new Date(Date.now() + 86400000);

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
// M3-12 — Motivos estruturados de ganho, perda e desistência
// ---------------------------------------------------------------------------

test('M3-12: fechar como CLOSED_WON sem wonReason é rejeitado (422)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M312 A ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    await assert.rejects(
      () => opportunitiesService.updateOpportunity(opportunity.id, { stage: 'CLOSED_WON' }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, 'OPPORTUNITY_OUTCOME_REASON_REQUIRED');
        return true;
      }
    );
  });
});

test('M3-12: fechar como CLOSED_LOST sem lostReason é rejeitado (422)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M312 B ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    await assert.rejects(
      () => opportunitiesService.updateOpportunity(opportunity.id, { stage: 'CLOSED_LOST' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_OUTCOME_REASON_REQUIRED');
        return true;
      }
    );
  });
});

test('M3-12: motivo fora do enum é rejeitado (422) — em ganho, perda e desistência', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M312 C ${suffix}`);

    const cases = [
      { stage: 'CLOSED_WON', payload: { wonReason: 'PORQUE_SIM' } },
      { stage: 'CLOSED_LOST', payload: { lostReason: 'ACHOU_CARO_DEMAIS' } },
      { stage: 'WITHDRAWN', payload: { withdrawnReason: 'SUMIU' } },
    ];

    for (const testCase of cases) {
      const opportunity = await createActiveOpportunity(transaction, person.id);
      await assert.rejects(
        () =>
          opportunitiesService.updateOpportunity(
            opportunity.id,
            { stage: testCase.stage, ...testCase.payload },
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.equal(err.statusCode, 422);
          assert.equal(err.code, 'OPPORTUNITY_OUTCOME_REASON_INVALID');
          return true;
        }
      );
    }
  });
});

test('M3-12: motivos válidos do enum são aceitos e normalizados (WON / LOST / WITHDRAWN)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead M312 D ${suffix}`);

    const won = await createActiveOpportunity(transaction, person.id);
    const wonClosed = await opportunitiesService.updateOpportunity(
      won.id,
      { stage: 'CLOSED_WON', wonReason: 'price_accepted' },
      tenant.userId,
      transaction
    );
    assert.equal(wonClosed.stage, 'CLOSED_WON');
    assert.equal(wonClosed.wonReason, 'PRICE_ACCEPTED'); // normalizado em upper case
    assert.ok(wonClosed.closedAt);

    const lost = await createActiveOpportunity(transaction, person.id);
    const lostClosed = await opportunitiesService.updateOpportunity(
      lost.id,
      { stage: 'CLOSED_LOST', lostReason: 'COMPETITOR' },
      tenant.userId,
      transaction
    );
    assert.equal(lostClosed.lostReason, 'COMPETITOR');

    // Desistência: stage terminal próprio, com motivo próprio obrigatório, e SEM exigir
    // nextAction (WITHDRAWN entra em CLOSED_STAGES).
    const withdrawn = await createActiveOpportunity(transaction, person.id);
    const withdrawnClosed = await opportunitiesService.updateOpportunity(
      withdrawn.id,
      { stage: 'WITHDRAWN', withdrawnReason: 'NO_RESPONSE' },
      tenant.userId,
      transaction
    );
    assert.equal(withdrawnClosed.stage, 'WITHDRAWN');
    assert.equal(withdrawnClosed.withdrawnReason, 'NO_RESPONSE');
    assert.ok(withdrawnClosed.closedAt);
  });
});

// ---------------------------------------------------------------------------
// M3-13 / M3-25 — Proposta como entidade real
// ---------------------------------------------------------------------------

test('M3-13: cria proposta ligada à oportunidade, publica domain event e audita', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead Proposta ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    const proposal = await proposalsService.createProposal(
      { groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opportunity.id, value: 350000 },
      tenant.userId,
      transaction
    );

    assert.ok(proposal.id);
    assert.equal(proposal.versionNumber, 1);
    assert.equal(proposal.status, 'DRAFT');
    assert.equal(Number(proposal.value), 350000);
    assert.equal(proposal.proposedByPersonId, person.id);

    const { OutboxEvent } = require('../src/models');
    const events = await OutboxEvent.findAll({ where: { aggregateId: proposal.id }, transaction });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'crm.proposal.created');

    const logs = await AuditLog.findAll({ where: { entityId: proposal.id, action: 'proposal.create' }, transaction });
    assert.equal(logs.length, 1);
  });
});

test('M3-13: nova proposta para a mesma oportunidade cria uma NOVA VERSÃO e preserva o histórico', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead Versões ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    const v1 = await proposalsService.createProposal(
      { groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opportunity.id, value: 300000 },
      tenant.userId,
      transaction
    );
    await proposalsService.updateProposalStatus(v1.id, { status: 'SENT' }, tenant.userId, transaction);

    const v2 = await proposalsService.createProposal(
      { groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opportunity.id, value: 330000 },
      tenant.userId,
      transaction
    );

    assert.equal(v2.versionNumber, 2);

    // O histórico continua lá: a v1 NÃO foi sobrescrita nem apagada.
    const history = await proposalsService.listProposals(transaction, { opportunityId: opportunity.id });
    assert.equal(history.length, 2);
    const reloadedV1 = await Proposal.findByPk(v1.id, { transaction });
    assert.equal(Number(reloadedV1.value), 300000);
    assert.equal(reloadedV1.status, 'SENT');

    // E o valor de uma proposta existente é imutável — tentar reescrever é 422.
    await assert.rejects(
      () => proposalsService.updateProposalStatus(v1.id, { status: 'REJECTED', value: 999999 }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, 'PROPOSAL_VALUE_IMMUTABLE');
        return true;
      }
    );
  });
});

test('M3-13: transição de status respeita a máquina de estados', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead Status ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);
    const proposal = await proposalsService.createProposal(
      { groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opportunity.id, value: 200000 },
      tenant.userId,
      transaction
    );

    const sent = await proposalsService.updateProposalStatus(proposal.id, { status: 'SENT' }, tenant.userId, transaction);
    assert.equal(sent.status, 'SENT');
    assert.ok(sent.sentAt);

    const negotiating = await proposalsService.updateProposalStatus(
      proposal.id,
      { status: 'UNDER_NEGOTIATION' },
      tenant.userId,
      transaction
    );
    assert.equal(negotiating.status, 'UNDER_NEGOTIATION');

    const accepted = await proposalsService.updateProposalStatus(
      proposal.id,
      { status: 'ACCEPTED' },
      tenant.userId,
      transaction
    );
    assert.equal(accepted.status, 'ACCEPTED');
    assert.ok(accepted.decidedAt);
    assert.equal(accepted.decidedByUserId, tenant.userId);

    // ACCEPTED é terminal: não volta para negociação.
    await assert.rejects(
      () => proposalsService.updateProposalStatus(proposal.id, { status: 'UNDER_NEGOTIATION' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'PROPOSAL_INVALID_TRANSITION');
        return true;
      }
    );
  });
});

test('M3-25: jornada mínima — oportunidade -> proposta -> aceite -> CLOSED_WON', async () => {
  /**
   * FRONTEIRA COBERTA POR ESTE PACOTE (declarada explicitamente): o requisito M3-25 descreve a
   * jornada completa "lead, Radar, visita, proposta, contrato, recebimento e comissão". ESTE
   * TESTE COBRE SOMENTE O TRECHO DE CRM: lead -> Radar (com explicação de match) -> proposta
   * -> aceite da proposta -> oportunidade fechada como CLOSED_WON com motivo estruturado.
   * Contrato (legal), recebimento (finance) e comissão (finance) NÃO são exercitados aqui —
   * são domínio de outros pacotes e continuam sendo a lacuna conhecida desta jornada E2E.
   */
  const suffix = uniqueSuffix();
  const city = `JornadaCity${suffix}`;

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // 1. Lead
    const person = await createLead(transaction, `Lead Jornada ${suffix}`);

    // 2. Imóvel com oferta ativa
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel Jornada ${suffix}`,
        internalCode: `JOR-${suffix}`,
        propertyType: 'RESIDENTIAL',
        city,
        areaTotalM2: 100,
      },
      tenant.userId,
      transaction
    );
    await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 450000 }, tenant.userId, transaction);

    // 3. Oportunidade
    const opportunity = await createActiveOpportunity(transaction, person.id, { propertyId: property.id });

    // 4. Radar do cliente encontra o imóvel
    const { radar, matches } = await radarService.createRadar(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        opportunityId: opportunity.id,
        criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city, minPrice: 300000, maxPrice: 500000 },
      },
      tenant.userId,
      transaction
    );
    assert.ok(matches.some((match) => match.id === property.id));

    // 4b. E a explicação do match (M3-15) confirma o porquê.
    const explanation = await radarService.explainRadarMatch(radar.id, property.id, transaction);
    assert.equal(explanation.matched, true);

    // 5. Proposta enviada e aceita
    const proposal = await proposalsService.createProposal(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        opportunityId: opportunity.id,
        propertyId: property.id,
        value: 440000,
        status: 'SENT',
      },
      tenant.userId,
      transaction
    );
    const accepted = await proposalsService.updateProposalStatus(
      proposal.id,
      { status: 'ACCEPTED' },
      tenant.userId,
      transaction
    );
    assert.equal(accepted.status, 'ACCEPTED');

    // 6. Oportunidade fechada como ganha, com motivo estruturado obrigatório
    const won = await opportunitiesService.updateOpportunity(
      opportunity.id,
      { stage: 'CLOSED_WON', wonReason: 'PRICE_ACCEPTED' },
      tenant.userId,
      transaction
    );
    assert.equal(won.stage, 'CLOSED_WON');
    assert.equal(won.wonReason, 'PRICE_ACCEPTED');
    assert.ok(won.closedAt);
  });
});

// ---------------------------------------------------------------------------
// M3-15 — Explicação dos critérios do Radar
// ---------------------------------------------------------------------------

test('M3-15: imóvel que bate em tudo tem todos os critérios matched=true e score 1', async () => {
  const suffix = uniqueSuffix();
  const city = `ExplainCity${suffix}`;

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead Explain OK ${suffix}`);
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Explain OK ${suffix}`,
        internalCode: `EXP-OK-${suffix}`,
        propertyType: 'RESIDENTIAL',
        city,
        areaTotalM2: 90,
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
        criteriaJson: {
          propertyType: 'RESIDENTIAL',
          offerType: 'SALE',
          city,
          minPrice: 300000,
          maxPrice: 500000,
          minAreaM2: 50,
          maxAreaM2: 120,
        },
      },
      tenant.userId,
      transaction
    );

    const explanation = await radarService.explainRadarMatch(radar.id, property.id, transaction);

    assert.equal(explanation.matched, true);
    assert.equal(explanation.score, 1);
    assert.equal(explanation.matchedCount, explanation.totalCriteria);
    for (const [criterion, detail] of Object.entries(explanation.criteria)) {
      assert.equal(detail.matched, true, `Critério "${criterion}" deveria ter batido.`);
    }
    // Os critérios esperados estão todos presentes na explicação.
    for (const key of ['propertyType', 'city', 'areaRange', 'activeOffer', 'offerType', 'priceRange']) {
      assert.ok(explanation.criteria[key], `Faltou o critério "${key}" na explicação.`);
    }
  });
});

test('M3-15: imóvel que falha só no preço mostra priceRange matched=false com motivo, e o resto matched=true', async () => {
  const suffix = uniqueSuffix();
  const city = `ExplainFail${suffix}`;

  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead Explain Fail ${suffix}`);
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Explain Caro ${suffix}`,
        internalCode: `EXP-CARO-${suffix}`,
        propertyType: 'RESIDENTIAL',
        city,
        areaTotalM2: 90,
      },
      tenant.userId,
      transaction
    );
    await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 900000 }, tenant.userId, transaction);

    const { radar } = await radarService.createRadar(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city, minPrice: 300000, maxPrice: 500000 },
      },
      tenant.userId,
      transaction
    );

    const explanation = await radarService.explainRadarMatch(radar.id, property.id, transaction);

    assert.equal(explanation.matched, false);
    assert.equal(explanation.criteria.priceRange.matched, false);
    assert.match(explanation.criteria.priceRange.reason, /Acima do máximo/);
    assert.equal(explanation.criteria.propertyType.matched, true);
    assert.equal(explanation.criteria.city.matched, true);
    assert.equal(explanation.criteria.offerType.matched, true);
    assert.ok(explanation.score > 0 && explanation.score < 1);
  });
});

test('M3-15: explainMatch é puro (não quebra o matching determinístico existente)', async () => {
  // Chamada direta, em memória, sem banco: garante que a nova função convive com
  // matchRadarToProperties sem alterá-la.
  const explanation = explainMatch(
    { criteriaJson: { propertyType: 'COMMERCIAL' } },
    { id: 'fake-id', propertyType: 'RESIDENTIAL', offers: [] }
  );
  assert.equal(explanation.criteria.propertyType.matched, false);
  assert.equal(explanation.criteria.activeOffer.matched, false);
  assert.equal(explanation.matched, false);
});

// ---------------------------------------------------------------------------
// M3-17 — Painel calculado pela mesma fonte das listas
// ---------------------------------------------------------------------------

test('M3-17: indicadores do painel batem exatamente com a contagem manual das mesmas oportunidades', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Uma pessoa dedicada isola o recorte: o painel é filtrado por personId, então os números
    // são comparáveis com a contagem manual da MESMA listagem, sem interferência do seed.
    const person = await createLead(transaction, `Lead Painel ${suffix}`);

    // 3 oportunidades em estados diferentes: ganha, perdida e em aberto.
    const ganha = await createActiveOpportunity(transaction, person.id);
    await opportunitiesService.updateOpportunity(
      ganha.id,
      { stage: 'CLOSED_WON', wonReason: 'REFERRAL' },
      tenant.userId,
      transaction
    );

    const perdida = await createActiveOpportunity(transaction, person.id);
    await opportunitiesService.updateOpportunity(
      perdida.id,
      { stage: 'CLOSED_LOST', lostReason: 'PRICE_TOO_HIGH' },
      tenant.userId,
      transaction
    );

    await createActiveOpportunity(transaction, person.id); // segue aberta em QUALIFYING

    const dashboard = await dashboardService.getCrmDashboard({ personId: person.id }, transaction);

    // Contagem MANUAL, feita sobre a MESMA listagem que a tela usa.
    const listed = await opportunitiesService.listOpportunities(transaction, { personId: person.id });
    const manual = listed.reduce((acc, opportunity) => {
      acc[opportunity.stage] = (acc[opportunity.stage] || 0) + 1;
      return acc;
    }, {});

    assert.equal(dashboard.opportunities.total, listed.length);
    assert.equal(dashboard.opportunities.total, 3);
    assert.deepEqual(dashboard.opportunities.byStage, manual);
    assert.equal(dashboard.opportunities.closed.won, manual.CLOSED_WON || 0);
    assert.equal(dashboard.opportunities.closed.lost, manual.CLOSED_LOST || 0);
    assert.equal(dashboard.opportunities.open, 1);

    // 1 ganha de 2 fechadas = 50%.
    assert.equal(dashboard.conversionRate, 0.5);

    const priceTooHigh = dashboard.topLostReasons.find((row) => row.reason === 'PRICE_TOO_HIGH');
    assert.ok(priceTooHigh, 'PRICE_TOO_HIGH deveria aparecer nos motivos de perda.');
    assert.equal(priceTooHigh.total, 1);
    assert.equal(priceTooHigh.inEnum, true);
  });
});

// ---------------------------------------------------------------------------
// M3-20 — Reclamações, elogios e conflitos com SLA e escalonamento
// ---------------------------------------------------------------------------

test('M3-20: criação calcula o SLA correto por severidade (HIGH 24h, MEDIUM 72h, LOW 7d)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead SLA ${suffix}`);

    const expected = { HIGH: 24, MEDIUM: 72, LOW: 168 };
    for (const [severity, hours] of Object.entries(expected)) {
      const before = Date.now();
      const feedbackCase = await feedbackCasesService.createFeedbackCase(
        {
          groupId: tenant.groupId,
          companyId: tenant.companyId,
          personId: person.id,
          type: 'COMPLAINT',
          description: `Reclamação ${severity} ${suffix}`,
          severity,
        },
        tenant.userId,
        transaction
      );

      assert.equal(feedbackCase.status, 'OPEN');
      assert.equal(feedbackCase.severity, severity);
      const deltaHours = (new Date(feedbackCase.slaDueAt).getTime() - before) / 3600000;
      // Tolerância de alguns segundos entre o `before` do teste e o `new Date()` do service.
      assert.ok(
        Math.abs(deltaHours - hours) < 0.05,
        `SLA de ${severity} deveria ser ~${hours}h, veio ${deltaHours}h.`
      );
    }
  });
});

test('M3-20: escalonamento manual muda status, marca escalated_at e notifica o responsável', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead Escala ${suffix}`);

    const feedbackCase = await feedbackCasesService.createFeedbackCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        type: 'CONFLICT',
        description: `Conflito entre locador e locatário ${suffix}`,
        severity: 'HIGH',
        assignedToUserId: tenant.userId,
      },
      tenant.userId,
      transaction
    );

    const escalated = await feedbackCasesService.escalateFeedbackCase(
      feedbackCase.id,
      { automatic: false },
      tenant.userId,
      transaction
    );

    assert.equal(escalated.status, 'ESCALATED');
    assert.ok(escalated.escalatedAt);

    const notifications = await Notification.findAll({ where: { userId: tenant.userId }, transaction });
    assert.ok(
      notifications.some((notification) => notification.title.includes('ESCALONADO')),
      'Deveria existir uma Notification de escalonamento para o responsável.'
    );

    const logs = await AuditLog.findAll(
      { where: { entityId: feedbackCase.id, action: 'feedback_case.escalate' }, transaction }
    );
    assert.equal(logs.length, 1);

    // Um caso já escalonado não escalona de novo.
    await assert.rejects(
      () => feedbackCasesService.escalateFeedbackCase(feedbackCase.id, {}, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FEEDBACK_CASE_ALREADY_ESCALATED');
        return true;
      }
    );
  });
});

test('M3-20: resolver um caso marca RESOLVED e audita', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead Resolve ${suffix}`);
    const feedbackCase = await feedbackCasesService.createFeedbackCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        type: 'COMPLIMENT',
        description: `Elogio ao atendimento ${suffix}`,
        severity: 'LOW',
      },
      tenant.userId,
      transaction
    );

    const resolved = await feedbackCasesService.resolveFeedbackCase(
      feedbackCase.id,
      { resolutionNotes: 'Agradecido por telefone.' },
      tenant.userId,
      transaction
    );
    assert.equal(resolved.status, 'RESOLVED');
    assert.ok(resolved.resolvedAt);

    const logs = await AuditLog.findAll(
      { where: { entityId: feedbackCase.id, action: 'feedback_case.resolve' }, transaction }
    );
    assert.equal(logs.length, 1);
  });
});

test('M3-20: o job encontra e escalona um caso com SLA VENCIDO (tempo simulado via UPDATE direto)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead Job SLA ${suffix}`);

    const vencido = await feedbackCasesService.createFeedbackCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        type: 'COMPLAINT',
        description: `Reclamação vencida ${suffix}`,
        severity: 'HIGH',
        assignedToUserId: tenant.userId,
      },
      tenant.userId,
      transaction
    );

    const noPrazo = await feedbackCasesService.createFeedbackCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        type: 'COMPLAINT',
        description: `Reclamação no prazo ${suffix}`,
        severity: 'LOW',
        assignedToUserId: tenant.userId,
      },
      tenant.userId,
      transaction
    );

    // Simula a passagem do tempo empurrando o SLA para o passado (mesmo padrão já usado em
    // test/marco4.acceptance.test.js), em vez de esperar 24h de relógio real.
    await sequelize.query('UPDATE crm.feedback_cases SET sla_due_at = :ts WHERE id = :id', {
      replacements: { ts: new Date(Date.now() - 3600000), id: vencido.id },
      transaction,
    });

    const summary = await escalateOverdueFeedbackCases(transaction);

    assert.ok(summary.escalated >= 1);

    const reloadedVencido = await FeedbackCase.findByPk(vencido.id, { transaction });
    assert.equal(reloadedVencido.status, 'ESCALATED');
    assert.ok(reloadedVencido.escalatedAt);

    const reloadedNoPrazo = await FeedbackCase.findByPk(noPrazo.id, { transaction });
    assert.equal(reloadedNoPrazo.status, 'OPEN', 'Caso dentro do prazo NÃO deveria ter sido escalonado.');

    // O escalonamento automático fica registrado como ação do sistema (actorUserId null).
    const logs = await AuditLog.findAll(
      { where: { entityId: vencido.id, action: 'feedback_case.escalate' }, transaction }
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0].userId, null);
    assert.match(logs[0].reason, /AUTOMATICAMENTE/);

    // Idempotência: rodar o job de novo não reescalona (o caso já saiu de OPEN/IN_PROGRESS).
    const secondRun = await escalateOverdueFeedbackCases(transaction);
    const stillOne = await AuditLog.findAll(
      { where: { entityId: vencido.id, action: 'feedback_case.escalate' }, transaction }
    );
    assert.equal(stillOne.length, 1);
    assert.equal(secondRun.casesChecked >= 0, true);
  });
});

// ---------------------------------------------------------------------------
// M3-21 — Exportação sensível limitada e auditada
// ---------------------------------------------------------------------------

test('M3-21: exportação SEM a permissão dedicada é bloqueada (403)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () =>
        exportService.exportOpportunities(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            actorUserId: tenant.userId,
            // Tem permissão de LEITURA, mas não a de EXPORTAÇÃO.
            actorPermissions: ['crm:opportunities:read'],
            format: 'csv',
            filters: {},
          },
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, 'PERMISSION_DENIED');
        assert.equal(err.details.required, 'crm:opportunities:export');
        return true;
      }
    );
  });
});

test('M3-21: exportação COM a permissão funciona, limita os campos e audita a contagem certa', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `Lead Export ${suffix}`);
    await createActiveOpportunity(transaction, person.id);
    await createActiveOpportunity(transaction, person.id);

    const result = await exportService.exportOpportunities(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        actorUserId: tenant.userId,
        actorPermissions: ['crm:opportunities:read', 'crm:opportunities:export'],
        format: 'csv',
        filters: { personId: person.id },
      },
      transaction
    );

    assert.equal(result.recordCount, 2);
    assert.equal(result.format, 'csv');

    // Campos limitados: só as colunas declaradas em EXPORT_FIELDS, e NADA de texto livre
    // (`nextAction`) nem de dado cadastral da pessoa.
    assert.deepEqual(Object.keys(result.rows[0]), exportService.EXPORT_FIELDS);
    assert.ok(!Object.keys(result.rows[0]).includes('nextAction'));
    assert.ok(!result.content.includes('Ligar para o cliente'));
    assert.ok(!result.content.includes(`Lead Export ${suffix}`));

    // Cabeçalho + 2 linhas.
    assert.equal(result.content.split('\n').length, 3);

    // Auditoria obrigatória, com a contagem exata de registros exportados.
    const logs = await AuditLog.findAll({ where: { action: 'data.export' }, transaction });
    const thisExport = logs.filter(
      (log) => log.afterJson && log.afterJson.filters && log.afterJson.filters.personId === person.id
    );
    assert.equal(thisExport.length, 1);
    assert.equal(thisExport[0].afterJson.recordCount, 2);
    assert.equal(thisExport[0].afterJson.exportType, 'crm.opportunities');
    assert.equal(thisExport[0].userId, tenant.userId);
  });
});
