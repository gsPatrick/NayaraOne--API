'use strict';

const { Op } = require('sequelize');
const { FiscalObligation } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');

const OBLIGATION_TYPES = { DIMOB_ANNUAL: 'DIMOB anual' };

function pad(n) { return String(n).padStart(2, '0'); }

// Último dia útil (segunda a sexta) de fevereiro do ano seguinte: prazo padrão da DIMOB. Feriados
// não entram no cálculo — por isso a data pode ser corrigida por quem cadastra a obrigação.
function defaultDimobDueDate(referenceYear) {
  const year = referenceYear + 1;
  const date = new Date(Date.UTC(year, 2, 0)); // último dia de fevereiro
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * ensureObligation — cria a obrigação do tipo/ano se ainda não existir (única por empresa/tipo/ano).
 * Retorna a existente quando já há uma.
 */
async function ensureObligation({ obligationType, referenceYear, dueAt, description }, actorUserId, groupId, companyId, transaction) {
  if (!OBLIGATION_TYPES[obligationType]) {
    throw AppError.badRequest(`Tipo de obrigação inválido. Use: ${Object.keys(OBLIGATION_TYPES).join(', ')}.`, 'FISCAL_OBLIGATION_VALIDATION');
  }
  const year = Number(referenceYear);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw AppError.badRequest('O campo "referenceYear" deve ser um ano válido.', 'FISCAL_OBLIGATION_VALIDATION');
  }
  const due = dueAt || defaultDimobDueDate(year);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due)) || Number.isNaN(Date.parse(due))) {
    throw AppError.badRequest('O campo "dueAt" deve estar no formato AAAA-MM-DD.', 'FISCAL_OBLIGATION_VALIDATION');
  }

  const existing = await FiscalObligation.findOne({ where: { groupId, companyId, obligationType, referenceYear: year }, transaction });
  if (existing) return existing;

  const obligation = await FiscalObligation.create(
    {
      groupId, companyId, obligationType, referenceYear: year, dueAt: due, status: 'PENDING',
      description: description || `${OBLIGATION_TYPES[obligationType]} — ano-base ${year}`,
    },
    { transaction }
  );
  await registrarAuditoria(
    {
      groupId, companyId, actorUserId: actorUserId || null,
      action: 'correspondent.fiscal.obligation_created',
      entityType: 'FiscalObligation',
      entityId: obligation.id,
      reason: `Obrigação ${obligation.description} cadastrada com prazo em ${due}.`,
    },
    transaction
  );
  return obligation;
}

async function markOverdue(groupId, companyId, transaction) {
  await FiscalObligation.update(
    { status: 'OVERDUE' },
    { where: { groupId, companyId, status: 'PENDING', dueAt: { [Op.lt]: today() } }, transaction }
  );
}

/**
 * listObligations — calendário fiscal: PENDING vencida passa a OVERDUE; devolve dias até o prazo.
 */
async function listObligations(groupId, companyId, transaction) {
  await markOverdue(groupId, companyId, transaction);
  const rows = await FiscalObligation.findAll({ where: { groupId, companyId }, order: [['due_at', 'ASC']], transaction });
  const now = Date.parse(`${today()}T00:00:00Z`);
  return rows.map((row) => {
    const json = row.toJSON();
    json.typeLabel = OBLIGATION_TYPES[row.obligationType] || row.obligationType;
    json.daysUntilDue = Math.round((Date.parse(`${row.dueAt}T00:00:00Z`) - now) / 86400000);
    return json;
  });
}

async function completeObligation(obligationId, note, actorUserId, groupId, companyId, transaction, { dimobBatchId } = {}) {
  const obligation = await FiscalObligation.findOne({ where: { id: obligationId, groupId, companyId }, transaction });
  if (!obligation) throw AppError.notFound('Obrigação fiscal não encontrada.', 'FISCAL_OBLIGATION_NOT_FOUND');
  if (obligation.status === 'COMPLETED') {
    throw AppError.conflict('Esta obrigação já foi concluída.', 'FISCAL_OBLIGATION_ALREADY_COMPLETED');
  }
  if (!dimobBatchId && (!note || String(note).trim().length < 3)) {
    throw AppError.badRequest('Concluir uma obrigação manualmente exige uma observação (mínimo 3 caracteres).', 'FISCAL_OBLIGATION_NOTE_REQUIRED');
  }
  const before = { status: obligation.status };
  obligation.status = 'COMPLETED';
  obligation.completedAt = new Date();
  if (dimobBatchId) obligation.dimobBatchId = dimobBatchId;
  await obligation.save({ transaction });
  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.fiscal.obligation_completed',
      entityType: 'FiscalObligation',
      entityId: obligation.id,
      beforeJson: before,
      afterJson: { status: 'COMPLETED', dimobBatchId: dimobBatchId || null },
      reason: dimobBatchId
        ? `Obrigação ${obligation.description} concluída pelo fechamento do batch DIMOB ${dimobBatchId}.`
        : `Obrigação ${obligation.description} concluída manualmente: ${String(note).trim()}.`,
    },
    transaction
  );
  return obligation;
}

/** completeByDimobBatch — o fechamento do batch anual conclui a obrigação do ano (cria se faltar). */
async function completeByDimobBatch(batch, actorUserId, groupId, companyId, transaction) {
  const obligation = await ensureObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear: batch.referenceYear }, actorUserId, groupId, companyId, transaction);
  if (obligation.status === 'COMPLETED') return obligation;
  return completeObligation(obligation.id, null, actorUserId, groupId, companyId, transaction, { dimobBatchId: batch.id });
}

module.exports = { ensureObligation, listObligations, completeObligation, completeByDimobBatch, defaultDimobDueDate, OBLIGATION_TYPES };
