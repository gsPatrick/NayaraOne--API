'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Publicação dos domain events do módulo construction (Transactional Outbox), seguindo o
// mesmo padrão de src/features/legal/legalEvents.service.js e financeEvents.service.js —
// sempre dentro da MESMA transação da operação de negócio.

function publishProjectCreated(project, transaction) {
  return publishDomainEvent(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      aggregateType: 'Project',
      aggregateId: project.id,
      eventType: 'construction.project.created',
      payload: { id: project.id, name: project.name, status: project.status },
      idempotencyKey: `construction.project.created:${project.id}`,
    },
    transaction
  );
}

function publishProjectStatusChanged(project, fromStatus, transaction) {
  return publishDomainEvent(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      aggregateType: 'Project',
      aggregateId: project.id,
      eventType: 'construction.project.status_changed',
      payload: { id: project.id, fromStatus, toStatus: project.status },
      idempotencyKey: `construction.project.status_changed:${project.id}:${fromStatus}:${project.status}`,
    },
    transaction
  );
}

function publishStageMeasurementDecided(measurement, transaction) {
  return publishDomainEvent(
    {
      groupId: measurement.groupId,
      companyId: measurement.companyId,
      aggregateType: 'StageMeasurement',
      aggregateId: measurement.id,
      eventType: 'construction.stage_measurement.decided',
      payload: { id: measurement.id, projectStageId: measurement.projectStageId, status: measurement.status, measuredPct: measurement.measuredPct },
      idempotencyKey: `construction.stage_measurement.decided:${measurement.id}:${measurement.status}`,
    },
    transaction
  );
}

// M6-10 — eventos de domínio dos estados de "meio de caminho" da máquina de estados completa
// da medição (DRAFT -> SUBMITTED -> REVIEWED -> APPROVED -> PAYABLE). Nomes EXATOS pedidos no
// escopo, sem prefixo "construction." (diferente dos demais eventos deste arquivo — decisão
// deliberada para casar com o nome de evento já esperado por quem consome, ex.: testes/outros
// agentes do Marco 6).
function publishMeasurementSubmitted(measurement, transaction) {
  return publishDomainEvent(
    {
      groupId: measurement.groupId,
      companyId: measurement.companyId,
      aggregateType: 'StageMeasurement',
      aggregateId: measurement.id,
      eventType: 'measurement.submitted',
      payload: { id: measurement.id, projectStageId: measurement.projectStageId, status: measurement.status, totalAmount: measurement.totalAmount },
      idempotencyKey: `measurement.submitted:${measurement.id}:${measurement.revisionNumber}`,
    },
    transaction
  );
}

function publishMeasurementApproved(measurement, transaction) {
  return publishDomainEvent(
    {
      groupId: measurement.groupId,
      companyId: measurement.companyId,
      aggregateType: 'StageMeasurement',
      aggregateId: measurement.id,
      eventType: 'measurement.approved',
      payload: {
        id: measurement.id,
        projectStageId: measurement.projectStageId,
        status: measurement.status,
        measuredPct: measurement.measuredPct,
        totalAmount: measurement.totalAmount,
        payableFinancialEntryId: measurement.payableFinancialEntryId,
      },
      // Idempotency key fixa por medição (não por revisão): uma medição só pode ser aprovada
      // UMA vez de verdade — reprocessar o mesmo evento de aprovação não pode gerar um segundo
      // evento "measurement.approved" para o outbox.
      idempotencyKey: `measurement.approved:${measurement.id}`,
    },
    transaction
  );
}

function publishMaintenanceCaseOpened(maintenanceCase, transaction) {
  return publishDomainEvent(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      aggregateType: 'MaintenanceCase',
      aggregateId: maintenanceCase.id,
      eventType: 'construction.maintenance_case.opened',
      payload: { id: maintenanceCase.id, propertyId: maintenanceCase.propertyId, status: maintenanceCase.status },
      idempotencyKey: `construction.maintenance_case.opened:${maintenanceCase.id}`,
    },
    transaction
  );
}

// DECISÃO DE ENGENHARIA: todos os eventos acima usam o prefixo `construction.` (convenção
// interna adotada antes deste marco). `project.budget.approved` é o nome CANÔNICO exigido
// explicitamente pela fonte (checklist Marco 6, M6-70) — publicado sem o prefixo de propósito,
// mesmo divergindo da convenção interna, porque este é o nome que consumidores externos
// (Financeiro, BI) esperam encontrar no barramento de eventos. Migração dos nomes antigos para
// o padrão canônico da fonte fica registrada como dívida técnica conhecida (M6-69/M6-71/
// M6-72/M6-76 etc.), fora do escopo desta entrega.
function publishBudgetApproved(budget, transaction) {
  return publishDomainEvent(
    {
      groupId: budget.groupId,
      companyId: budget.companyId,
      aggregateType: 'Budget',
      aggregateId: budget.id,
      eventType: 'project.budget.approved',
      payload: {
        id: budget.id,
        projectId: budget.projectId,
        baselineAmount: budget.baselineAmount,
        ruleVersionId: budget.ruleVersionId,
        approvedAt: budget.approvedAt,
      },
      idempotencyKey: `project.budget.approved:${budget.id}`,
    },
    transaction
  );
}

module.exports = {
  publishProjectCreated,
  publishProjectStatusChanged,
  publishStageMeasurementDecided,
  publishMeasurementSubmitted,
  publishMeasurementApproved,
  publishMaintenanceCaseOpened,
  publishBudgetApproved,
};
