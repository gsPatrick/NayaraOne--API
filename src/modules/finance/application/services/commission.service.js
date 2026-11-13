'use strict';

const AppError = require('../../../../utils/AppError');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../../../engines/rules/rulesEngine');
const { publishCommissionCreated } = require('./finance-events.service');
const repo = require('../../infrastructure/repositories/commission.repository');
const {
  STATUSES,
  RULE_CODE,
  RULE_NAME,
  RULE_DESCRIPTION,
  CONDITION_AST,
  COMPONENTS,
  BASE_TYPE,
  commissionRuleLockKey,
  buildRuleActionJson,
  ruleVersionContentHash,
  describePreviousRuleVersion,
  buildActiveRuleView,
  collectPublisherIds,
  toRuleVersionView,
  normalizeComponent,
  isInvalidCommissionSource,
  componentPercentage,
  computeCommissionTotal,
} = require('../../domain/commission');
// Parcelas, liberação, baixa e cancelamento ficam no arquivo irmão (reexportados abaixo).
const {
  getCommission,
  getCommissionRelease,
  generateInstallments,
  listCommissionInstallments,
  markInstallmentPaid,
  cancelCommission,
  getCommissionAdjustments,
} = require('./commission-installments.service');

// BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-09 — mesmo padrão do achado em
// inventory.movements.service.js/recordMovement): criar uma comissão é uma operação
// REEXECUTÁVEL (POST manual, retry de rede/duplo-clique reenvia o mesmo cálculo) que gera uma
// obrigação financeira real (Commission + parcelas), e não tinha NENHUMA proteção contra
// duplicidade — nem campo de idempotência, nem UNIQUE constraint que pegasse o caso. Fail
// closed: idempotencyKey agora é obrigatória aqui, única por empresa (migration
// 20260101000325-add-idempotency-key-to-commissions.js).

// Regra de comissão no Motor de Regras (Caderno §14 / FIN-011): ver domain/commission.js.

function validateComponentPercentages(componentPercentages) {
  if (!componentPercentages || typeof componentPercentages !== 'object' || Array.isArray(componentPercentages)) {
    throw AppError.badRequest(
      `"componentPercentages" é obrigatório: objeto com o percentual de cada componente (${COMPONENTS.join(', ')}).`,
      'FINANCE_COMMISSION_RULE_VALIDATION'
    );
  }
  const normalized = {};
  for (const [key, value] of Object.entries(componentPercentages)) {
    if (!COMPONENTS.includes(key)) {
      throw AppError.badRequest(`Componente desconhecido "${key}". Use: ${COMPONENTS.join(', ')}.`, 'FINANCE_COMMISSION_RULE_VALIDATION');
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 100) {
      throw AppError.badRequest(`O percentual de "${key}" deve estar entre 0 (exclusivo) e 100.`, 'FINANCE_COMMISSION_RULE_VALIDATION');
    }
    normalized[key] = numeric;
  }
  if (Object.keys(normalized).length === 0) {
    throw AppError.badRequest('Informe o percentual de pelo menos um componente.', 'FINANCE_COMMISSION_RULE_VALIDATION');
  }
  return normalized;
}

/**
 * publishCommissionRuleVersion — publica nova versão de REG-FIN-002 (a anterior tem a vigência
 * encerrada; comissões já calculadas continuam apontando para a versão que usaram).
 */
async function publishCommissionRuleVersion(payload, actorUserId, transaction) {
  const { groupId, companyId, componentPercentages, description } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCE_COMMISSION_RULE_VALIDATION');
  }
  const normalized = validateComponentPercentages(componentPercentages);

  const lockKey = commissionRuleLockKey(groupId, companyId);
  await repo.lockCommissionRule(lockKey, transaction);

  let rule = await repo.findRuleByCode(RULE_CODE, groupId, companyId, transaction);
  if (!rule) {
    rule = await repo.createRule(
      {
        groupId,
        companyId,
        code: RULE_CODE,
        name: RULE_NAME,
        description: RULE_DESCRIPTION,
        domain: 'finance',
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      transaction
    );
  }
  const now = new Date();
  // Auditoria antes/depois: a versão vigente antes desta publicação.
  const previous = await repo.findCurrentPublishedRuleVersion(rule.id, transaction);
  const beforeJson = describePreviousRuleVersion(previous);
  await repo.closeCurrentRuleVersions(rule.id, { effectiveUntil: now, updatedBy: actorUserId || null }, transaction);
  const last = await repo.findLastRuleVersion(rule.id, transaction);
  const actionJson = buildRuleActionJson(normalized, description);
  const version = await repo.createRuleVersion(
    {
      groupId,
      companyId,
      ruleId: rule.id,
      versionNumber: last ? last.versionNumber + 1 : 1,
      conditionAstJson: CONDITION_AST,
      contentHash: ruleVersionContentHash(actionJson),
      actionJson,
      effectiveFrom: now,
      effectiveUntil: null,
      status: 'PUBLISHED',
      publishedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    transaction
  );
  await repo.createRuleScope(
    { groupId, companyId, ruleVersionId: version.id, scopeType: 'GLOBAL', scopeRefId: null, precedence: 7, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    transaction
  );
  await repo.createRulePublication(
    { groupId, companyId, ruleVersionId: version.id, publishedByUserId: actorUserId || null, publishedAt: now, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    transaction
  );
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.commission_rule.publish',
      entityType: 'RuleVersion',
      entityId: version.id,
      beforeJson,
      afterJson: { ruleCode: RULE_CODE, versionNumber: version.versionNumber, ...actionJson, effectiveFrom: now, effectiveUntil: null },
      reason: `Nova versão da regra de comissão (${RULE_CODE} v${version.versionNumber}) publicada.`,
    },
    transaction
  );
  return { id: version.id, ruleCode: RULE_CODE, versionNumber: version.versionNumber, components: normalized, base: BASE_TYPE };
}

async function resolveCommissionRule(groupId, companyId, transaction) {
  const evaluation = await evaluateRule(RULE_CODE, { commissionRuleActive: true, groupId, companyId }, { groupId, companyId }, { transaction });
  if (evaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      `Não há regra de comissão publicada para esta empresa (${RULE_CODE}) — publique o percentual de cada componente antes de registrar comissões.`,
      'FINANCE_COMMISSION_RULE_NOT_CONFIGURED',
      { reason: evaluation.reason }
    );
  }
  return { ruleVersionId: evaluation.ruleVersionId, action: evaluation.action || {} };
}

async function getActiveCommissionRule(groupId, companyId, transaction) {
  const { ruleVersionId, action } = await resolveCommissionRule(groupId, companyId, transaction);
  // M45: número da versão e início de vigência para a tela mostrar "versão 3, desde dd/mm/aaaa"
  // em vez do identificador interno.
  const version = ruleVersionId ? await repo.findRuleVersionSummary(ruleVersionId, transaction) : null;
  return buildActiveRuleView(ruleVersionId, version, action);
}

/**
 * listCommissionRuleVersions — M45-RECONF F3: histórico completo das versões publicadas da regra
 * (número, percentuais, vigência, quem publicou e quando), da mais nova para a mais antiga.
 */
async function listCommissionRuleVersions(groupId, companyId, transaction) {
  const rule = await repo.findRuleByCode(RULE_CODE, groupId, companyId, transaction);
  if (!rule) return [];
  const versions = await repo.listRuleVersions(rule.id, transaction);
  const publisherIds = collectPublisherIds(versions);
  const users = publisherIds.length ? await repo.findUsersByIds(publisherIds, transaction) : [];
  const nameById = new Map(users.map((u) => [u.id, u.name || u.email]));
  return versions.map((v) => toRuleVersionView(v, nameById));
}

/**
 * createCommission — registra o DIREITO à comissão a partir do fato gerador (lançamento a
 * receber `sourceEntryId`) e do componente. Percentual e base vêm da regra REG-FIN-002 vigente;
 * a comissão grava a `ruleVersionId` usada.
 */
async function createCommission(payload, actorUserId, transaction) {
  const { groupId, companyId, opportunityId, contractId, beneficiaryUserId, sourceEntryId, component, installmentsCount, firstDueAt, idempotencyKey } = payload;

  if (!groupId || !companyId || !beneficiaryUserId || !sourceEntryId || !component) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "beneficiaryUserId", "sourceEntryId" (fato gerador) e "component" são obrigatórios.',
      'FINANCE_COMMISSION_VALIDATION'
    );
  }
  if (payload.percentage !== undefined || payload.baseAmount !== undefined || payload.ruleVersionId !== undefined) {
    throw AppError.badRequest(
      'Percentual, base e versão da regra não são informados no pedido: vêm da regra de comissão vigente (Caderno §14).',
      'FINANCE_COMMISSION_VALUES_FROM_RULE'
    );
  }
  const normalizedComponent = normalizeComponent(component);
  if (!COMPONENTS.includes(normalizedComponent)) {
    throw AppError.badRequest(`O campo "component" deve ser um de: ${COMPONENTS.join(', ')}.`, 'FINANCE_COMMISSION_VALIDATION');
  }
  if (!idempotencyKey) {
    throw AppError.badRequest(
      'Falta a chave de segurança contra duplicidade da comissão. Tente de novo; se persistir, avise o administrador.',
      'FINANCE_COMMISSION_IDEMPOTENCY_KEY_REQUIRED'
    );
  }
  const existingByKey = await repo.findCommissionByIdempotencyKey(companyId, idempotencyKey, transaction);
  if (existingByKey) {
    throw AppError.conflict(
      'Esta comissão já foi registrada para este recebimento.',
      'FINANCE_COMMISSION_DUPLICATE',
      { existingId: existingByKey.id }
    );
  }

  const sourceEntry = await repo.findCompanyEntryForUpdate(sourceEntryId, companyId, transaction);
  if (!sourceEntry) {
    throw AppError.notFound('O lançamento de origem (fato gerador) não existe nesta empresa.', 'FINANCE_COMMISSION_SOURCE_NOT_FOUND');
  }
  if (isInvalidCommissionSource(sourceEntry)) {
    throw AppError.conflict(
      'O fato gerador da comissão precisa ser um lançamento a receber próprio e válido (não caução, não cancelado/estornado, não baixa parcial).',
      'FINANCE_COMMISSION_SOURCE_INVALID'
    );
  }
  const duplicateFact = await repo.findActiveCommissionForFact(
    { companyId, sourceEntryId, component: normalizedComponent, beneficiaryUserId },
    transaction
  );
  if (duplicateFact) {
    throw AppError.conflict(
      'Já existe comissão deste componente para este beneficiário sobre o mesmo fato gerador.',
      'FINANCE_COMMISSION_DUPLICATE_FACT',
      { existingId: duplicateFact.id }
    );
  }

  const { ruleVersionId, action } = await resolveCommissionRule(groupId, companyId, transaction);
  const percentageNumeric = componentPercentage(action, normalizedComponent);
  if (!Number.isFinite(percentageNumeric) || percentageNumeric <= 0) {
    throw AppError.unprocessable(
      `A regra de comissão vigente não define percentual para o componente ${normalizedComponent}.`,
      'FINANCE_COMMISSION_RULE_COMPONENT_NOT_CONFIGURED'
    );
  }
  const baseNumeric = Number(sourceEntry.amount);
  const totalAmount = computeCommissionTotal(baseNumeric, percentageNumeric);

  const commission = await repo.createCommission(
    {
      groupId,
      companyId,
      opportunityId: opportunityId || null,
      contractId: contractId || sourceEntry.contractId || null,
      beneficiaryUserId,
      baseAmount: baseNumeric,
      percentage: percentageNumeric,
      totalAmount,
      ruleVersionId,
      sourceEntryId,
      component: normalizedComponent,
      status: 'PENDING',
      idempotencyKey,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    transaction
  );

  const installments = await generateInstallments(commission, installmentsCount || 1, firstDueAt, actorUserId, transaction);

  await publishCommissionCreated(commission, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.commission.create',
      entityType: 'Commission',
      entityId: commission.id,
      afterJson: { commission: commission.toJSON(), installments: installments.map((i) => i.toJSON()), ruleVersionId, ruleCode: RULE_CODE },
      reason: `Comissão ${normalizedComponent} de ${totalAmount} (${percentageNumeric}% sobre ${baseNumeric}, regra ${RULE_CODE} versão ${ruleVersionId}) registrada a partir do lançamento ${sourceEntryId}.`,
    },
    transaction
  );

  return { commission, installments };
}

async function listCommissions(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.beneficiaryUserId) where.beneficiaryUserId = filters.beneficiaryUserId;
  const commissions = await repo.listCommissions(where, transaction);
  if (!filters.includeInstallments) return commissions;
  // O2 (auditoria M45): a tela fazia 1 chamada /installments por comissão (N+1, ~3 min).
  // Agora uma única consulta traz as parcelas de todas as comissões listadas.
  const ids = commissions.map((c) => c.id);
  const installments = ids.length
    ? await repo.listInstallmentsForCommissions(ids, transaction)
    : [];
  const byCommission = new Map();
  for (const i of installments) {
    if (!byCommission.has(i.commissionId)) byCommission.set(i.commissionId, []);
    byCommission.get(i.commissionId).push(i.toJSON());
  }
  return commissions.map((c) => ({ ...c.toJSON(), installments: byCommission.get(c.id) || [] }));
}

module.exports = {
  publishCommissionRuleVersion,
  listCommissionRuleVersions,
  getActiveCommissionRule,
  getCommissionRelease,
  RULE_CODE,
  COMPONENTS,
  createCommission,
  listCommissions,
  getCommission,
  listCommissionInstallments,
  markInstallmentPaid,
  cancelCommission,
  getCommissionAdjustments,
  STATUSES,
};
