'use strict';

const { ApprovalRequest, ApprovalStep, BankAccount, FinancialEntry, Commission, CommissionInstallment, OwnerRepass } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishApprovalRequestCreated, publishApprovalStepDecided } = require('./financeEvents.service');
const { assertRecentMfa } = require('../users/mfa.service');

// Motor genérico de dupla aprovação (maker-checker) — 03_MOTORES_TRANSVERSAIS.md: "Quem cria
// não aprova; quem aprova não altera; quem executa valida o hash aprovado."
//
// `finance.approval_requests` é polimórfico (`related_entity_type` + `related_entity_id`) e
// NÃO tem uma coluna de snapshot/hash (ver nota em financeAntifraud.service.js). A proteção
// equivalente aqui é lock otimista: quem decide pode informar `expectedLockVersion` (o
// lock_version que viu ao revisar o pedido); se a entidade mudou desde então, a decisão é
// recusada com FINANCE_APPROVAL_STALE em vez de aprovar algo que já não é mais o que foi visto.
const ENTITY_MODELS = {
  BankAccount,
  FinancialEntry,
  Commission,
  CommissionInstallment,
  OwnerRepass,
};

const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
// Nº de aprovações independentes exigidas por nível de risco. Não há essa configuração no
// documento/schema (approval_requests não tem uma coluna "required_steps") — é uma decisão de
// implementação razoável e documentada aqui, não um valor extraído de alguma fonte.
const REQUIRED_STEPS_BY_RISK = { LOW: 1, MEDIUM: 1, HIGH: 2, CRITICAL: 2 };

async function createApprovalRequest(payload, actorUserId, transaction) {
  const { groupId, companyId, relatedEntityType, relatedEntityId, riskLevel } = payload;
  if (!groupId || !companyId || !relatedEntityType || !relatedEntityId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "relatedEntityType" e "relatedEntityId" são obrigatórios.',
      'FINANCE_APPROVAL_VALIDATION'
    );
  }
  const normalizedRisk = riskLevel ? String(riskLevel).toUpperCase() : 'MEDIUM';
  if (!RISK_LEVELS.includes(normalizedRisk)) {
    throw AppError.badRequest(`O campo "riskLevel" deve ser um de: ${RISK_LEVELS.join(', ')}.`, 'FINANCE_APPROVAL_VALIDATION');
  }

  const existingPending = await ApprovalRequest.findOne({
    where: { relatedEntityType, relatedEntityId, status: 'PENDING' },
    transaction,
  });
  if (existingPending) {
    throw AppError.conflict('Já existe uma solicitação de aprovação pendente para esta entidade.', 'FINANCE_APPROVAL_ALREADY_PENDING', {
      existingId: existingPending.id,
    });
  }

  const approvalRequest = await ApprovalRequest.create(
    {
      groupId,
      companyId,
      relatedEntityType,
      relatedEntityId,
      requestedByUserId: actorUserId,
      status: 'PENDING',
      riskLevel: normalizedRisk,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishApprovalRequestCreated(approvalRequest, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.approval_request.create',
      entityType: 'ApprovalRequest',
      entityId: approvalRequest.id,
      afterJson: approvalRequest.toJSON(),
      reason: `Solicitação de aprovação criada para ${relatedEntityType} (risco ${normalizedRisk}).`,
    },
    transaction
  );

  return approvalRequest;
}

// ACHADO REAL (auditoria Nayara, rodada 4, 14/10/2026, M4-R01): a tela de Aprovações só exibia
// "Lançamento — <id curto>" (sem a descrição real) porque `approval_requests` é polimórfico e a
// listagem nunca resolvia a entidade relacionada — isso também quebrava a busca por texto, que
// filtrava sobre esse mesmo rótulo genérico. `relatedEntityLabel` resolve a descrição real da
// entidade (quando existir um campo apropriado) para cada request da página atual, em lotes por
// tipo (evita N+1 query por item).
// ACHADO REAL #2 (verificação complementar Nayara, 14/10/2026): a correção acima ainda deixava
// alguns itens só com o ID cru. Causa raiz: `FinancialEntry.description` é opcional
// (`allowNull: true`) — um lançamento criado sem descrição tinha `row.description` null, e o
// label virava null, caindo no fallback de ID cru no front (`lib/finance/labels.js`). O mesmo
// acontecia pra qualquer entidade não encontrada (apagada) ou tipo fora de `ENTITY_MODELS`.
// `buildFallbackLabel` garante que SEMPRE existe um texto legível em português — nunca null —
// usando os campos que toda entidade conhecida tem (nature/amount/dueAt pra FinancialEntry,
// criado-em pra qualquer coisa não mapeada).
const NATURE_LABELS = {
  PAYABLE: 'Despesa',
  RECEIVABLE: 'Receita',
  TRANSFER: 'Transferência',
  ADJUSTMENT: 'Ajuste',
  PENDING_CLASSIFICATION: 'A classificar',
};

function formatBrDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function formatBrAmount(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildFallbackLabel(request) {
  const createdAt = formatBrDate(request.createdAt || request.created_at);
  return createdAt ? `Solicitação criada em ${createdAt}` : 'Solicitação de aprovação';
}

async function resolveRelatedEntityLabels(requests, transaction) {
  const byType = {};
  requests.forEach((r) => {
    if (!byType[r.relatedEntityType]) byType[r.relatedEntityType] = new Set();
    byType[r.relatedEntityType].add(r.relatedEntityId);
  });

  const labelsByTypeAndId = {};
  await Promise.all(
    Object.entries(byType).map(async ([type, idSet]) => {
      const Model = ENTITY_MODELS[type];
      if (!Model) return;
      const ids = Array.from(idSet);
      const rows = await Model.findAll({ where: { id: ids }, transaction });
      labelsByTypeAndId[type] = {};
      rows.forEach((row) => {
        let label = null;
        if (type === 'FinancialEntry') {
          const natureLabel = NATURE_LABELS[row.nature] || row.nature || 'Lançamento';
          const amountLabel = formatBrAmount(row.amount);
          const dueLabel = formatBrDate(row.dueAt);
          label =
            row.description ||
            [natureLabel, amountLabel ? `R$ ${amountLabel}` : null, dueLabel ? `venc. ${dueLabel}` : null]
              .filter(Boolean)
              .join(' · ');
        } else if (type === 'BankAccount') label = row.pixKey ? `Chave PIX — ${row.pixKey}` : `${row.bankCode || 'Banco'} · Ag. ${row.agency || '—'} · Conta ${row.accountNumber || '—'}`;
        else if (type === 'Commission') label = `Comissão — ${row.percentage}% sobre ${row.baseAmount}`;
        else if (type === 'CommissionInstallment') label = `Parcela de comissão — ${row.amount || ''}`.trim();
        else if (type === 'OwnerRepass') label = `Repasse — ${row.referenceMonth || ''} · R$ ${row.netAmount || ''}`.trim();
        labelsByTypeAndId[type][row.id] = label || null;
      });
    })
  );

  return requests.map((r) => {
    const label = labelsByTypeAndId[r.relatedEntityType]?.[r.relatedEntityId] || buildFallbackLabel(r);
    const json = r.toJSON ? r.toJSON() : r;
    return { ...json, relatedEntityLabel: label };
  });
}

async function listApprovalRequests(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.relatedEntityType) where.relatedEntityType = filters.relatedEntityType;
  if (filters.relatedEntityId) where.relatedEntityId = filters.relatedEntityId;
  const requests = await ApprovalRequest.findAll({ where, order: [['created_at', 'DESC']], transaction });
  return resolveRelatedEntityLabels(requests, transaction);
}

async function getApprovalRequest(id, transaction) {
  const approvalRequest = await ApprovalRequest.findByPk(id, { transaction });
  if (!approvalRequest) throw AppError.notFound('Solicitação de aprovação não encontrada.', 'FINANCE_APPROVAL_NOT_FOUND');
  return approvalRequest;
}

/**
 * decideApprovalStep — maker-checker: quem solicitou não pode decidir a própria solicitação.
 * `expectedLockVersion` (opcional) é comparado contra o lock_version ATUAL da entidade
 * relacionada — se divergir, a entidade mudou depois que o aprovador a revisou e a decisão é
 * recusada (equivalente a invalidar por snapshot alterado, sem precisar de coluna de hash).
 */
async function decideApprovalStep(approvalRequestId, payload, approverUserId, transaction) {
  const { decision, expectedLockVersion } = payload;
  const normalizedDecision = String(decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(normalizedDecision)) {
    throw AppError.badRequest('O campo "decision" deve ser "APPROVED" ou "REJECTED".', 'FINANCE_APPROVAL_VALIDATION');
  }

  const approvalRequest = await getApprovalRequest(approvalRequestId, transaction);
  if (approvalRequest.status !== 'PENDING') {
    throw AppError.conflict(`Esta solicitação já foi decidida (status "${approvalRequest.status}").`, 'FINANCE_APPROVAL_ALREADY_DECIDED');
  }
  if (approvalRequest.requestedByUserId === approverUserId) {
    throw AppError.forbidden(
      'Quem solicitou a aprovação não pode aprovar a própria solicitação (segregação de funções — maker-checker).',
      'FINANCE_APPROVAL_SELF_APPROVAL_FORBIDDEN'
    );
  }

  const existingSteps = await ApprovalStep.findAll({ where: { approvalRequestId }, transaction });
  if (existingSteps.some((s) => s.approverUserId === approverUserId)) {
    throw AppError.conflict('Você já registrou uma decisão para esta solicitação.', 'FINANCE_APPROVAL_DUPLICATE_DECISION');
  }

  // Step-up MFA obrigatório para decisões de risco HIGH/CRITICAL (Caderno §3.3: "HIGH = MFA
  // recente + permissão + auditoria reforçada; CRITICAL = MFA recente + segregação/aprovação +
  // snapshot/hash + alerta + trilha"). Risco LOW/MEDIUM não exige MFA aqui.
  if (['HIGH', 'CRITICAL'].includes(approvalRequest.riskLevel)) {
    await assertRecentMfa(approverUserId, transaction);
  }

  if (expectedLockVersion !== undefined) {
    const Model = ENTITY_MODELS[approvalRequest.relatedEntityType];
    if (Model) {
      const entity = await Model.findByPk(approvalRequest.relatedEntityId, { transaction });
      if (entity && 'lockVersion' in entity.dataValues && Number(entity.lockVersion) !== Number(expectedLockVersion)) {
        throw AppError.conflict(
          'A entidade relacionada foi alterada desde que esta solicitação foi revisada — aprovação recusada por segurança (dado desatualizado).',
          'FINANCE_APPROVAL_STALE'
        );
      }
    }
  }

  // FIX (M4-24, 18/09/2026): a checagem "já decidiu?" acima (existingSteps.some(...)) é um
  // SELECT no início da função — sob concorrência real (duplo-clique, retry), duas transações
  // podem passar por ela ao mesmo tempo antes de qualquer uma commitar. A constraint única
  // approval_steps_request_approver_uk é quem realmente fecha a corrida: a segunda tentativa
  // falha aqui, convertida no mesmo erro de negócio que a checagem em memória já usava.
  let step;
  try {
    step = await ApprovalStep.create(
      {
        groupId: approvalRequest.groupId,
        companyId: approvalRequest.companyId,
        approvalRequestId,
        approverUserId,
        stepOrder: existingSteps.length + 1,
        decision: normalizedDecision,
        decidedAt: new Date(),
        createdBy: approverUserId || null,
        updatedBy: approverUserId || null,
      },
      { transaction }
    );
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict('Você já registrou uma decisão para esta solicitação.', 'FINANCE_APPROVAL_DUPLICATE_DECISION');
    }
    throw err;
  }

  await publishApprovalStepDecided(step, transaction);

  const beforeJson = approvalRequest.toJSON();
  if (normalizedDecision === 'REJECTED') {
    approvalRequest.status = 'REJECTED';
  } else {
    const approvedCount = existingSteps.filter((s) => s.decision === 'APPROVED').length + 1;
    const required = REQUIRED_STEPS_BY_RISK[approvalRequest.riskLevel] || 1;
    if (approvedCount >= required) {
      approvalRequest.status = 'APPROVED';
    }
  }
  approvalRequest.updatedBy = approverUserId || null;
  await approvalRequest.save({ transaction });

  await registrarAuditoria(
    {
      groupId: approvalRequest.groupId,
      companyId: approvalRequest.companyId,
      actorUserId: approverUserId,
      action: 'finance.approval_step.decide',
      entityType: 'ApprovalStep',
      entityId: step.id,
      beforeJson,
      afterJson: { step: step.toJSON(), approvalRequest: approvalRequest.toJSON() },
      reason: `Decisão "${normalizedDecision}" registrada para solicitação de aprovação (etapa ${step.stepOrder}).`,
    },
    transaction
  );

  return { step, approvalRequest };
}

/**
 * isApprovalRequestApproved — helper pra outros services (ex.: financialEntries.settleFinancialEntry)
 * checarem, antes de executar uma ação sensível, se já existe aprovação concluída pra ela.
 * Uso opcional — este módulo não força nenhum outro service a exigir aprovação automaticamente,
 * já que o schema não define um limiar de valor/risco que dispare isso obrigatoriamente.
 */
async function isApprovalRequestApproved(relatedEntityType, relatedEntityId, transaction) {
  const approvalRequest = await ApprovalRequest.findOne({
    where: { relatedEntityType, relatedEntityId, status: 'APPROVED' },
    transaction,
  });
  return Boolean(approvalRequest);
}

module.exports = {
  createApprovalRequest,
  listApprovalRequests,
  getApprovalRequest,
  decideApprovalStep,
  isApprovalRequestApproved,
  RISK_LEVELS,
  REQUIRED_STEPS_BY_RISK,
};
