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

module.exports = {
  publishProjectCreated,
  publishProjectStatusChanged,
  publishStageMeasurementDecided,
  publishMaintenanceCaseOpened,
};
