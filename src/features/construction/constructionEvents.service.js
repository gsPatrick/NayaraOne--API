'use strict';

const { publishDomainEvent } = require('../../engines/events/outbox');

// Publicação dos domain events do módulo construction (Transactional Outbox), seguindo o
// mesmo padrão de src/features/legal/legalEvents.service.js e financeEvents.service.js —
// sempre dentro da MESMA transação da operação de negócio.
//
// CONVENÇÃO OFICIAL DE NOMENCLATURA DO MÓDULO (M6-69/M6-71/M6-72/M6-105/M6-106): o padrão
// canônico é `construction.<entidade>.<evento>` (ex.: `construction.project.created`,
// `construction.stage.completed`), com prefixo de módulo — mesmo padrão já usado em
// `legal.*` (legalEvents.service.js) e `finance.*` (financeEvents.service.js), que também
// prefixam todo evento com o nome do módulo produtor. O checklist do Marco 6 (Anexo I) lista
// alguns eventos sem esse prefixo (`project.created`, `project.started`,
// `project.stage.completed`) — DECISÃO DE ENGENHARIA: mantemos o prefixo `construction.` por
// consistência transversal com o resto do sistema, em vez de remover o prefixo só neste
// módulo. Resolve explicitamente:
//   - M6-106: nome canônico do evento de etapa concluída é `construction.stage.completed`
//     (não `project.stage.completed`).
//   - M6-71: evento de início de obra é `construction.project.started`, disparado só na
//     primeira transição PLANNED -> IN_PROGRESS, distinto do genérico
//     `construction.project.status_changed` (que continua cobrindo todas as transições).
//   - M6-105: evento de fechamento de caso de pós-obra/garantia é
//     `construction.maintenance_case.closed` — escolhido por consistência com o
//     `construction.maintenance_case.opened` já existente (a fonte tem duas seções
//     divergentes: uma cita `maintenance.case.closed`, outra `warranty.case.closed` — nenhuma
//     das duas bate com o nome de entidade real do schema físico, que é `maintenance_cases`).

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

// M6-105: nome canônico escolhido — ver comentário de convenção no topo do arquivo.
function publishMaintenanceCaseClosed(maintenanceCase, transaction) {
  return publishDomainEvent(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      aggregateType: 'MaintenanceCase',
      aggregateId: maintenanceCase.id,
      eventType: 'construction.maintenance_case.closed',
      payload: { id: maintenanceCase.id, propertyId: maintenanceCase.propertyId, status: maintenanceCase.status },
      idempotencyKey: `construction.maintenance_case.closed:${maintenanceCase.id}`,
    },
    transaction
  );
}

// M6-71: disparado só na primeira transição PLANNED -> IN_PROGRESS (ver projects.service.js).
function publishProjectStarted(project, transaction) {
  return publishDomainEvent(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      aggregateType: 'Project',
      aggregateId: project.id,
      eventType: 'construction.project.started',
      payload: { id: project.id, name: project.name },
      idempotencyKey: `construction.project.started:${project.id}`,
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
      eventType: 'construction.stage.completed',
      payload: { id: stage.id, projectId: stage.projectId, name: stage.name },
      idempotencyKey: `construction.stage.completed:${stage.id}`,
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
  publishStageMeasurementDecided,
  publishStageCompleted,
  publishMaintenanceCaseOpened,
  publishMaintenanceCaseClosed,
  publishMaterialRequested,
  publishMaterialReceived,
};
