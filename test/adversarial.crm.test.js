'use strict';

/**
 * M3-24 — testes ADVERSARIAIS do CRM.
 *
 * Cada teste é uma tentativa GENUÍNA de abuso: id de outro tenant, payload forjado, campo
 * imutável reescrito, enum burlado, injeção de SQL em texto livre, corrida real de
 * concorrência, exportação sem permissão, agenda no passado. Rodam contra o banco REAL pelo
 * mesmo caminho de RLS da aplicação (SET LOCAL app.group_id/company_id/user_id).
 *
 * NÃO duplicam o que já existe: marco3.crm.test.js (M3-12 enums de desfecho, M3-13 máquina de
 * estados/versionamento, M3-15 explain, M3-17 painel, M3-20 SLA, M3-21 exportação feliz),
 * marco3.batch2.test.js (M3-11/M3-16/M3-19) e homologacaoEvidencias.test.js.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const offersService = require('../src/features/properties/propertyOffers.service');
const opportunitiesService = require('../src/features/crm/opportunities.service');
const proposalsService = require('../src/features/crm/proposals.service');
const visitsService = require('../src/features/crm/visits.service');
const messagesService = require('../src/features/crm/messages.service');
const feedbackCasesService = require('../src/features/crm/feedbackCases.service');
const exportService = require('../src/features/crm/opportunitiesExport.service');
const opportunityTasksService = require('../src/features/crm/opportunityTasks.service');
const { getOpportunityTimeline } = require('../src/features/crm/opportunityTimeline.service');
const radarService = require('../src/features/radar/radar.service');
const { Opportunity, Proposal, Company, User, Message } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

const FUTURE = (ms = 86400000) => new Date(Date.now() + ms);
const PAST = (ms = 86400000) => new Date(Date.now() - ms);

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

async function createNeighborCompany(transaction, suffix) {
  return Company.create(
    { groupId: tenant.groupId, name: `QA ADV CRM — Empresa vizinha ${suffix}`, status: 'ACTIVE' },
    { transaction }
  );
}

// --- Isolamento entre empresas (RLS real) --------------------------------------------------

test('ADV-C01 oportunidade de outra empresa não é lida nem por id nem por listagem (RLS bloqueia no banco)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C01 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);
    const vizinha = await createNeighborCompany(transaction, suffix);

    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: vizinha.id }, transaction });

    assert.equal(await Opportunity.findByPk(opportunity.id, { transaction }), null);
    await assert.rejects(
      () => opportunitiesService.getOpportunity(opportunity.id, transaction),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_NOT_FOUND');
        assert.equal(err.statusCode, 404, 'precisa ser 404 — 403 já confirmaria que o registro existe');
        return true;
      }
    );
    const listadas = await opportunitiesService.listOpportunities(transaction);
    assert.equal(listadas.some((o) => o.id === opportunity.id), false);

    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
  });
});

test('ADV-C02 forjar companyId no payload da oportunidade (plantar lead na empresa vizinha) é barrado pelo banco', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C02 ${suffix}`);
    const vizinha = await createNeighborCompany(transaction, suffix);

    await assert.rejects(
      () => createActiveOpportunity(transaction, person.id, { companyId: vizinha.id }),
      (err) => {
        assert.match(String(err.message), /row-level security|política|policy/i);
        return true;
      }
    );
  });
});

test('ADV-C03 criar proposta apontando para uma oportunidade de OUTRA empresa é 404, nunca uma proposta órfã', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C03 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);
    const vizinha = await createNeighborCompany(transaction, suffix);

    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: vizinha.id }, transaction });

    await assert.rejects(
      () =>
        proposalsService.createProposal(
          {
            groupId: tenant.groupId,
            companyId: vizinha.id,
            opportunityId: opportunity.id,
            value: 500000,
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_NOT_FOUND');
        return true;
      }
    );

    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });

    // E nada foi criado: a oportunidade continua sem nenhuma proposta.
    const propostas = await proposalsService.listProposals(transaction, { opportunityId: opportunity.id });
    assert.equal(propostas.length, 0);
  });
});

test('ADV-C04 timeline não mistura conversas: mensagem de uma oportunidade não aparece na timeline de outra', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C04 ${suffix}`);
    const alvo = await createActiveOpportunity(transaction, person.id);
    const outra = await createActiveOpportunity(transaction, person.id);

    const message = await messagesService.createMessage(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        opportunityId: outra.id,
        direction: 'INBOUND',
        authorType: 'CLIENT',
        body: `Segredo da outra negociação ${suffix}`,
      },
      tenant.userId,
      transaction
    );

    const timeline = await getOpportunityTimeline(alvo.id, transaction);
    assert.equal(timeline.some((item) => item.id === message.id), false);
    assert.equal(timeline.some((item) => String(JSON.stringify(item.data)).includes('Segredo da outra')), false);
  });
});

// --- Imutabilidade / integridade dos dados de negociação ------------------------------------

test('ADV-C05 alterar o `value` de uma proposta já ENVIADA é recusado e o valor persistido não muda', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C05 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);
    const proposal = await proposalsService.createProposal(
      { groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opportunity.id, value: 500000, status: 'SENT' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () =>
        proposalsService.updateProposalStatus(
          proposal.id,
          { status: 'UNDER_NEGOTIATION', value: 100 },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, 'PROPOSAL_VALUE_IMMUTABLE');
        return true;
      }
    );

    const persisted = await Proposal.findByPk(proposal.id, { transaction });
    assert.equal(Number(persisted.value), 500000, 'nem o valor nem o status podem ter mudado na tentativa recusada');
    assert.equal(persisted.status, 'SENT');
  });
});

test('ADV-C06 proposta com valor zero, negativo ou não numérico é recusada (não existe negociação de R$ 0)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C06 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    for (const value of [0, -1, -999999.99, 'quinhentos mil']) {
      await assert.rejects(
        () =>
          proposalsService.createProposal(
            { groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opportunity.id, value },
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.equal(err.code, 'PROPOSAL_VALIDATION', `value=${value} deveria ser recusado`);
          return true;
        }
      );
    }
  });
});

test('ADV-C07 nascer com proposta já ACCEPTED (pular a negociação inteira) é recusado', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C07 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    for (const status of ['ACCEPTED', 'REJECTED', 'EXPIRED']) {
      await assert.rejects(
        () =>
          proposalsService.createProposal(
            { groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opportunity.id, value: 1000, status },
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.equal(err.code, 'PROPOSAL_INVALID_INITIAL_STATUS');
          return true;
        }
      );
    }
  });
});

test('ADV-C08 duas propostas CONCORRENTES na mesma oportunidade viram versões DISTINTAS, sem corromper a numeração', async () => {
  const suffix = uniqueSuffix();
  const criado = {};
  try {
    Object.assign(
      criado,
      await withCommittedTenantTransaction(tenant, async (transaction) => {
        const person = await createLead(transaction, `ADV C08 ${suffix}`);
        const opportunity = await createActiveOpportunity(transaction, person.id);
        return { personId: person.id, opportunityId: opportunity.id };
      })
    );

    const payload = (value) => ({
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      opportunityId: criado.opportunityId,
      value,
    });

    // Corrida REAL: duas transações commitadas em paralelo criando proposta para a mesma
    // oportunidade (duas abas do corretor, ou dois corretores ao mesmo tempo).
    const results = await Promise.allSettled([
      withCommittedTenantTransaction(tenant, (t) => proposalsService.createProposal(payload(400000), tenant.userId, t)),
      withCommittedTenantTransaction(tenant, (t) => proposalsService.createProposal(payload(410000), tenant.userId, t)),
    ]);

    const persisted = await withCommittedTenantTransaction(tenant, (t) =>
      Proposal.findAll({ where: { opportunityId: criado.opportunityId }, transaction: t })
    );

    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    assert.ok(okCount >= 1, 'ao menos uma das duas criações concorrentes precisa ter sucesso');
    assert.equal(persisted.length, okCount, 'nenhuma proposta pode ter sido gravada por uma tentativa que falhou');

    // O invariante que importa: nunca duas linhas com a MESMA versão na mesma oportunidade,
    // e nenhuma proposta perde/sobrescreve o valor da outra.
    const versions = persisted.map((p) => p.versionNumber);
    assert.equal(new Set(versions).size, versions.length, `versões duplicadas: ${versions.join(',')}`);
    const values = persisted.map((p) => Number(p.value)).sort();
    assert.deepEqual(values, results.filter((r) => r.status === 'fulfilled').map((r) => Number(r.value.value)).sort());
  } finally {
    await withCommittedTenantTransaction(tenant, async (t) => {
      if (criado.opportunityId) {
        await sequelize.query('DELETE FROM "crm"."proposals" WHERE opportunity_id = :id', {
          replacements: { id: criado.opportunityId },
          transaction: t,
        });
        await sequelize.query('DELETE FROM "crm"."opportunities" WHERE id = :id', {
          replacements: { id: criado.opportunityId },
          transaction: t,
        });
      }
      if (criado.personId) {
        await sequelize.query('DELETE FROM "people"."persons" WHERE id = :id', {
          replacements: { id: criado.personId },
          transaction: t,
        });
      }
    });
  }
});

// --- Enums, texto livre e agenda -----------------------------------------------------------

test('ADV-C09 injeção de SQL em campo de texto livre é gravada como TEXTO, não executada', async () => {
  const suffix = uniqueSuffix();
  const injection = `'; DROP TABLE crm.opportunities; -- ${suffix}`;
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C09 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id, { nextAction: injection });
    assert.equal(opportunity.nextAction, injection, 'o texto precisa ser gravado literalmente');

    const feedbackCase = await feedbackCasesService.createFeedbackCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        type: 'COMPLAINT',
        description: injection,
        severity: 'LOW',
      },
      tenant.userId,
      transaction
    );
    assert.equal(feedbackCase.description, injection);

    // A tabela continua de pé e o registro continua legível — nada foi executado.
    const [row] = await sequelize.query('SELECT count(*)::int AS total FROM "crm"."opportunities"', {
      type: sequelize.QueryTypes.SELECT,
      transaction,
    });
    assert.ok(row.total >= 1);
    assert.equal((await opportunitiesService.getOpportunity(opportunity.id, transaction)).nextAction, injection);
  });
});

test('ADV-C10 feedback case com severity inválida (inclusive "CRITICAL", que parece plausível) é recusado', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C10 ${suffix}`);

    for (const severity of ['CRITICAL', 'URGENTISSIMO', 'low-ish', '0', 'null']) {
      await assert.rejects(
        () =>
          feedbackCasesService.createFeedbackCase(
            {
              groupId: tenant.groupId,
              companyId: tenant.companyId,
              personId: person.id,
              type: 'COMPLAINT',
              description: 'Atendimento ruim.',
              severity,
            },
            tenant.userId,
            transaction
          ),
        (err) => {
          assert.equal(err.code, 'FEEDBACK_CASE_VALIDATION', `severity=${severity} deveria ser recusada`);
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    }
  });
});

test('ADV-C11 escalar um caso JÁ RESOLVIDO é recusado (e não cria notificação de escalonamento)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C11 ${suffix}`);
    const feedbackCase = await feedbackCasesService.createFeedbackCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        type: 'CONFLICT',
        description: 'Conflito entre locador e locatário.',
        severity: 'HIGH',
        assignedToUserId: tenant.userId,
      },
      tenant.userId,
      transaction
    );
    await feedbackCasesService.resolveFeedbackCase(feedbackCase.id, { resolutionNotes: 'Acordo feito.' }, tenant.userId, transaction);

    await assert.rejects(
      () => feedbackCasesService.escalateFeedbackCase(feedbackCase.id, { automatic: false }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, 'FEEDBACK_CASE_ALREADY_RESOLVED');
        return true;
      }
    );
    // Resolver duas vezes também não é aceito (evita reescrever o resolvedAt original).
    await assert.rejects(
      () => feedbackCasesService.resolveFeedbackCase(feedbackCase.id, {}, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'FEEDBACK_CASE_ALREADY_RESOLVED');
        return true;
      }
    );

    const persisted = await feedbackCasesService.getFeedbackCase(feedbackCase.id, transaction);
    assert.equal(persisted.status, 'RESOLVED');
    assert.equal(persisted.escalatedAt, null);
  });
});

test('ADV-C12 mensagem com canal inventado é recusada (o histórico omnichannel não aceita canal livre)', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C12 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    const base = {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personId: person.id,
      opportunityId: opportunity.id,
      direction: 'INBOUND',
      authorType: 'CLIENT',
      body: 'oi',
    };

    for (const channel of ['ZAP', 'whatsap', 'POMBO_CORREIO', 'TELEGRAM']) {
      await assert.rejects(
        () => messagesService.createMessage({ ...base, channel }, tenant.userId, transaction),
        (err) => {
          assert.equal(err.code, 'MESSAGE_VALIDATION', `channel=${channel} deveria ser recusado`);
          return true;
        }
      );
    }

    // E o canal válido em minúsculas continua funcionando (normalizado, não recusado).
    const ok = await messagesService.createMessage({ ...base, channel: 'email' }, tenant.userId, transaction);
    assert.equal(ok.channel, 'EMAIL');
  });
});

test('ADV-C13 visita agendada para o PASSADO é recusada, mas registrar uma visita que já ocorreu (DONE) continua valendo', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C13 ${suffix}`);
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel ADV C13 ${suffix}`,
        internalCode: `ADVC13-${suffix}`,
        propertyType: 'RESIDENTIAL',
        city: `CidadeC13${suffix}`,
      },
      tenant.userId,
      transaction
    );
    const base = {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      propertyId: property.id,
      personId: person.id,
    };

    await assert.rejects(
      () => visitsService.createVisit({ ...base, scheduledAt: PAST(7 * 86400000) }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, 'VISIT_SCHEDULED_IN_THE_PAST');
        return true;
      }
    );

    const realizada = await visitsService.createVisit(
      { ...base, scheduledAt: PAST(7 * 86400000), status: 'DONE', feedback: 'Cliente gostou.' },
      tenant.userId,
      transaction
    );
    assert.equal(realizada.status, 'DONE');

    // Reagendar uma visita futura para o passado também é recusado.
    const futura = await visitsService.createVisit({ ...base, scheduledAt: FUTURE() }, tenant.userId, transaction);
    await assert.rejects(
      () => visitsService.updateVisit(futura.id, { scheduledAt: PAST() }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'VISIT_SCHEDULED_IN_THE_PAST');
        return true;
      }
    );
  });
});

test('ADV-C14 fechar como CLOSED_WON enviando lostReason (motivo do desfecho errado) não passa', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C14 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    await assert.rejects(
      () =>
        opportunitiesService.updateOpportunity(
          opportunity.id,
          { stage: 'CLOSED_WON', lostReason: 'PRICE' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.statusCode, 422);
        assert.ok(String(err.code).startsWith('OPPORTUNITY_OUTCOME_REASON'));
        return true;
      }
    );

    const persisted = await opportunitiesService.getOpportunity(opportunity.id, transaction);
    assert.equal(persisted.stage, 'QUALIFYING', 'a oportunidade não pode ter sido fechada pela tentativa recusada');
    assert.equal(persisted.closedAt, null);
  });
});

// --- Permissão, identidade e Radar ---------------------------------------------------------

test('ADV-C15 exportar a base com apenas crm:opportunities:read (sem a permissão dedicada) é 403', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C15 ${suffix}`);
    await createActiveOpportunity(transaction, person.id);

    for (const permissions of [[], ['crm:opportunities:read'], ['crm:opportunities:update', 'crm:proposals:read'], undefined]) {
      await assert.rejects(
        () =>
          exportService.exportOpportunities(
            {
              groupId: tenant.groupId,
              companyId: tenant.companyId,
              actorUserId: tenant.userId,
              actorPermissions: permissions,
              format: 'csv',
            },
            transaction
          ),
        (err) => {
          assert.equal(err.statusCode, 403);
          assert.equal(err.code, 'PERMISSION_DENIED');
          return true;
        },
        `permissões=${JSON.stringify(permissions)} não deveriam permitir exportar`
      );
    }
  });
});

test('ADV-C16 usuário SUSPENSO não pode ser escalado como responsável por tarefa de oportunidade', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C16 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    const suspenso = await User.create(
      {
        name: `QA ADV suspenso ${suffix}`,
        email: `qa.adv.suspenso.${suffix}@nayaraone.dev`,
        passwordHash: 'x'.repeat(60),
        status: 'SUSPENDED',
      },
      { transaction }
    );

    await assert.rejects(
      () =>
        opportunityTasksService.createOpportunityTask(
          opportunity.id,
          { title: 'Ligar para o cliente', assignedToUserId: suspenso.id },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.statusCode, 422);
        assert.equal(err.code, 'OPPORTUNITY_TASK_ASSIGNEE_NOT_ACTIVE');
        return true;
      }
    );

    const tarefas = await opportunityTasksService.listOpportunityTasks(opportunity.id, transaction);
    assert.equal(tarefas.length, 0, 'nenhuma tarefa pode ter sido criada na tentativa recusada');
  });
});

test('ADV-C17 radar com critérios contraditórios (minPrice > maxPrice) NUNCA dá match — nem por acaso', async () => {
  const suffix = uniqueSuffix();
  const city = `AdvRadar${suffix}`;
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C17 ${suffix}`);
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel ADV C17 ${suffix}`,
        internalCode: `ADVC17-${suffix}`,
        propertyType: 'RESIDENTIAL',
        city,
        areaTotalM2: 100,
      },
      tenant.userId,
      transaction
    );
    await offersService.createOffer(property.id, { offerType: 'SALE', askingPrice: 500000 }, tenant.userId, transaction);

    const { radar, matches } = await radarService.createRadar(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        // Faixa impossível: piso ACIMA do teto.
        criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city, minPrice: 900000, maxPrice: 100000 },
      },
      tenant.userId,
      transaction
    );

    assert.equal(matches.length, 0, 'faixa de preço impossível não pode produzir match');
    assert.deepEqual(await radarService.getRadarMatches(radar.id, transaction), []);

    // E a explicação deixa claro que o critério de preço é o que barra (não é um match "quase").
    const explanation = await radarService.explainRadarMatch(radar.id, property.id, transaction);
    assert.equal(explanation.matched, false);
    assert.equal(explanation.criteria.priceRange.matched, false);

    // Mesma faixa impossível também não bate com área contraditória.
    await radarService.updateRadar(
      radar.id,
      { criteriaJson: { propertyType: 'RESIDENTIAL', offerType: 'SALE', city, minAreaM2: 500, maxAreaM2: 50 } },
      tenant.userId,
      transaction
    );
    assert.deepEqual(await radarService.getRadarMatches(radar.id, transaction), []);
  });
});

test('ADV-C18 dedupe de webhook por externalMessageId não vaza mensagem entre empresas', async () => {
  const suffix = uniqueSuffix();
  const externalMessageId = `wamid.QA-ADV-${suffix}`;
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C18 ${suffix}`);
    const original = await messagesService.createMessage(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        direction: 'INBOUND',
        authorType: 'CLIENT',
        body: `Conteúdo privado da empresa A ${suffix}`,
        externalMessageId,
      },
      tenant.userId,
      transaction
    );

    // Reenvio do MESMO webhook no MESMO tenant: dedupe (não cria duplicata).
    const replay = await messagesService.createMessage(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: person.id,
        direction: 'INBOUND',
        authorType: 'CLIENT',
        body: 'tentativa de sobrescrever o corpo',
        externalMessageId,
      },
      tenant.userId,
      transaction
    );
    assert.equal(replay.id, original.id);
    assert.equal(replay.body, original.body, 'o replay não pode reescrever o corpo da mensagem original');

    // Já de OUTRA empresa, o mesmo externalMessageId não pode devolver a mensagem alheia.
    const vizinha = await createNeighborCompany(transaction, suffix);
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: vizinha.id }, transaction });
    const vazou = await Message.findOne({ where: { externalMessageId }, transaction });
    assert.equal(vazou, null, 'o dedupe por id externo não pode ser um canal de leitura entre tenants');
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
  });
});

test('ADV-C19 oportunidade excluída (soft delete) some da listagem, do painel e da consulta por id', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C19 ${suffix}`);
    const opportunity = await createActiveOpportunity(transaction, person.id);

    await opportunitiesService.deleteOpportunity(opportunity.id, tenant.userId, transaction);

    await assert.rejects(
      () => opportunitiesService.getOpportunity(opportunity.id, transaction),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_NOT_FOUND');
        return true;
      }
    );
    const listadas = await opportunitiesService.listOpportunities(transaction, { personId: person.id });
    assert.equal(listadas.some((o) => o.id === opportunity.id), false);

    // E nem por caminho lateral: criar proposta para uma oportunidade excluída é 404.
    await assert.rejects(
      () =>
        proposalsService.createProposal(
          { groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opportunity.id, value: 1000 },
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

test('ADV-C20 temperature inventada é recusada e estágio desconhecido nunca vira atalho para fechar a oportunidade', async () => {
  const suffix = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await createLead(transaction, `ADV C20 ${suffix}`);

    await assert.rejects(
      () => createActiveOpportunity(transaction, person.id, { temperature: 'FERVENDO' }),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_VALIDATION');
        return true;
      }
    );

    // `stage` é livre POR DECISÃO (funil configurável por tenant — ver
    // opportunityNextAction.validator.js), então um estágio inventado não é recusado. O que
    // NÃO pode acontecer é ele virar um atalho para "fechar" a oportunidade: o validador é
    // fail-closed e trata qualquer estágio desconhecido como ATIVO — ou seja, continua
    // exigindo próxima ação e nunca carimba closedAt/motivo de desfecho.
    await assert.rejects(
      () =>
        opportunitiesService.createOpportunity(
          {
            groupId: tenant.groupId,
            companyId: tenant.companyId,
            personId: person.id,
            stage: 'ESTAGIO_INVENTADO',
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'OPPORTUNITY_NEXT_ACTION_REQUIRED');
        return true;
      }
    );

    const inventada = await createActiveOpportunity(transaction, person.id, { stage: 'ESTAGIO_INVENTADO' });
    assert.equal(inventada.closedAt, null, 'estágio desconhecido nunca pode fechar a oportunidade');
    assert.equal(inventada.wonReason, null);
    assert.equal(inventada.lostReason, null);
    assert.equal(inventada.withdrawnReason, null);
  });
});
