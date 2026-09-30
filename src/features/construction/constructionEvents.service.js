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

// M6-80: evento de fechamento do chamado de garantia. DECISÃO DE ENGENHARIA / MUDANÇA DE
// CONVENÇÃO: todos os demais eventos deste módulo usam o prefixo `construction.` (ex.:
// `construction.maintenance_case.opened`, `construction.project.created`). A especificação do
// M6-80 pede explicitamente o nome canônico `warranty.case.closed`, SEM esse prefixo — mantido
// assim de propósito (não é um esquecimento) para casar com o nome pedido; se outro consumidor
// já espera `construction.maintenance_case.closed`, publique os dois a partir daqui.
function publishWarrantyCaseClosed(maintenanceCase, transaction) {
  return publishDomainEvent(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      aggregateType: 'MaintenanceCase',
      aggregateId: maintenanceCase.id,
      eventType: 'warranty.case.closed',
      payload: { id: maintenanceCase.id, propertyId: maintenanceCase.propertyId, status: maintenanceCase.status },
      idempotencyKey: `warranty.case.closed:${maintenanceCase.id}`,
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

module.exports = {
  publishProjectCreated,
  publishProjectStatusChanged,
  publishStageMeasurementDecided,
  publishMaintenanceCaseOpened,
  publishWarrantyCaseClosed,
  publishProjectDelivered,
};
