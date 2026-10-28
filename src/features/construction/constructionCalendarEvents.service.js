'use strict';

const { Op } = require('sequelize');
const { publishDomainEvent } = require('../../engines/events/outbox');
const { getSetting } = require('../settings/settings.service');
const { WARRANTY_MONTHS_KEY, CALENDAR_SETTING_DEFAULTS } = require('../../features/core-governance/calendar/calendar.settings');
const { dateKeyInZone, addMonthsToDateKey } = require('../../features/core-governance/calendar/sources/time');

/**
 * Eventos de obra que alimentam o Calendário unificado (M9-D803). Separado de constructionEvents.service.js (uma
 * responsabilidade por arquivo); mesma regra: sempre dentro da transação da operação (Transactional Outbox).
 */

/** Campos da obra que o calendário precisa nos eventos de ciclo de vida (prazo final e responsável). */
function projectCalendarFields(project) {
  return { endsAtPlanned: project.endsAtPlanned || null, responsibleUserId: project.responsibleUserId || null };
}

/** Campos do caso em garantia que o calendário precisa (prazo da garantia, responsável e descrição para o título). */
function warrantyCaseCalendarFields(maintenanceCase) {
  return {
    warrantyDeadlineAt: maintenanceCase.warrantyDeadlineAt || null,
    responsibleUserId: maintenanceCase.responsibleUserId || null,
    description: maintenanceCase.description || null,
  };
}

/**
 * project.stage.updated — publicado quando ends_at, status ou responsável da etapa mudam (inclusive na criação).
 * Chave `project.stage.updated:<stageId>:<lock_version>`; `keySuffix` distingue a mudança de responsável da OBRA (a etapa
 * não muda de versão nesse caso).
 */
async function publishProjectStageUpdated(stage, transaction, keySuffix = '') {
  const { Project } = require('../../models');
  const project = await Project.findByPk(stage.projectId, { transaction });
  return publishDomainEvent(
    {
      groupId: stage.groupId,
      companyId: stage.companyId,
      aggregateType: 'ProjectStage',
      aggregateId: stage.id,
      eventType: 'project.stage.updated',
      payload: {
        projectId: stage.projectId,
        stageId: stage.id,
        projectName: project ? project.name : null,
        stageName: stage.name,
        endsAt: stage.endsAt || null,
        status: stage.status,
        responsibleUserId: project ? project.responsibleUserId || null : null,
      },
      idempotencyKey: `project.stage.updated:${stage.id}:${stage.lockVersion}${keySuffix}`,
    },
    transaction
  );
}

/**
 * Prazo final ou responsável da obra mudou: publica project.schedule.updated (DI-D803-3) e, se o responsável mudou,
 * reemite project.stage.updated das etapas abertas com prazo (o dono do item da etapa é o responsável da obra).
 */
async function publishProjectScheduleChanged(project, before, transaction) {
  const endsBefore = before.endsAtPlanned ? new Date(before.endsAtPlanned).getTime() : null;
  const endsNow = project.endsAtPlanned ? new Date(project.endsAtPlanned).getTime() : null;
  const respChanged = (before.responsibleUserId || null) !== (project.responsibleUserId || null);
  if (endsBefore === endsNow && !respChanged) return false;
  await publishDomainEvent(
    {
      groupId: project.groupId,
      companyId: project.companyId,
      aggregateType: 'Project',
      aggregateId: project.id,
      eventType: 'project.schedule.updated',
      payload: { id: project.id, name: project.name, status: project.status, ...projectCalendarFields(project) },
      idempotencyKey: `project.schedule.updated:${project.id}:${project.lockVersion}`,
    },
    transaction
  );
  if (respChanged) {
    const { ProjectStage } = require('../../models');
    const stages = await ProjectStage.findAll({ where: { projectId: project.id, endsAt: { [Op.ne]: null }, status: { [Op.ne]: 'DONE' } }, transaction });
    for (const stage of stages) {
      await publishProjectStageUpdated(stage, transaction, `:resp${project.lockVersion}`);
    }
  }
  return true;
}

/** Fim da garantia da obra entregue: data da entrega (hoje, em Brasília) + meses configurados (padrão 60). */
async function computeProjectWarrantyEndsAt(project, transaction, now = new Date()) {
  const configured = await getSetting(WARRANTY_MONTHS_KEY, { companyId: project.companyId }, transaction, CALENDAR_SETTING_DEFAULTS[WARRANTY_MONTHS_KEY]);
  const months = Number.isInteger(Number(configured)) && Number(configured) > 0 ? Number(configured) : CALENDAR_SETTING_DEFAULTS[WARRANTY_MONTHS_KEY];
  return addMonthsToDateKey(dateKeyInZone(now), months);
}

module.exports = { projectCalendarFields, warrantyCaseCalendarFields, publishProjectStageUpdated, publishProjectScheduleChanged, computeProjectWarrantyEndsAt };
