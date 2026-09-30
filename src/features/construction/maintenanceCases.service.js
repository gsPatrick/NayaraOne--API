'use strict';

const { MaintenanceCase, WarrantyAction } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishMaintenanceCaseOpened, publishWarrantyCaseClosed } = require('./constructionEvents.service');

// DECISÃO DE ENGENHARIA: status de MaintenanceCase (pós-obra/garantia) é STRING(32) livre nas
// fontes, sem enum documentado — workflow abaixo segue o mesmo padrão de "chamado" já usado
// em finance.approval_requests e crm.opportunities (aberto -> em andamento -> resolvido/fechado).
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

// M6-15/M6-16: WarrantyCase estruturado. `category` e `root_cause_code` são "enum simples
// configurável" (nenhum documento fonte define lista fechada) — mantidos como STRING livre no
// banco, mas com uma lista padrão validada aqui em código (fácil trocar por uma tabela de
// configuração depois, sem migração, se o negócio pedir listas por tenant).
const CATEGORIES = ['STRUCTURAL', 'ELECTRICAL', 'HYDRAULIC', 'FINISHING', 'WATERPROOFING', 'OTHER'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const ROOT_CAUSE_CODES = ['MATERIAL_DEFECT', 'WORKMANSHIP', 'DESIGN_FLAW', 'MISUSE', 'NATURAL_WEAR', 'OTHER'];
const ESCALATION_LEVELS = ['NONE', 'WARNING', 'CRITICAL', 'OVERDUE'];

// M6-63/M6-88: prazo de atendimento (em dias) por severidade, usado para calcular `sla_due_at`
// a partir de `warranty_deadline_at` (quando informado) ou da data de abertura do caso. Decisão
// de engenharia — nenhum documento fonte define os dias exatos; valores seguem senso comum de
// SLA de garantia decrescente conforme a severidade sobe.
const SEVERITY_SLA_DAYS = { CRITICAL: 2, HIGH: 5, MEDIUM: 15, LOW: 30 };
const DAY_MS = 24 * 60 * 60 * 1000;

function computeSlaDueAt(baseDate, severity) {
  const base = baseDate ? new Date(baseDate) : new Date();
  const days = SEVERITY_SLA_DAYS[severity] != null ? SEVERITY_SLA_DAYS[severity] : SEVERITY_SLA_DAYS.MEDIUM;
  return new Date(base.getTime() + days * DAY_MS);
}

/**
 * computeEscalationLevel — regra de escalonamento de SLA (M6-63/M6-88): função pura,
 * testável isoladamente e reutilizada tanto pelos services (ao criar/atualizar um caso) quanto
 * pelo `warrantyEscalationJob` (ao varrer os casos em aberto periodicamente).
 *   - já vencido (sla_due_at no passado)            -> OVERDUE
 *   - vence em até 1 dia (inclusive hoje)            -> CRITICAL
 *   - vence em até 2 dias                            -> WARNING
 *   - qualquer outro caso (ou sem sla_due_at)        -> NONE
 */
function computeEscalationLevel(slaDueAt, now = new Date()) {
  if (!slaDueAt) return 'NONE';
  const diffMs = new Date(slaDueAt).getTime() - new Date(now).getTime();
  if (diffMs < 0) return 'OVERDUE';
  const diffDays = diffMs / DAY_MS;
  if (diffDays <= 1) return 'CRITICAL';
  if (diffDays <= 2) return 'WARNING';
  return 'NONE';
}

function validateCategory(category) {
  if (category === undefined || category === null) return null;
  const normalized = String(category).toUpperCase();
  if (!CATEGORIES.includes(normalized)) {
    throw AppError.badRequest(`"category" deve ser um de: ${CATEGORIES.join(', ')}.`, 'MAINTENANCE_CASE_CATEGORY_INVALID');
  }
  return normalized;
}

function validateSeverity(severity) {
  const normalized = String(severity || 'MEDIUM').toUpperCase();
  if (!SEVERITIES.includes(normalized)) {
    throw AppError.badRequest(`"severity" deve ser um de: ${SEVERITIES.join(', ')}.`, 'MAINTENANCE_CASE_SEVERITY_INVALID');
  }
  return normalized;
}

function validateRootCauseCode(rootCauseCode) {
  if (rootCauseCode === undefined || rootCauseCode === null) return null;
  const normalized = String(rootCauseCode).toUpperCase();
  if (!ROOT_CAUSE_CODES.includes(normalized)) {
    throw AppError.badRequest(
      `"rootCauseCode" deve ser um de: ${ROOT_CAUSE_CODES.join(', ')}.`,
      'MAINTENANCE_CASE_ROOT_CAUSE_INVALID'
    );
  }
  return normalized;
}

function validateMediaFileIds(fileIds, fieldName) {
  if (fileIds === undefined) return undefined;
  if (fileIds === null) return [];
  if (!Array.isArray(fileIds)) {
    throw AppError.badRequest(`"${fieldName}" precisa ser uma lista de IDs de arquivo.`, 'MAINTENANCE_CASE_MEDIA_INVALID');
  }
  return fileIds;
}

async function createMaintenanceCase(payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    propertyId,
    projectId,
    openedByPersonId,
    responsibleUserId,
    description,
    warrantyDeadlineAt,
    category,
    severity,
    rootCauseCode,
    beforeMediaFileIds,
    laborCost,
    materialCost,
  } = payload;
  if (!groupId || !companyId || !propertyId || !description) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "propertyId" e "description" são obrigatórios.',
      'MAINTENANCE_CASE_VALIDATION'
    );
  }

  const normalizedSeverity = validateSeverity(severity);
  const now = new Date();
  const slaBaseDate = warrantyDeadlineAt || now;
  const slaDueAt = computeSlaDueAt(slaBaseDate, normalizedSeverity);

  const maintenanceCase = await MaintenanceCase.create(
    {
      groupId,
      companyId,
      propertyId,
      projectId: projectId || null,
      openedByPersonId: openedByPersonId || null,
      responsibleUserId: responsibleUserId || null,
      description,
      status: 'OPEN',
      warrantyDeadlineAt: warrantyDeadlineAt || null,
      category: validateCategory(category),
      severity: normalizedSeverity,
      slaDueAt,
      escalationLevel: computeEscalationLevel(slaDueAt, now),
      rootCauseCode: validateRootCauseCode(rootCauseCode),
      beforeMediaFileIds: validateMediaFileIds(beforeMediaFileIds, 'beforeMediaFileIds') || [],
      laborCost: laborCost != null ? laborCost : null,
      materialCost: materialCost != null ? materialCost : null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishMaintenanceCaseOpened(maintenanceCase, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.maintenance_case.create',
      entityType: 'MaintenanceCase',
      entityId: maintenanceCase.id,
      afterJson: maintenanceCase.toJSON(),
      reason: `Chamado de pós-obra aberto para o imóvel ${propertyId}.`,
    },
    transaction
  );

  return maintenanceCase;
}

async function listMaintenanceCases(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.propertyId) where.propertyId = filters.propertyId;
  if (filters.projectId) where.projectId = filters.projectId;
  return MaintenanceCase.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getMaintenanceCase(id, transaction) {
  const maintenanceCase = await MaintenanceCase.findByPk(id, { transaction });
  if (!maintenanceCase) throw AppError.notFound('Chamado de pós-obra não encontrado.', 'MAINTENANCE_CASE_NOT_FOUND');
  return maintenanceCase;
}

async function updateMaintenanceCase(id, payload, actorUserId, transaction) {
  const maintenanceCase = await getMaintenanceCase(id, transaction);
  const beforeJson = maintenanceCase.toJSON();
  const {
    status,
    description,
    responsibleUserId,
    warrantyDeadlineAt,
    category,
    severity,
    rootCauseCode,
    beforeMediaFileIds,
    afterMediaFileIds,
    laborCost,
    materialCost,
  } = payload;

  const previousStatus = maintenanceCase.status;
  if (status !== undefined) {
    const normalizedStatus = String(status).toUpperCase();
    if (!STATUSES.includes(normalizedStatus)) {
      throw AppError.badRequest(`"status" deve ser um de: ${STATUSES.join(', ')}.`, 'MAINTENANCE_CASE_STATUS_INVALID');
    }
    maintenanceCase.status = normalizedStatus;
  }
  if (description !== undefined) maintenanceCase.description = description;
  if (responsibleUserId !== undefined) maintenanceCase.responsibleUserId = responsibleUserId;
  if (category !== undefined) maintenanceCase.category = validateCategory(category);
  if (rootCauseCode !== undefined) maintenanceCase.rootCauseCode = validateRootCauseCode(rootCauseCode);
  const beforeMedia = validateMediaFileIds(beforeMediaFileIds, 'beforeMediaFileIds');
  if (beforeMedia !== undefined) maintenanceCase.beforeMediaFileIds = beforeMedia;
  const afterMedia = validateMediaFileIds(afterMediaFileIds, 'afterMediaFileIds');
  if (afterMedia !== undefined) maintenanceCase.afterMediaFileIds = afterMedia;
  if (laborCost !== undefined) maintenanceCase.laborCost = laborCost;
  if (materialCost !== undefined) maintenanceCase.materialCost = materialCost;

  let slaRecalcNeeded = false;
  if (warrantyDeadlineAt !== undefined) {
    if (warrantyDeadlineAt !== null && Number.isNaN(new Date(warrantyDeadlineAt).getTime())) {
      throw AppError.badRequest('"warrantyDeadlineAt" precisa ser uma data válida.', 'MAINTENANCE_CASE_WARRANTY_DEADLINE_INVALID');
    }
    maintenanceCase.warrantyDeadlineAt = warrantyDeadlineAt;
    slaRecalcNeeded = true;
  }
  if (severity !== undefined) {
    maintenanceCase.severity = validateSeverity(severity);
    slaRecalcNeeded = true;
  }

  const now = new Date();
  if (slaRecalcNeeded) {
    // BUG CORRIGIDO (30/09/2026, achado via smoke test do postObraHealth.service.js): o model
    // MaintenanceCase usa `createdAt: 'created_at'` como opção de timestamps, que renomeia o
    // atributo JS para `created_at` — `maintenanceCase.createdAt` (camelCase) sempre era
    // `undefined`, então o fallback nunca usava a data de criação real quando
    // `warrantyDeadlineAt` não estava definido (caía direto em `now`, calculando o SLA a partir
    // do momento da EDIÇÃO em vez da criação do caso).
    const slaBaseDate = maintenanceCase.warrantyDeadlineAt || maintenanceCase.created_at || now;
    maintenanceCase.slaDueAt = computeSlaDueAt(slaBaseDate, maintenanceCase.severity);
  }
  // Recalcula o nível de escalonamento sempre que o caso é tocado (mesma regra usada pelo job
  // periódico) — evita mostrar um `escalation_level` desatualizado logo após uma edição manual.
  maintenanceCase.escalationLevel = computeEscalationLevel(maintenanceCase.slaDueAt, now);

  maintenanceCase.updatedBy = actorUserId || null;
  await maintenanceCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      actorUserId,
      action: 'construction.maintenance_case.update',
      entityType: 'MaintenanceCase',
      entityId: maintenanceCase.id,
      beforeJson,
      afterJson: maintenanceCase.toJSON(),
      reason: `Chamado de pós-obra ${maintenanceCase.id} atualizado.`,
    },
    transaction
  );

  // M6-80: evento de fechamento. Convenção deste evento é `warranty.case.closed`, SEM o
  // prefixo `construction.` usado pelos demais eventos do módulo (`construction.project.*`,
  // `construction.maintenance_case.opened` etc) — nome canônico pedido explicitamente na
  // especificação (M6-80), documentado aqui para quem for procurar o evento de abertura e
  // estranhar o prefixo diferente do de fechamento.
  if (previousStatus !== 'CLOSED' && maintenanceCase.status === 'CLOSED') {
    await publishWarrantyCaseClosed(maintenanceCase, transaction);
  }

  return maintenanceCase;
}

async function removeMaintenanceCase(id, actorUserId, transaction) {
  const maintenanceCase = await getMaintenanceCase(id, transaction);
  const beforeJson = maintenanceCase.toJSON();
  maintenanceCase.deletedBy = actorUserId || null;
  await maintenanceCase.save({ transaction });
  await maintenanceCase.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      actorUserId,
      action: 'construction.maintenance_case.delete',
      entityType: 'MaintenanceCase',
      entityId: maintenanceCase.id,
      beforeJson,
      reason: `Chamado de pós-obra ${maintenanceCase.id} excluído.`,
    },
    transaction
  );

  return { id: maintenanceCase.id };
}

// --- WarrantyAction (M6-15/M6-16): histórico de ações de atendimento dentro do chamado ---

async function createWarrantyAction(warrantyCaseId, payload, actorUserId, transaction) {
  const maintenanceCase = await getMaintenanceCase(warrantyCaseId, transaction);
  const { description, performedByUserId, performedAt, cost } = payload;
  if (!description) {
    throw AppError.badRequest('O campo "description" é obrigatório.', 'WARRANTY_ACTION_VALIDATION');
  }

  const action = await WarrantyAction.create(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      warrantyCaseId: maintenanceCase.id,
      description,
      performedByUserId: performedByUserId || actorUserId || null,
      performedAt: performedAt || new Date(),
      cost: cost != null ? cost : null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      actorUserId,
      action: 'construction.warranty_action.create',
      entityType: 'WarrantyAction',
      entityId: action.id,
      afterJson: action.toJSON(),
      reason: `Ação de garantia registrada para o chamado ${maintenanceCase.id}.`,
    },
    transaction
  );

  return action;
}

async function listWarrantyActions(warrantyCaseId, transaction) {
  await getMaintenanceCase(warrantyCaseId, transaction);
  return WarrantyAction.findAll({
    where: { warrantyCaseId },
    order: [['performed_at', 'DESC']],
    transaction,
  });
}

module.exports = {
  createMaintenanceCase,
  listMaintenanceCases,
  getMaintenanceCase,
  updateMaintenanceCase,
  removeMaintenanceCase,
  createWarrantyAction,
  listWarrantyActions,
  computeSlaDueAt,
  computeEscalationLevel,
  STATUSES,
  CATEGORIES,
  SEVERITIES,
  ROOT_CAUSE_CODES,
  ESCALATION_LEVELS,
  SEVERITY_SLA_DAYS,
};
