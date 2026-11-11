'use strict';

const { Op } = require('sequelize');
const { ChecklistTemplate, Project, ProjectStage, QualityChecklistItem } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { CATEGORIES } = require('./qualityChecklist.service');
const { assertActiveProjectType } = require('./projectTypes.service');

/**
 * Checklist por etapa e por tipo de obra (Caderno Obras §9: "Checklist por etapa/tipo de obra; falha abre
 * nonconformity"; verificação independente M6-12/M6-86). O administrador configura os itens: projectTypeId (nulo =
 * vale para todo tipo), stageCode (nulo = item da obra, sem etapa; preenchido = vale para a etapa com esse código),
 * categoria e a severidade da não conformidade que a reprovação abre. A obra recebe os itens do seu tipo (e os
 * gerais) em applyProjectChecklist: ao ganhar o tipo, ao ganhar uma etapa (ou mudar o código da etapa) e pelo botão
 * "aplicar checklist". Idempotente: cada modelo vira no máximo um item por etapa (índice único no banco).
 */
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const CLOSED_PROJECT_STATUSES = ['DELIVERED', 'WARRANTY', 'CLOSED', 'CANCELLED'];

function normalizeStageCode(stageCode) {
  if (stageCode === undefined || stageCode === null || String(stageCode).trim() === '') return null;
  const value = String(stageCode).trim().toUpperCase();
  if (value.length > 40) throw AppError.badRequest('"stageCode" deve ter até 40 caracteres.', 'CHECKLIST_TEMPLATE_VALIDATION');
  return value;
}

function validateFields({ item, category, failureSeverity, sequence }, partial) {
  const out = {};
  if (!partial || item !== undefined) {
    const text = String(item || '').trim();
    if (!text || text.length > 255) throw AppError.badRequest('"item" é obrigatório (até 255 caracteres).', 'CHECKLIST_TEMPLATE_VALIDATION');
    out.item = text;
  }
  if (!partial || category !== undefined) {
    const value = category ? String(category).toUpperCase() : 'OUTROS';
    if (!CATEGORIES.includes(value)) throw AppError.badRequest(`"category" deve ser um de: ${CATEGORIES.join(', ')}.`, 'CHECKLIST_TEMPLATE_VALIDATION');
    out.category = value;
  }
  if (!partial || failureSeverity !== undefined) {
    const value = failureSeverity ? String(failureSeverity).toUpperCase() : 'MEDIUM';
    if (!SEVERITIES.includes(value)) throw AppError.badRequest(`"failureSeverity" deve ser um de: ${SEVERITIES.join(', ')}.`, 'CHECKLIST_TEMPLATE_VALIDATION');
    out.failureSeverity = value;
  }
  if (!partial || sequence !== undefined) {
    const value = sequence === undefined || sequence === null ? 1 : Number(sequence);
    if (!Number.isInteger(value) || value < 1) throw AppError.badRequest('"sequence" deve ser um inteiro maior que zero.', 'CHECKLIST_TEMPLATE_VALIDATION');
    out.sequence = value;
  }
  return out;
}

async function createChecklistTemplate(payload, actorUserId, transaction) {
  const { groupId, companyId } = payload || {};
  const projectTypeId = await assertActiveProjectType(payload.projectTypeId, companyId, transaction);
  const row = await ChecklistTemplate.create(
    { groupId, companyId, projectTypeId, stageCode: normalizeStageCode(payload.stageCode), ...validateFields(payload, false), active: true, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
  await registrarAuditoria(
    { groupId, companyId, actorUserId, action: 'construction.checklist_template.create', entityType: 'ChecklistTemplate', entityId: row.id, afterJson: row.toJSON(), reason: `Item de checklist "${row.item}" configurado.` },
    transaction
  );
  return row;
}

function listChecklistTemplates(transaction, { projectTypeId } = {}) {
  const where = {};
  if (projectTypeId) where.projectTypeId = projectTypeId;
  return ChecklistTemplate.findAll({ where, order: [['stage_code', 'ASC'], ['sequence', 'ASC'], ['created_at', 'ASC']], transaction });
}

async function updateChecklistTemplate(id, payload, actorUserId, transaction) {
  const row = await ChecklistTemplate.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!row) throw AppError.notFound('Item de checklist não encontrado.', 'CHECKLIST_TEMPLATE_NOT_FOUND');
  const beforeJson = row.toJSON();
  Object.assign(row, validateFields(payload || {}, true));
  if (payload && payload.stageCode !== undefined) row.stageCode = normalizeStageCode(payload.stageCode);
  if (payload && payload.active !== undefined) {
    if (typeof payload.active !== 'boolean') throw AppError.badRequest('"active" deve ser verdadeiro ou falso.', 'CHECKLIST_TEMPLATE_VALIDATION');
    row.active = payload.active;
  }
  row.updatedBy = actorUserId || null;
  await row.save({ transaction });
  await registrarAuditoria(
    { groupId: row.groupId, companyId: row.companyId, actorUserId, action: 'construction.checklist_template.update', entityType: 'ChecklistTemplate', entityId: row.id, beforeJson, afterJson: row.toJSON(), reason: `Item de checklist "${row.item}" alterado.` },
    transaction
  );
  return row;
}

/**
 * Gera na obra os itens de checklist configurados para o tipo dela e para cada etapa (pelo código da etapa). Obra
 * entregue, em garantia, encerrada ou cancelada não recebe item novo. Devolve os itens criados agora.
 */
async function applyProjectChecklist(projectId, actorUserId, transaction) {
  const project = await Project.findByPk(projectId, { transaction });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');
  if (CLOSED_PROJECT_STATUSES.includes(project.status)) return [];
  const typeFilter = project.projectTypeId ? { [Op.or]: [{ projectTypeId: null }, { projectTypeId: project.projectTypeId }] } : { projectTypeId: null };
  const templates = await ChecklistTemplate.findAll({ where: { companyId: project.companyId, active: true, ...typeFilter }, order: [['sequence', 'ASC']], transaction });
  if (!templates.length) return [];
  const stages = await ProjectStage.findAll({ where: { projectId }, transaction });
  const created = [];
  for (const template of templates) {
    const targets = template.stageCode
      ? stages.filter((s) => s.stageCode && String(s.stageCode).trim().toUpperCase() === template.stageCode).map((s) => s.id)
      : [null];
    for (const projectStageId of targets) {
      const exists = await QualityChecklistItem.findOne({ where: { projectId, projectStageId, checklistTemplateId: template.id }, transaction });
      if (exists) continue;
      const item = await QualityChecklistItem.create(
        {
          groupId: project.groupId,
          companyId: project.companyId,
          projectId,
          projectStageId,
          item: template.item,
          category: template.category,
          checklistTemplateId: template.id,
          failureSeverity: template.failureSeverity,
          status: 'PENDING',
          createdBy: actorUserId || null,
          updatedBy: actorUserId || null,
        },
        { transaction }
      );
      created.push(item);
    }
  }
  if (created.length) {
    await registrarAuditoria(
      { groupId: project.groupId, companyId: project.companyId, actorUserId, action: 'construction.quality_checklist.apply', entityType: 'Project', entityId: project.id, afterJson: { createdItemIds: created.map((i) => i.id), projectTypeId: project.projectTypeId }, reason: `${created.length} item(ns) de checklist do tipo de obra/etapa gerado(s) para a obra "${project.name}".` },
      transaction
    );
  }
  return created;
}

module.exports = { createChecklistTemplate, listChecklistTemplates, updateChecklistTemplate, applyProjectChecklist, SEVERITIES };
