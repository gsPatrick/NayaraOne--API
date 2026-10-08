'use strict';

const { MaintenanceCase, WarrantyAction } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishMaintenanceCaseOpened, publishWarrantyCaseClosed } = require('./constructionEvents.service');
const { getApprovalThreshold } = require('./lossRecords.service');
const financialEntriesService = require('../finance/financialEntries.service');
const { getOrCreateDefaultCostCenter } = require('../finance/costCenters.service');
// BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato, Centro Financeiro
// BLINDADO v1, §4): ver getOrCreateDefaultCostCenter em costCenters.service.js.
const WARRANTY_COST_CENTER_CODE = 'OBRAS-GARANTIA';
const { setTeamAndMaterial } = require('./warrantyActionTeamMaterialColumns');
const { getActiveSlaDaysMap, DEFAULT_SLA_DAYS } = require('./slaRules.service');

const RESOLUTION_TYPES = ['DISCOUNT', 'REIMBURSEMENT'];
const CONTEXT_WARRANTY_RESOLUTION = 'WARRANTY_RESOLUTION';

// DECISÃO DE ENGENHARIA: status de MaintenanceCase (pós-obra/garantia) é STRING(32) livre nas
// fontes, sem enum documentado — workflow abaixo segue o mesmo padrão de "chamado" já usado
// em finance.approval_requests e crm.opportunities (aberto -> em andamento -> resolvido/fechado).
const STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
// Grafo de transição válido — mesmo usado no front (app/painel/obras/pos-obra/[id]/page.js,
// NEXT_STATUS_OPTIONS). CLOSED é terminal: reabertura exige fluxo próprio (fora de escopo aqui).
const NEXT_STATUS_OPTIONS = {
  OPEN: ['IN_PROGRESS', 'RESOLVED'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

// M6-15/M6-16: WarrantyCase estruturado. `category` e `root_cause_code` são "enum simples
// configurável" (nenhum documento fonte define lista fechada) — mantidos como STRING livre no
// banco, mas com uma lista padrão validada aqui em código (fácil trocar por uma tabela de
// configuração depois, sem migração, se o negócio pedir listas por tenant).
const CATEGORIES = ['STRUCTURAL', 'ELECTRICAL', 'HYDRAULIC', 'FINISHING', 'WATERPROOFING', 'OTHER'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const ROOT_CAUSE_CODES = ['MATERIAL_DEFECT', 'WORKMANSHIP', 'DESIGN_FLAW', 'MISUSE', 'NATURAL_WEAR', 'OTHER'];
const ESCALATION_LEVELS = ['NONE', 'WARNING', 'CRITICAL', 'OVERDUE'];

// Achado em auditoria (01/10/2026): enums acima vazavam crus em inglês nas mensagens de erro do
// usuário — labels em PT usados só para compor as mensagens abaixo, o valor salvo no banco
// continua o código em inglês.
const CATEGORY_LABELS_PT = {
  STRUCTURAL: 'Estrutural',
  ELECTRICAL: 'Elétrica',
  HYDRAULIC: 'Hidráulica',
  FINISHING: 'Acabamento',
  WATERPROOFING: 'Impermeabilização',
  OTHER: 'Outro',
};
const SEVERITY_LABELS_PT = { LOW: 'Baixa', MEDIUM: 'Média', HIGH: 'Alta', CRITICAL: 'Crítica' };
const STATUS_LABELS_PT = { OPEN: 'Aberto', IN_PROGRESS: 'Em andamento', RESOLVED: 'Resolvido', CLOSED: 'Fechado' };
const RESOLUTION_TYPE_LABELS_PT = { DISCOUNT: 'Desconto', REIMBURSEMENT: 'Ressarcimento' };

// M6-63/M6-88: prazo de atendimento (em dias) por severidade, usado para calcular `sla_due_at`
// a partir de `warranty_deadline_at` (quando informado) ou da data de abertura do caso.
//
// GAP CORRIGIDO (auditoria pós-Marco 6, item 1): o mapa de dias por severidade era uma
// constante fixa aqui (`SEVERITY_SLA_DAYS`) — o catálogo do contrato lista `REG-OBR-002`
// ("Prazo padrão de pós-obra") como regra do Motor de Regras genérico. Movido para
// slaRules.service.js (mesmo padrão de REG-OBR-001/marginRules.service.js — Rule/RuleVersion
// versionado, fail-closed, com seed automático do valor default no primeiro uso de cada
// tenant). `SEVERITY_SLA_DAYS` continua exportado abaixo (== DEFAULT_SLA_DAYS) só por
// compatibilidade de quem importava a constante antes desta migração.
const SEVERITY_SLA_DAYS = DEFAULT_SLA_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;

async function computeSlaDueAt(baseDate, severity, groupId, companyId, transaction, actorUserId) {
  const base = baseDate ? new Date(baseDate) : new Date();
  const { slaDays } = await getActiveSlaDaysMap(groupId, companyId, transaction, actorUserId);
  const days = slaDays[severity] != null ? slaDays[severity] : slaDays.MEDIUM;
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
    throw AppError.badRequest(
      `"category" deve ser um de: ${CATEGORIES.map((c) => CATEGORY_LABELS_PT[c]).join(', ')}.`,
      'MAINTENANCE_CASE_CATEGORY_INVALID'
    );
  }
  return normalized;
}

function validateSeverity(severity) {
  const normalized = String(severity || 'MEDIUM').toUpperCase();
  if (!SEVERITIES.includes(normalized)) {
    throw AppError.badRequest(
      `"severity" deve ser um de: ${SEVERITIES.map((s) => SEVERITY_LABELS_PT[s]).join(', ')}.`,
      'MAINTENANCE_CASE_SEVERITY_INVALID'
    );
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

// BUG REAL CORRIGIDO (auditoria "loop até secar", Categoria 14, ciclo 2): laborCost/
// materialCost (MaintenanceCase) e cost (WarrantyAction) nunca passavam por nenhuma validação
// numérica — iam direto do payload pro DECIMAL(14,2)/DECIMAL(14,2) do banco. "NaN"/"Infinity"
// (string) ou negativo persistiam silenciosamente (Postgres aceita o literal), corrompendo o
// histórico de custo do chamado e os agregados de totalLaborCost/totalMaterialCost/
// totalWarrantyCost em postObraHealth.service.js.
function validateMonetaryCost(value, fieldName) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw AppError.badRequest(`"${fieldName}" deve ser um número maior ou igual a zero.`, 'MAINTENANCE_CASE_COST_INVALID');
  }
  return numeric;
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

  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 11): createMaintenanceCase nunca validava
  // warrantyDeadlineAt — updateMaintenanceCase já valida a mesma data, mas a criação ia direto
  // pro create/computeSlaDueAt com uma string inválida, estourando erro cru de tipo do Postgres.
  if (warrantyDeadlineAt !== undefined && warrantyDeadlineAt !== null && Number.isNaN(new Date(warrantyDeadlineAt).getTime())) {
    throw AppError.badRequest('"warrantyDeadlineAt" precisa ser uma data válida.', 'MAINTENANCE_CASE_WARRANTY_DEADLINE_INVALID');
  }

  const normalizedSeverity = validateSeverity(severity);
  const now = new Date();
  const slaBaseDate = warrantyDeadlineAt || now;
  const slaDueAt = await computeSlaDueAt(slaBaseDate, normalizedSeverity, groupId, companyId, transaction, actorUserId);

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
      laborCost: validateMonetaryCost(laborCost, 'laborCost') ?? null,
      materialCost: validateMonetaryCost(materialCost, 'materialCost') ?? null,
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

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 42, 2026-10-05): proposeWarrantyResolution
// e approveWarrantyResolution liam o caso sem lock pessimista antes de decidir resolutionStatus
// e criar o lançamento financeiro — mesma classe de bug das rodadas 40/41 (payInsurancePolicyInstallment,
// resolveDiscrepancy). `lock` opcional (default false) preserva o comportamento dos chamadores
// read-only/não-financeiros deste mesmo helper.
async function getMaintenanceCase(id, transaction, lock = false) {
  const maintenanceCase = await MaintenanceCase.findByPk(id, {
    transaction,
    lock: lock ? transaction.LOCK.UPDATE : undefined,
  });
  if (!maintenanceCase) throw AppError.notFound('Chamado de pós-obra não encontrado.', 'MAINTENANCE_CASE_NOT_FOUND');
  return maintenanceCase;
}

async function updateMaintenanceCase(id, payload, actorUserId, transaction) {
  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 2 de código, 2026-10-06): mesma classe de bug
  // das rodadas 40-42 (proposeWarrantyResolution/approveWarrantyResolution) — updateMaintenanceCase
  // lia o caso sem lock pessimista antes de decidir status/escalationLevel/slaDueAt e salvar. Duas
  // edições concorrentes do mesmo chamado (ex.: duas mudanças de status simultâneas) causavam
  // lost-update. Alinhado ao padrão já usado nos demais métodos de escrita deste arquivo.
  const maintenanceCase = await getMaintenanceCase(id, transaction, true);
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
      throw AppError.badRequest(
        `"status" deve ser um de: ${STATUSES.map((s) => STATUS_LABELS_PT[s]).join(', ')}.`,
        'MAINTENANCE_CASE_STATUS_INVALID'
      );
    }
    // BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 2, 2026-10-06): updateMaintenanceCase
    // só validava que o valor pertencia à lista de status, sem checar a SEQUÊNCIA — era possível
    // pular etapas (OPEN->CLOSED direto) ou reabrir um caso já CLOSED via chamada direta à API
    // (Postman/integração), ignorando a trava que só existia no front (NEXT_STATUS_OPTIONS em
    // app/painel/obras/pos-obra/[id]/page.js). Isso é grave porque CLOSED dispara
    // publishWarrantyCaseClosed (evento) e reseta escalationLevel — pular pra lá sem passar pelo
    // atendimento real, ou reabrir sem justificativa, não deixava rastro nenhum. Grafo replicado
    // do front, agora também fail-closed no backend.
    if (normalizedStatus !== previousStatus && !NEXT_STATUS_OPTIONS[previousStatus]?.includes(normalizedStatus)) {
      throw AppError.conflict(
        `Transição de status inválida: "${STATUS_LABELS_PT[previousStatus]}" não pode ir direto para "${STATUS_LABELS_PT[normalizedStatus]}".`,
        'MAINTENANCE_CASE_STATUS_TRANSITION_INVALID'
      );
    }
    // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato, "Construção + Obras +
    // Pós-obra — BLINDADO v1" §2/§9: "Pós-obra possui SLA, causa, materiais, mão de obra, custo
    // e evidências" / "WarrantyCase contém categoria, severidade, SLA, responsável, antes/depois,
    // custos e causa."): CLOSED não exigia causa raiz, fotos antes/depois nem nenhuma ação de
    // atendimento registrada — dava pra fechar um chamado OPEN→IN_PROGRESS→RESOLVED→CLOSED sem
    // nenhum desses dados. Fail closed: exige os três (usando o estado final do caso após os
    // outros campos deste mesmo payload serem aplicados, para permitir enviar tudo numa única
    // chamada "resolver e fechar").
    if (normalizedStatus === 'CLOSED' && previousStatus !== 'CLOSED') {
      const finalRootCauseCode = rootCauseCode !== undefined ? validateRootCauseCode(rootCauseCode) : maintenanceCase.rootCauseCode;
      if (!finalRootCauseCode) {
        throw AppError.badRequest('Não é possível fechar o chamado sem "rootCauseCode" (causa raiz).', 'MAINTENANCE_CASE_CLOSE_REQUIRES_ROOT_CAUSE');
      }
      const finalBeforeMedia = beforeMediaFileIds !== undefined ? validateMediaFileIds(beforeMediaFileIds, 'beforeMediaFileIds') : maintenanceCase.beforeMediaFileIds;
      const finalAfterMedia = afterMediaFileIds !== undefined ? validateMediaFileIds(afterMediaFileIds, 'afterMediaFileIds') : maintenanceCase.afterMediaFileIds;
      if (!Array.isArray(finalBeforeMedia) || finalBeforeMedia.length === 0 || !Array.isArray(finalAfterMedia) || finalAfterMedia.length === 0) {
        throw AppError.badRequest('Não é possível fechar o chamado sem evidências "antes" e "depois" ("beforeMediaFileIds"/"afterMediaFileIds").', 'MAINTENANCE_CASE_CLOSE_REQUIRES_EVIDENCE');
      }
      const actionCountForClose = await WarrantyAction.count({ where: { warrantyCaseId: id }, transaction });
      if (actionCountForClose === 0) {
        throw AppError.badRequest('Não é possível fechar o chamado sem nenhuma ação de atendimento registrada.', 'MAINTENANCE_CASE_CLOSE_REQUIRES_ACTION');
      }
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
  if (laborCost !== undefined) maintenanceCase.laborCost = validateMonetaryCost(laborCost, 'laborCost');
  if (materialCost !== undefined) maintenanceCase.materialCost = validateMonetaryCost(materialCost, 'materialCost');

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
    maintenanceCase.slaDueAt = await computeSlaDueAt(
      slaBaseDate,
      maintenanceCase.severity,
      maintenanceCase.groupId,
      maintenanceCase.companyId,
      transaction,
      actorUserId
    );
  }
  // Recalcula o nível de escalonamento sempre que o caso é tocado (mesma regra usada pelo job
  // periódico) — evita mostrar um `escalation_level` desatualizado logo após uma edição manual.
  //
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 13, 2026-10-05): o recálculo rodava
  // incondicionalmente, mesmo pra um caso que acabou de virar CLOSED — como `slaDueAt` continua
  // no passado pra sempre, o caso fechado ficava marcado OVERDUE eternamente, poluindo a
  // agregação `casesByEscalationLevel` de `postObraHealth.service.js` (um caso já resolvido
  // nunca deveria contar como "atrasado" em nenhum painel). Caso CLOSED sempre zera pra NONE;
  // caso aberto continua recalculando normalmente.
  maintenanceCase.escalationLevel = maintenanceCase.status === 'CLOSED'
    ? 'NONE'
    : computeEscalationLevel(maintenanceCase.slaDueAt, now);

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

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 56, 2026-10-06): removeMaintenanceCase
// (soft delete) não checava WarrantyAction vinculadas — mesmo padrão já corrigido em
// removeProject (rodada 55). Sem a guarda, dava para excluir um chamado de garantia que já tinha
// ações/custos registrados, deixando o histórico de WarrantyAction.cost órfão sob um chamado
// oficialmente excluído.
async function removeMaintenanceCase(id, actorUserId, transaction) {
  const maintenanceCase = await getMaintenanceCase(id, transaction);

  const actionCount = await WarrantyAction.count({ where: { warrantyCaseId: id }, transaction });
  if (actionCount > 0) {
    throw AppError.conflict(
      'Não é possível excluir um chamado de garantia que já tem ações registradas.',
      'MAINTENANCE_CASE_DELETE_HAS_DEPENDENTS'
    );
  }
  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 10): a guarda da rodada 56 só cobria
  // WarrantyAction — um caso com resolução de garantia já aprovada e lançada no Financeiro
  // (resolutionFinancialEntryId preenchido) podia ser excluído sem bloqueio nenhum, deixando o
  // FinancialEntry já criado órfão de um MaintenanceCase oficialmente excluído.
  if (maintenanceCase.resolutionFinancialEntryId) {
    throw AppError.conflict(
      'Não é possível excluir um chamado de garantia que já tem uma resolução financeira lançada.',
      'MAINTENANCE_CASE_DELETE_HAS_DEPENDENTS'
    );
  }

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
  const { description, performedByUserId, performedAt, cost, assignedTeam, materialUsed } = payload;
  if (!description) {
    throw AppError.badRequest('O campo "description" é obrigatório.', 'WARRANTY_ACTION_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 10): não havia checagem de status — era
  // possível registrar nova ação (com custo) em um chamado já CLOSED (estado terminal,
  // NEXT_STATUS_OPTIONS.CLOSED = []), inflando silenciosamente os totais de custo em
  // postObraHealth.service.js para um chamado que o painel já trata como encerrado.
  if (maintenanceCase.status === 'CLOSED') {
    throw AppError.conflict(
      'Não é possível registrar uma ação de garantia em um chamado já encerrado.',
      'WARRANTY_ACTION_CASE_CLOSED'
    );
  }

  const action = await WarrantyAction.create(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      warrantyCaseId: maintenanceCase.id,
      description,
      performedByUserId: performedByUserId || actorUserId || null,
      performedAt: performedAt || new Date(),
      cost: validateMonetaryCost(cost, 'cost') ?? null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  // GAP CORRIGIDO (auditoria pós-Marco 6, item 2): equipe/material (fail-open até a migration
  // 20260101000296 ser aplicada — ver warrantyActionTeamMaterialColumns.js).
  await setTeamAndMaterial(action.id, assignedTeam, materialUsed, transaction);
  if (assignedTeam) action.assignedTeam = assignedTeam;
  if (materialUsed) action.materialUsed = materialUsed;

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

/**
 * proposeWarrantyResolution — M6-XX (achado em rodada de verificação de integrações,
 * 30/09/2026): "Desconto/ressarcimento passa por regra/aprovação e Financeiro". Registra a
 * proposta de desconto/ressarcimento; abaixo da alçada configurada (mesmo mecanismo de
 * `lossRecords.service.js`, contexto próprio `WARRANTY_RESOLUTION`), já nasce APPROVED e cria
 * o lançamento financeiro real imediatamente; acima da alçada, nasce PENDING_APPROVAL e exige
 * `approveWarrantyResolution` explícito antes de gerar qualquer efeito financeiro.
 */
async function proposeWarrantyResolution(id, payload, actorUserId, transaction) {
  const maintenanceCase = await getMaintenanceCase(id, transaction, true);
  const { resolutionType, resolutionAmount } = payload || {};
  const normalizedType = String(resolutionType || '').toUpperCase();
  if (!RESOLUTION_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(
      `"resolutionType" deve ser um de: ${RESOLUTION_TYPES.map((t) => RESOLUTION_TYPE_LABELS_PT[t]).join(', ')}.`,
      'WARRANTY_RESOLUTION_VALIDATION'
    );
  }
  const numericAmount = Number(resolutionAmount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw AppError.badRequest('"resolutionAmount" deve ser um número maior que zero.', 'WARRANTY_RESOLUTION_VALIDATION');
  }

  const threshold = await getApprovalThreshold(maintenanceCase.groupId, maintenanceCase.companyId, CONTEXT_WARRANTY_RESOLUTION, transaction);
  const withinThreshold = numericAmount <= threshold;

  maintenanceCase.resolutionType = normalizedType;
  maintenanceCase.resolutionAmount = numericAmount;
  maintenanceCase.resolutionStatus = withinThreshold ? 'APPROVED' : 'PENDING_APPROVAL';
  maintenanceCase.updatedBy = actorUserId || null;

  if (withinThreshold) {
    maintenanceCase.resolutionApprovedByUserId = actorUserId || null;
    await createWarrantyResolutionFinancialEntry(maintenanceCase, actorUserId, transaction);
  }
  await maintenanceCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      actorUserId,
      action: 'construction.maintenance_case.resolution_proposed',
      entityType: 'MaintenanceCase',
      entityId: maintenanceCase.id,
      afterJson: { resolutionType: normalizedType, resolutionAmount: numericAmount, resolutionStatus: maintenanceCase.resolutionStatus },
      reason: `Proposta de ${normalizedType === 'DISCOUNT' ? 'desconto' : 'ressarcimento'} de ${numericAmount} para o caso ${maintenanceCase.id}.`,
    },
    transaction
  );

  return maintenanceCase;
}

async function approveWarrantyResolution(id, actorUserId, transaction) {
  const maintenanceCase = await getMaintenanceCase(id, transaction, true);
  if (maintenanceCase.resolutionStatus !== 'PENDING_APPROVAL') {
    throw AppError.conflict('Não há resolução de garantia pendente de aprovação para este caso.', 'WARRANTY_RESOLUTION_NOT_PENDING');
  }
  maintenanceCase.resolutionStatus = 'APPROVED';
  maintenanceCase.resolutionApprovedByUserId = actorUserId || null;
  maintenanceCase.updatedBy = actorUserId || null;
  await createWarrantyResolutionFinancialEntry(maintenanceCase, actorUserId, transaction);
  await maintenanceCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      actorUserId,
      action: 'construction.maintenance_case.resolution_approved',
      entityType: 'MaintenanceCase',
      entityId: maintenanceCase.id,
      afterJson: { resolutionFinancialEntryId: maintenanceCase.resolutionFinancialEntryId },
      reason: `Resolução de garantia aprovada e integrada ao Financeiro para o caso ${maintenanceCase.id}.`,
    },
    transaction
  );

  return maintenanceCase;
}

/**
 * createWarrantyResolutionFinancialEntry — chama o service REAL do Financeiro (nenhum
 * financeiro paralelo/fake), idempotente via `idempotencyKey` UNIQUE derivada do id do caso —
 * aprovar a MESMA resolução mais de uma vez nunca cria dois lançamentos.
 */
async function createWarrantyResolutionFinancialEntry(maintenanceCase, actorUserId, transaction) {
  const costCenter = await getOrCreateDefaultCostCenter(
    maintenanceCase.groupId,
    maintenanceCase.companyId,
    WARRANTY_COST_CENTER_CODE,
    'Pós-obra — garantia',
    transaction
  );
  const entry = await financialEntriesService.createFinancialEntry(
    {
      groupId: maintenanceCase.groupId,
      companyId: maintenanceCase.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: maintenanceCase.resolutionAmount,
      description: `${maintenanceCase.resolutionType === 'DISCOUNT' ? 'Desconto' : 'Ressarcimento'} de garantia — caso ${maintenanceCase.id}`,
      idempotencyKey: `warranty.resolution:${maintenanceCase.id}`,
      constructionProjectId: maintenanceCase.projectId || null,
      costCenterId: costCenter.id,
    },
    actorUserId,
    transaction
  );
  maintenanceCase.resolutionFinancialEntryId = entry.id;
  return entry;
}

module.exports = {
  createMaintenanceCase,
  listMaintenanceCases,
  getMaintenanceCase,
  updateMaintenanceCase,
  removeMaintenanceCase,
  createWarrantyAction,
  listWarrantyActions,
  proposeWarrantyResolution,
  approveWarrantyResolution,
  computeSlaDueAt,
  computeEscalationLevel,
  STATUSES,
  CATEGORIES,
  SEVERITIES,
  ROOT_CAUSE_CODES,
  ESCALATION_LEVELS,
  SEVERITY_SLA_DAYS,
};
