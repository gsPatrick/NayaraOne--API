'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Publicação dos domain events do módulo construction (Transactional Outbox), seguindo o
// mesmo padrão de src/features/legal/legalEvents.service.js e financeEvents.service.js —
// sempre dentro da MESMA transação da operação de negócio.
//
// CONVENÇÃO OFICIAL DE NOMENCLATURA DO MÓDULO (M6-69/M6-71/M6-72/M6-105/M6-106 — decisão final
// de resolução de merge): eventos TÉCNICOS de CRUD (created/status_changed/decided/opened)
// mantêm o prefixo `construction.` (ex.: `construction.project.created`,
// `construction.stage_measurement.decided`, `construction.maintenance_case.opened`) — mesmo
// padrão já usado em `legal.*` e `finance.*`. Já os eventos de NEGÓCIO de alto nível usam o
// nome CANÔNICO sem prefixo, exigido pela fonte/checklist do Marco 6, porque são os nomes que
// consumidores externos (Financeiro, BI) esperam encontrar no barramento:
//   - `project.budget.approved`, `nonconformity.opened`, `nonconformity.closed`,
//     `warranty.case.closed`, `project.delivered`, `measurement.submitted`,
//     `measurement.approved`, `project.stage.completed` (M6-106), `project.started` (M6-71).
//   - M6-105: fechamento de caso de pós-obra/garantia usa SOMENTE `warranty.case.closed`
//     (publishWarrantyCaseClosed) — não existe um segundo evento
//     `construction.maintenance_case.closed`/`publishMaintenanceCaseClosed` duplicado para o
//     mesmo caso.

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
      // FIX (auditoria E2E de browser, 01/10/2026): a chave anterior
      // `${project.id}:${fromStatus}:${project.status}` não incluía nada que distinguisse duas
      // ocorrências LEGÍTIMAS da MESMA transição no mesmo projeto (ex.: ACTIVE -> FINAL_INSPECTION
      // -> ACTIVE (devolvido pra retrabalho) -> FINAL_INSPECTION de novo — um ciclo real e
      // esperado, igual PAUSED <-> ACTIVE). A segunda ocorrência colidia com o índice único de
      // idempotencyKey da outbox, estourando UNIQUE_CONSTRAINT_VIOLATION (409 cru) e revertendo a
      // transação inteira — a obra nunca saía do status anterior. `lockVersion` incrementa a cada
      // save() e já reflete o valor pós-save neste ponto, então cada save real vira uma chave
      // distinta, mantendo a idempotência real (reenvio da MESMA requisição/save colide, uma nova
      // transição não).
      idempotencyKey: `construction.project.status_changed:${project.id}:${fromStatus}:${project.status}:${project.lockVersion}`,
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

function publishWarrantyCaseClosed(maintenanceCase, transaction) {
  return publishDomainEvent(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      aggregateType: 'MaintenanceCase',
      aggregateId: maintenanceCase.id,
      eventType: 'warranty.case.closed',
      payload: { id: maintenanceCase.id, propertyId: maintenanceCase.propertyId, status: maintenanceCase.status },
      // FIX (mesmo achado de publishProjectStatusChanged, 01/10/2026): status de MaintenanceCase
      // é campo livre (updateMaintenanceCase aceita qualquer STATUSES), então reabrir um chamado
      // fechado (CLOSED -> OPEN) e fechá-lo de novo é um ciclo legítimo — sem o lockVersion a
      // segunda chamada colidia com o índice único da outbox e revertia o fechamento inteiro.
      idempotencyKey: `warranty.case.closed:${maintenanceCase.id}:${maintenanceCase.lockVersion}`,
    },
    transaction
  );
}

function publishNonconformityOpened(nonconformity, transaction) {
  return publishDomainEvent(
    {
      groupId: nonconformity.groupId,
      companyId: nonconformity.companyId,
      aggregateType: 'Nonconformity',
      aggregateId: nonconformity.id,
      eventType: 'nonconformity.opened',
      payload: { id: nonconformity.id, projectId: nonconformity.projectId, severity: nonconformity.severity },
      idempotencyKey: `nonconformity.opened:${nonconformity.id}`,
    },
    transaction
  );
}

function publishNonconformityClosed(nonconformity, transaction) {
  return publishDomainEvent(
    {
      groupId: nonconformity.groupId,
      companyId: nonconformity.companyId,
      aggregateType: 'Nonconformity',
      aggregateId: nonconformity.id,
      eventType: 'nonconformity.closed',
      payload: { id: nonconformity.id, projectId: nonconformity.projectId, severity: nonconformity.severity },
      idempotencyKey: `nonconformity.closed:${nonconformity.id}`,
    },
    transaction
  );
}

// M6-25/M6-39/M6-51/M6-65/M6-79/M6-87: evento de entrega da obra, disparado pelo gate dedicado
// `POST /construction/projects/:id/deliver` (ver projects.service.js#deliverProject). Segue a
// mesma convenção sem prefixo pedida para `warranty.case.closed` — ambos são eventos "de
// negócio" de alto nível (fim de garantia / entrega da obra), diferente dos eventos técnicos de
// CRUD (`construction.project.created`, `construction.project.status_changed`) que continuam
// prefixados.
function publishProjectDelivered(project, transaction) {
  return publishDomainEvent(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      aggregateType: 'Project',
      aggregateId: project.id,
      eventType: 'project.delivered',
      payload: { id: project.id, name: project.name, status: project.status },
      idempotencyKey: `project.delivered:${project.id}`,
    },
    transaction
  );
}

// M6-18: obra entra em garantia imediatamente após a entrega (DELIVERED -> WARRANTY, mesma
// chamada de deliverProject).
function publishProjectWarrantyStarted(project, transaction) {
  return publishDomainEvent(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      aggregateType: 'Project',
      aggregateId: project.id,
      eventType: 'project.warranty_started',
      payload: { id: project.id, name: project.name, status: project.status },
      idempotencyKey: `project.warranty_started:${project.id}`,
    },
    transaction
  );
}

// M6-18: obra encerrada definitivamente (WARRANTY -> CLOSED, via closeProjectWarranty).
function publishProjectClosed(project, transaction) {
  return publishDomainEvent(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      aggregateType: 'Project',
      aggregateId: project.id,
      eventType: 'project.closed',
      payload: { id: project.id, name: project.name, status: project.status },
      idempotencyKey: `project.closed:${project.id}`,
    },
    transaction
  );
}

// M6-71: disparado só na primeira transição READY -> ACTIVE (ver projects.service.js).
// Nome canônico sem prefixo (decisão final de resolução de merge — ver comentário de
// convenção no topo do arquivo).
function publishProjectStarted(project, transaction) {
  return publishDomainEvent(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      aggregateType: 'Project',
      aggregateId: project.id,
      eventType: 'project.started',
      payload: { id: project.id, name: project.name },
      idempotencyKey: `project.started:${project.id}`,
    },
    transaction
  );
}

// M6-73: nome canônico exigido pela fonte, sem prefixo — mesmo padrão de publishProjectStarted.
function publishDailyLogCreated(report, transaction) {
  return publishDomainEvent(
    {
      groupId: report.groupId,
      companyId: report.companyId,
      aggregateType: 'DailyReport',
      aggregateId: report.id,
      eventType: 'project.daily_log.created',
      payload: { id: report.id, projectId: report.projectId, reportDate: report.reportDate, shiftCode: report.shiftCode },
      idempotencyKey: `project.daily_log.created:${report.id}`,
    },
    transaction
  );
}

// M6-74: nome canônico exigido pela fonte, sem prefixo. `dateKey` (YYYY-MM-DD) entra na
// idempotencyKey de propósito — ver projectDelayDetectionJob.js para o motivo (permite um novo
// evento de lembrete por dia enquanto a obra continuar atrasada, sem duplicar no mesmo dia).
function publishProjectDelayDetected(project, dateKey, transaction) {
  return publishDomainEvent(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      aggregateType: 'Project',
      aggregateId: project.id,
      eventType: 'project.delay.detected',
      payload: { id: project.id, name: project.name, endsAtPlanned: project.endsAtPlanned, status: project.status },
      idempotencyKey: `project.delay.detected:${project.id}:${dateKey}`,
    },
    transaction
  );
}

// M6-72/M6-106: nome canônico escolhido — ver comentário de convenção no topo do arquivo.
function publishStageCompleted(stage, transaction) {
  return publishDomainEvent(
    {
      groupId: stage.groupId,
      companyId: stage.companyId,
      aggregateType: 'ProjectStage',
      aggregateId: stage.id,
      eventType: 'project.stage.completed',
      payload: { id: stage.id, projectId: stage.projectId, name: stage.name },
      idempotencyKey: `project.stage.completed:${stage.id}`,
    },
    transaction
  );
}

// M6-28: mínimo exigido para o marco — integração completa com Estoque é do Marco 7 (ver
// comentário na migration 20260101000236-create-construction-material_requests.js).
function publishMaterialRequested(materialRequest, transaction) {
  return publishDomainEvent(
    {
      groupId: materialRequest.groupId,
      companyId: materialRequest.companyId,
      aggregateType: 'MaterialRequest',
      aggregateId: materialRequest.id,
      eventType: 'material.requested',
      payload: {
        id: materialRequest.id,
        projectId: materialRequest.projectId,
        stageId: materialRequest.stageId,
        description: materialRequest.description,
        quantity: materialRequest.quantity,
        unit: materialRequest.unit,
      },
      idempotencyKey: `material.requested:${materialRequest.id}`,
    },
    transaction
  );
}

function publishMaterialReceived(materialRequest, transaction) {
  return publishDomainEvent(
    {
      groupId: materialRequest.groupId,
      companyId: materialRequest.companyId,
      aggregateType: 'MaterialRequest',
      aggregateId: materialRequest.id,
      eventType: 'material.received',
      payload: {
        id: materialRequest.id,
        projectId: materialRequest.projectId,
        stageId: materialRequest.stageId,
        description: materialRequest.description,
        quantity: materialRequest.quantity,
        unit: materialRequest.unit,
      },
      idempotencyKey: `material.received:${materialRequest.id}`,
    },
    transaction
  );
}

module.exports = {
  publishProjectCreated,
  publishProjectStatusChanged,
  publishProjectStarted,
  publishDailyLogCreated,
  publishProjectDelayDetected,
  publishStageMeasurementDecided,
  publishMeasurementSubmitted,
  publishMeasurementApproved,
  publishMaintenanceCaseOpened,
  publishBudgetApproved,
  publishNonconformityOpened,
  publishNonconformityClosed,
  publishWarrantyCaseClosed,
  publishProjectDelivered,
  publishProjectWarrantyStarted,
  publishProjectClosed,
  publishStageCompleted,
  publishMaterialRequested,
  publishMaterialReceived,
};
