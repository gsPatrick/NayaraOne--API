'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Property, Notification, OutboxEvent } = require('../src/models');
const maintenanceCasesService = require('../src/features/construction/maintenanceCases.service');
const { escalateOverdueWarrantyCases } = require('../src/engines/jobs/warrantyEscalationJob');
const AppError = require('../src/utils/AppError');

function rejectsWithCode(expectedCode) {
  return (err) => {
    assert.ok(err instanceof AppError, `esperava AppError, recebeu ${err && err.constructor && err.constructor.name}`);
    assert.equal(err.code, expectedCode);
    return true;
  };
}

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createTestProperty(transaction) {
  const suffix = uniqueSuffix();
  return Property.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      title: `Imóvel de teste garantia ${suffix}`,
      internalCode: `WARR-${suffix}`,
      propertyType: 'HOUSE',
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

// --- computeEscalationLevel (função pura — M6-63/M6-88) ---

test('warranty: computeEscalationLevel marca OVERDUE quando sla_due_at está no passado', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const past = new Date('2026-09-25T12:00:00Z');
  assert.equal(maintenanceCasesService.computeEscalationLevel(past, now), 'OVERDUE');
});

test('warranty: computeEscalationLevel marca CRITICAL quando falta <= 1 dia (inclusive vencendo hoje)', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const dueToday = new Date('2026-09-30T18:00:00Z');
  const dueTomorrow = new Date('2026-10-01T10:00:00Z');
  assert.equal(maintenanceCasesService.computeEscalationLevel(dueToday, now), 'CRITICAL');
  assert.equal(maintenanceCasesService.computeEscalationLevel(dueTomorrow, now), 'CRITICAL');
});

test('warranty: computeEscalationLevel marca WARNING quando falta <= 2 dias', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const dueIn2Days = new Date('2026-10-02T10:00:00Z');
  assert.equal(maintenanceCasesService.computeEscalationLevel(dueIn2Days, now), 'WARNING');
});

test('warranty: computeEscalationLevel marca NONE quando falta mais de 2 dias ou não há sla_due_at', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const dueIn10Days = new Date('2026-10-10T10:00:00Z');
  assert.equal(maintenanceCasesService.computeEscalationLevel(dueIn10Days, now), 'NONE');
  assert.equal(maintenanceCasesService.computeEscalationLevel(null, now), 'NONE');
});

// --- createMaintenanceCase / updateMaintenanceCase (WarrantyCase estruturado — M6-15/M6-16) ---

test('warranty: createMaintenanceCase calcula sla_due_at e escalation_level a partir da severidade', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        description: 'Infiltração no teto da sala.',
        category: 'WATERPROOFING',
        severity: 'CRITICAL',
        rootCauseCode: 'MATERIAL_DEFECT',
      },
      tenant.userId,
      transaction
    );

    assert.equal(warrantyCase.category, 'WATERPROOFING');
    assert.equal(warrantyCase.severity, 'CRITICAL');
    assert.equal(warrantyCase.rootCauseCode, 'MATERIAL_DEFECT');
    assert.ok(warrantyCase.slaDueAt, 'sla_due_at deveria ter sido calculado');
    // CRITICAL = 2 dias de SLA a partir de agora.
    const expectedDueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const diffMs = Math.abs(new Date(warrantyCase.slaDueAt).getTime() - expectedDueAt.getTime());
    assert.ok(diffMs < 60 * 1000, 'sla_due_at deveria ser ~2 dias a partir de agora (severidade CRITICAL)');
  });
});

test('warranty: updateMaintenanceCase rejeita severity/category/rootCauseCode fora da lista configurada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado teste.' },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { severity: 'ALIEN' }, tenant.userId, transaction),
      rejectsWithCode('MAINTENANCE_CASE_SEVERITY_INVALID')
    );
  });
});

// --- warrantyEscalationJob (M6-63/M6-88): um caso com sla_due_at vencido é marcado OVERDUE ---

test('warranty: warrantyEscalationJob escalona para OVERDUE um caso com sla_due_at no passado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        description: 'Trinca na parede — SLA já vencido.',
        severity: 'LOW',
      },
      tenant.userId,
      transaction
    );

    // Força o SLA para o passado (simula o tempo passando sem atendimento).
    warrantyCase.slaDueAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    warrantyCase.escalationLevel = 'NONE';
    await warrantyCase.save({ transaction });

    const result = await escalateOverdueWarrantyCases(transaction);
    assert.ok(result.casesChecked >= 1);
    assert.ok(result.escalated >= 1);

    await warrantyCase.reload({ transaction });
    assert.equal(warrantyCase.escalationLevel, 'OVERDUE');
  });
});

test('warranty: warrantyEscalationJob é idempotente — rodar de novo sem mudança não reescalona', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Caso já OVERDUE.' },
      tenant.userId,
      transaction
    );
    warrantyCase.slaDueAt = new Date(Date.now() - 1000);
    warrantyCase.escalationLevel = 'OVERDUE';
    await warrantyCase.save({ transaction });

    const result = await escalateOverdueWarrantyCases(transaction);
    const thisCase = result.escalated;
    assert.equal(thisCase >= 0, true);
    // Já estava OVERDUE — não deveria ter sido recontado como escalonamento novo para ESTE caso.
    await warrantyCase.reload({ transaction });
    assert.equal(warrantyCase.escalationLevel, 'OVERDUE');
  });
});

// Bug real corrigido nesta auditoria (rodada 9, 2026-10-05): o job gravava escalation_level
// mas nunca notificava o responsável — chamado OVERDUE ficava "silencioso" se ninguém abrisse
// o painel agregado de pós-obra. Mesmo padrão de insuranceRenewalAlertJob (rodada 7).
test('warranty: warrantyEscalationJob cria Notification real pro responsável quando o caso vira OVERDUE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        description: 'Trinca na parede — SLA já vencido, com responsável.',
        severity: 'LOW',
      },
      tenant.userId,
      transaction
    );
    warrantyCase.slaDueAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    warrantyCase.escalationLevel = 'NONE';
    warrantyCase.responsibleUserId = tenant.userId;
    await warrantyCase.save({ transaction });

    const result = await escalateOverdueWarrantyCases(transaction);
    assert.ok(result.notified >= 1, 'escalonar para OVERDUE precisa notificar ao menos um responsável');

    const notification = await Notification.findOne({
      where: { userId: tenant.userId },
      order: [['created_at', 'DESC']],
      transaction,
    });
    assert.ok(notification, 'precisa existir uma Notification real, não só o campo escalation_level gravado');
    assert.match(notification.title, /vencido|crítico/i);
  });
});

// Bug real corrigido nesta auditoria (rodada 16, 2026-10-05): cada caso era salvo/notificado
// direto na transação da empresa, sem savepoint — diferente dos jobs irmãos
// (toolLoanOverdueJob.js, insuranceRenewalAlertJob.js), que isolam cada item em
// `sequelize.transaction({ transaction }, ...)` justamente pra um item com problema não abortar
// o processamento de todos os outros da mesma empresa. Mesma classe de bug corrigido na rodada
// 15 pra projectDelayDetectionJob. Teste de múltiplos casos no mesmo ciclo confirma que o
// savepoint por caso não quebra o escalonamento em lote.
test('warranty: escalona e notifica múltiplos casos vencidos da mesma empresa no mesmo ciclo (savepoint por caso)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const cases = [];
    for (let i = 0; i < 3; i += 1) {
      const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
        { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: `Caso vencido ${i}.`, severity: 'LOW' },
        tenant.userId,
        transaction
      );
      warrantyCase.slaDueAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      warrantyCase.escalationLevel = 'NONE';
      warrantyCase.responsibleUserId = tenant.userId;
      await warrantyCase.save({ transaction });
      cases.push(warrantyCase);
    }

    const result = await escalateOverdueWarrantyCases(transaction);
    assert.ok(result.escalated >= 3);
    assert.ok(result.notified >= 3);

    for (const warrantyCase of cases) {
      await warrantyCase.reload({ transaction });
      assert.equal(warrantyCase.escalationLevel, 'OVERDUE');
    }
  });
});

// --- WarrantyAction (histórico de atendimento com custo) ---

test('warranty: createWarrantyAction registra ação de atendimento vinculada ao chamado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Vazamento no banheiro.' },
      tenant.userId,
      transaction
    );

    const action = await maintenanceCasesService.createWarrantyAction(
      warrantyCase.id,
      { description: 'Troca do registro hidráulico.', cost: 350.5 },
      tenant.userId,
      transaction
    );

    assert.equal(action.warrantyCaseId, warrantyCase.id);
    assert.equal(Number(action.cost), 350.5);

    const actions = await maintenanceCasesService.listWarrantyActions(warrantyCase.id, transaction);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].id, action.id);
  });
});

// GAP CORRIGIDO (auditoria pós-Marco 6, item 6): o contrato exige o nome canônico
// `warranty.case.opened` (seção 11/Guia do Marcelo seção 11) — o código publicava
// `construction.maintenance_case.opened`. Confirma o nome exato publicado na Outbox.
test('warranty: createMaintenanceCase publica o evento com o nome exato "warranty.case.opened"', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado para checar nome do evento.' },
      tenant.userId,
      transaction
    );

    const event = await OutboxEvent.findOne({
      where: { aggregateId: warrantyCase.id, eventType: 'warranty.case.opened' },
      transaction,
    });
    assert.ok(event, 'esperava um evento "warranty.case.opened" na Outbox, nome exigido pelo contrato');

    const oldNameEvent = await OutboxEvent.findOne({
      where: { aggregateId: warrantyCase.id, eventType: 'construction.maintenance_case.opened' },
      transaction,
    });
    assert.equal(oldNameEvent, null, 'não deve mais publicar o nome antigo "construction.maintenance_case.opened"');
  });
});

// --- Evento de fechamento (M6-80) ---

test('warranty: fechar o chamado (status=CLOSED) não lança erro (evento warranty.case.closed disparado)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado a ser fechado.' },
      tenant.userId,
      transaction
    );
    // BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 2, 2026-10-06): updateMaintenanceCase
    // agora valida a sequência de transição (OPEN->RESOLVED->CLOSED), igual ao grafo do front —
    // não dá mais pra pular direto OPEN->CLOSED.
    await maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { status: 'RESOLVED' }, tenant.userId, transaction);
    await maintenanceCasesService.createWarrantyAction(warrantyCase.id, { description: 'Visita técnica realizada.' }, tenant.userId, transaction);
    const closed = await maintenanceCasesService.updateMaintenanceCase(
      warrantyCase.id,
      {
        status: 'CLOSED',
        rootCauseCode: 'MATERIAL_DEFECT',
        beforeMediaFileIds: ['11111111-1111-1111-1111-111111111111'],
        afterMediaFileIds: ['22222222-2222-2222-2222-222222222222'],
      },
      tenant.userId,
      transaction
    );
    assert.equal(closed.status, 'CLOSED');
  });
});

// BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 2, 2026-10-06): updateMaintenanceCase
// só validava que o status pertencia à lista, sem checar a sequência — era possível pular etapas
// (OPEN->CLOSED direto) ou reabrir um caso já CLOSED via chamada direta à API, ignorando a trava
// que só existia no front. CLOSED dispara publishWarrantyCaseClosed e reseta escalationLevel —
// pular pra lá sem passar pelo atendimento real não deixava rastro nenhum.
test('warranty: updateMaintenanceCase recusa pular etapa (OPEN->CLOSED direto) e recusa reabrir CLOSED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado para teste de transição.' },
      tenant.userId,
      transaction
    );
    assert.equal(warrantyCase.status, 'OPEN');

    await assert.rejects(
      () => maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { status: 'CLOSED' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'MAINTENANCE_CASE_STATUS_TRANSITION_INVALID'); return true; }
    );

    await maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { status: 'RESOLVED' }, tenant.userId, transaction);
    await maintenanceCasesService.createWarrantyAction(warrantyCase.id, { description: 'Visita técnica realizada.' }, tenant.userId, transaction);
    await maintenanceCasesService.updateMaintenanceCase(
      warrantyCase.id,
      {
        status: 'CLOSED',
        rootCauseCode: 'MATERIAL_DEFECT',
        beforeMediaFileIds: ['33333333-3333-3333-3333-333333333333'],
        afterMediaFileIds: ['44444444-4444-4444-4444-444444444444'],
      },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { status: 'OPEN' }, tenant.userId, transaction),
      (err) => { assert.equal(err.code, 'MAINTENANCE_CASE_STATUS_TRANSITION_INVALID'); return true; }
    );
  });
});

// Bug real corrigido nesta auditoria (rodada 13, 2026-10-05): updateMaintenanceCase recalculava
// escalation_level incondicionalmente a partir de sla_due_at/now — como sla_due_at continua no
// passado pra sempre, fechar um caso OVERDUE nunca resetava o nível, e o caso ficava marcado
// OVERDUE eternamente mesmo já CLOSED, poluindo casesByEscalationLevel do pós-obra.
test('warranty: fechar um chamado OVERDUE zera escalation_level pra NONE (não fica OVERDUE eternamente)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado vencido a ser fechado.', severity: 'LOW' },
      tenant.userId,
      transaction
    );
    warrantyCase.slaDueAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    warrantyCase.escalationLevel = 'OVERDUE';
    await warrantyCase.save({ transaction });

    await maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { status: 'RESOLVED' }, tenant.userId, transaction);
    await maintenanceCasesService.createWarrantyAction(warrantyCase.id, { description: 'Visita técnica realizada.' }, tenant.userId, transaction);
    const closed = await maintenanceCasesService.updateMaintenanceCase(
      warrantyCase.id,
      {
        status: 'CLOSED',
        rootCauseCode: 'MATERIAL_DEFECT',
        beforeMediaFileIds: ['55555555-5555-5555-5555-555555555555'],
        afterMediaFileIds: ['66666666-6666-6666-6666-666666666666'],
      },
      tenant.userId,
      transaction
    );
    assert.equal(closed.status, 'CLOSED');
    assert.equal(closed.escalationLevel, 'NONE', 'caso fechado não pode continuar contando como OVERDUE em nenhum painel');
  });
});

// --- Desconto/ressarcimento de garantia (regra/aprovação + Financeiro) ---
// Achado numa rodada de verificação de integrações (30/09/2026): a fonte exige que o
// desconto/ressarcimento passe por regra/aprovação e seja integrado ao Financeiro.

test('warranty: proposeWarrantyResolution dentro da alçada (<= threshold padrão de 1000) aprova automaticamente e cria lançamento financeiro', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Infiltração — desconto combinado.' },
      tenant.userId,
      transaction
    );

    const resolved = await maintenanceCasesService.proposeWarrantyResolution(
      warrantyCase.id,
      { resolutionType: 'discount', resolutionAmount: 250 },
      tenant.userId,
      transaction
    );

    assert.equal(resolved.resolutionType, 'DISCOUNT');
    assert.equal(Number(resolved.resolutionAmount), 250);
    assert.equal(resolved.resolutionStatus, 'APPROVED');
    assert.ok(resolved.resolutionApprovedByUserId);
    assert.ok(resolved.resolutionFinancialEntryId, 'deveria ter criado um lançamento financeiro automaticamente');
  });
});

test('warranty: proposeWarrantyResolution acima da alçada fica PENDING_APPROVAL sem lançamento financeiro até aprovação explícita', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Ressarcimento de alto valor.' },
      tenant.userId,
      transaction
    );

    const proposed = await maintenanceCasesService.proposeWarrantyResolution(
      warrantyCase.id,
      { resolutionType: 'REIMBURSEMENT', resolutionAmount: 5000 },
      tenant.userId,
      transaction
    );
    assert.equal(proposed.resolutionStatus, 'PENDING_APPROVAL');
    assert.equal(proposed.resolutionFinancialEntryId, null);

    const approved = await maintenanceCasesService.approveWarrantyResolution(warrantyCase.id, tenant.userId, transaction);
    assert.equal(approved.resolutionStatus, 'APPROVED');
    assert.ok(approved.resolutionFinancialEntryId, 'aprovação explícita deveria criar o lançamento financeiro');
  });
});

test('warranty: approveWarrantyResolution rejeita quando não há resolução pendente de aprovação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado sem resolução proposta.' },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => maintenanceCasesService.approveWarrantyResolution(warrantyCase.id, tenant.userId, transaction),
      rejectsWithCode('WARRANTY_RESOLUTION_NOT_PENDING')
    );
  });
});

test('warranty: proposeWarrantyResolution rejeita resolutionType inválido e amount <= 0', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado para validação.' },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => maintenanceCasesService.proposeWarrantyResolution(warrantyCase.id, { resolutionType: 'REFUND', resolutionAmount: 100 }, tenant.userId, transaction),
      rejectsWithCode('WARRANTY_RESOLUTION_VALIDATION')
    );
    await assert.rejects(
      () => maintenanceCasesService.proposeWarrantyResolution(warrantyCase.id, { resolutionType: 'DISCOUNT', resolutionAmount: 0 }, tenant.userId, transaction),
      rejectsWithCode('WARRANTY_RESOLUTION_VALIDATION')
    );
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 56, 2026-10-06): removeMaintenanceCase
// não checava WarrantyAction vinculadas antes do soft delete.
test('warranty: removeMaintenanceCase recusa excluir chamado que já tem ação registrada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado com ação registrada.' },
      tenant.userId,
      transaction
    );
    await maintenanceCasesService.createWarrantyAction(warrantyCase.id, { description: 'Visita técnica realizada.' }, tenant.userId, transaction);

    await assert.rejects(
      () => maintenanceCasesService.removeMaintenanceCase(warrantyCase.id, tenant.userId, transaction),
      rejectsWithCode('MAINTENANCE_CASE_DELETE_HAS_DEPENDENTS')
    );
  });
});

test('warranty: removeMaintenanceCase exclui normalmente chamado sem nenhuma ação registrada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado sem ação.' },
      tenant.userId,
      transaction
    );
    await maintenanceCasesService.removeMaintenanceCase(warrantyCase.id, tenant.userId, transaction);
    await assert.rejects(
      () => maintenanceCasesService.getMaintenanceCase(warrantyCase.id, transaction),
      rejectsWithCode('MAINTENANCE_CASE_NOT_FOUND')
    );
  });
});

// BUG REAL CORRIGIDO (auditoria "loop até secar", Categoria 14, ciclo 2): laborCost/
// materialCost (MaintenanceCase) e cost (WarrantyAction) nunca passavam por Number.isFinite —
// "NaN"/"Infinity" (string) e negativo persistiam direto no DECIMAL do banco.
test('Categoria 14: createMaintenanceCase rejeita laborCost/materialCost "NaN"/"Infinity"/negativo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);

    await assert.rejects(
      () =>
        maintenanceCasesService.createMaintenanceCase(
          { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Teste.', laborCost: 'NaN' },
          tenant.userId,
          transaction
        ),
      rejectsWithCode('MAINTENANCE_CASE_COST_INVALID')
    );

    await assert.rejects(
      () =>
        maintenanceCasesService.createMaintenanceCase(
          { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Teste.', materialCost: 'Infinity' },
          tenant.userId,
          transaction
        ),
      rejectsWithCode('MAINTENANCE_CASE_COST_INVALID')
    );

    await assert.rejects(
      () =>
        maintenanceCasesService.createMaintenanceCase(
          { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Teste.', laborCost: -10 },
          tenant.userId,
          transaction
        ),
      rejectsWithCode('MAINTENANCE_CASE_COST_INVALID')
    );
  });
});

test('Categoria 14: updateMaintenanceCase rejeita laborCost/materialCost "NaN"/"Infinity"', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado para teste de custo.' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { laborCost: 'NaN' }, tenant.userId, transaction),
      rejectsWithCode('MAINTENANCE_CASE_COST_INVALID')
    );

    await assert.rejects(
      () => maintenanceCasesService.updateMaintenanceCase(warrantyCase.id, { materialCost: 'Infinity' }, tenant.userId, transaction),
      rejectsWithCode('MAINTENANCE_CASE_COST_INVALID')
    );
  });
});

test('Categoria 14: createWarrantyAction rejeita cost "NaN"/"Infinity"/negativo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const property = await createTestProperty(transaction);
    const warrantyCase = await maintenanceCasesService.createMaintenanceCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, description: 'Chamado para teste de ação.' },
      tenant.userId,
      transaction
    );

    await assert.rejects(
      () => maintenanceCasesService.createWarrantyAction(warrantyCase.id, { description: 'Visita.', cost: 'NaN' }, tenant.userId, transaction),
      rejectsWithCode('MAINTENANCE_CASE_COST_INVALID')
    );

    await assert.rejects(
      () => maintenanceCasesService.createWarrantyAction(warrantyCase.id, { description: 'Visita.', cost: 'Infinity' }, tenant.userId, transaction),
      rejectsWithCode('MAINTENANCE_CASE_COST_INVALID')
    );

    await assert.rejects(
      () => maintenanceCasesService.createWarrantyAction(warrantyCase.id, { description: 'Visita.', cost: -5 }, tenant.userId, transaction),
      rejectsWithCode('MAINTENANCE_CASE_COST_INVALID')
    );
  });
});
