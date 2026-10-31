'use strict';

const { FiscalObligation } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getFiscalSettings } = require('../commissionSplit.service');
const { brasiliaDate } = require('./fiscalCommon');

const OBLIGATION_TYPES = { DIMOB_ANNUAL: 'DIMOB anual' };

function pad(n) { return String(n).padStart(2, '0'); }

// Último dia útil (segunda a sexta) de fevereiro do ano seguinte: prazo padrão da DIMOB. Feriados
// não entram no cálculo — por isso a data pode ser corrigida por quem cadastra a obrigação.
function defaultDimobDueDate(referenceYear, dueMonth = 2) {
  const year = referenceYear + 1;
  const date = new Date(Date.UTC(year, dueMonth, 0)); // último dia do mês do prazo (padrão: fevereiro)
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// Hoje em Brasília (o servidor pode estar em outro fuso): perto da meia-noite o "vence hoje" não erra.
function today() {
  return brasiliaDate();
}

// Data de calendário real (AAAA-MM-DD): recusa 2026-02-31 e afins.
function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text))) return false;
  const [y, m, d] = String(text).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
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
  if (dueAt !== undefined && dueAt !== null && dueAt !== '') {
    if (typeof dueAt !== 'string' || !isRealDate(dueAt)) {
      throw AppError.badRequest('O campo "dueAt" deve ser uma data real no formato AAAA-MM-DD.', 'FISCAL_OBLIGATION_VALIDATION');
    }
    const dueYear = Number(dueAt.slice(0, 4));
    if (dueYear < year || dueYear > year + 3) {
      throw AppError.badRequest('O prazo da obrigação deve cair entre o ano-base e três anos depois dele.', 'FISCAL_OBLIGATION_VALIDATION');
    }
  }
  if (description !== undefined && description !== null && (typeof description !== 'string' || description.trim().length > 200)) {
    throw AppError.badRequest('A descrição da obrigação deve ser um texto de até 200 caracteres.', 'FISCAL_OBLIGATION_VALIDATION');
  }

  // Um cadastro por vez por empresa/tipo/ano: a checagem e a criação ficam sob a mesma trava.
  await FiscalObligation.sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:key))', { replacements: { key: `fiscal-obligation:${companyId}:${obligationType}:${year}` }, transaction });
  const existing = await FiscalObligation.findOne({ where: { groupId, companyId, obligationType, referenceYear: year }, transaction });
  if (existing) return existing;

  const due = dueAt || defaultDimobDueDate(year, (await getFiscalSettings(groupId, companyId, actorUserId, transaction)).dimobDueMonth);
  const obligation = await FiscalObligation.create(
    {
      groupId, companyId, obligationType, referenceYear: year, dueAt: due, status: 'PENDING',
      description: (description && description.trim()) || `${OBLIGATION_TYPES[obligationType]} — ano-base ${year}`,
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

/**
 * listObligations — calendário fiscal: PENDING vencida passa a OVERDUE; devolve dias até o prazo.
 */
async function listObligations(groupId, companyId, transaction) {
  // Leitura pura: o status "vencida" é calculado aqui (PENDING com prazo no passado), sem gravar nada.
  const rows = await FiscalObligation.findAll({ where: { groupId, companyId }, order: [['due_at', 'ASC']], transaction });
  const now = Date.parse(`${today()}T00:00:00Z`);
  return rows.map((row) => {
    const json = row.toJSON();
    if (json.status === 'PENDING' && Date.parse(`${row.dueAt}T00:00:00Z`) < now) json.status = 'OVERDUE';
    json.typeLabel = OBLIGATION_TYPES[row.obligationType] || row.obligationType;
    json.daysUntilDue = Math.round((Date.parse(`${row.dueAt}T00:00:00Z`) - now) / 86400000);
    return json;
  });
}

async function completeObligation(obligationId, note, actorUserId, groupId, companyId, transaction, { dimobBatchId } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(obligationId || ''))) {
    throw AppError.badRequest('Identificador de obrigação inválido.', 'FISCAL_OBLIGATION_VALIDATION');
  }
  const obligation = await FiscalObligation.findOne({ where: { id: obligationId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!obligation) throw AppError.notFound('Obrigação fiscal não encontrada.', 'FISCAL_OBLIGATION_NOT_FOUND');
  if (obligation.status === 'COMPLETED') {
    throw AppError.conflict('Esta obrigação já foi concluída.', 'FISCAL_OBLIGATION_ALREADY_COMPLETED');
  }
  if (!dimobBatchId && (typeof note !== 'string' || note.trim().length < 3 || note.trim().length > 500)) {
    throw AppError.badRequest('Concluir uma obrigação manualmente exige uma observação de 3 a 500 caracteres.', 'FISCAL_OBLIGATION_NOTE_REQUIRED');
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

/**
 * updateObligationDueDate — corrige o prazo de uma obrigação ainda pendente (o prazo calculado não considera
 * feriados). Exige motivo e deixa o antes/depois na auditoria.
 */
async function updateObligationDueDate(obligationId, dueAt, reasonText, actorUserId, groupId, companyId, transaction) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(obligationId || ''))) {
    throw AppError.badRequest('Identificador de obrigação inválido.', 'FISCAL_OBLIGATION_VALIDATION');
  }
  if (typeof dueAt !== 'string' || !isRealDate(dueAt)) {
    throw AppError.badRequest('O campo "dueAt" deve ser uma data real no formato AAAA-MM-DD.', 'FISCAL_OBLIGATION_VALIDATION');
  }
  const reason = typeof reasonText === 'string' ? reasonText.trim() : '';
  if (reason.length < 3 || reason.length > 500) {
    throw AppError.badRequest('Informe o motivo da correção do prazo (de 3 a 500 caracteres).', 'FISCAL_OBLIGATION_NOTE_REQUIRED');
  }
  const obligation = await FiscalObligation.findOne({ where: { id: obligationId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!obligation) throw AppError.notFound('Obrigação fiscal não encontrada.', 'FISCAL_OBLIGATION_NOT_FOUND');
  if (obligation.status === 'COMPLETED') {
    throw AppError.conflict('Esta obrigação já foi concluída: o prazo não pode mais ser alterado.', 'FISCAL_OBLIGATION_ALREADY_COMPLETED');
  }
  const dueYear = Number(dueAt.slice(0, 4));
  if (dueYear < obligation.referenceYear || dueYear > obligation.referenceYear + 3) {
    throw AppError.badRequest('O prazo da obrigação deve cair entre o ano-base e três anos depois dele.', 'FISCAL_OBLIGATION_VALIDATION');
  }
  const before = { dueAt: obligation.dueAt };
  obligation.dueAt = dueAt;
  await obligation.save({ transaction });
  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'correspondent.fiscal.obligation_due_date_changed',
      entityType: 'FiscalObligation',
      entityId: obligation.id,
      beforeJson: before,
      afterJson: { dueAt },
      reason: `Prazo da obrigação ${obligation.description} alterado de ${before.dueAt} para ${dueAt}: ${reason}.`,
    },
    transaction
  );
  return obligation;
}

/** completeByDimobBatch — o fechamento do batch anual conclui a obrigação do ano (cria se faltar). */
async function completeByDimobBatch(batch, actorUserId, groupId, companyId, transaction) {
  const obligation = await ensureObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear: batch.referenceYear }, actorUserId, groupId, companyId, transaction);
  if (obligation.status === 'COMPLETED') {
    // Fechar uma versão mais nova do ano: a obrigação passa a apontar para ela (a anterior fica no histórico).
    if (obligation.dimobBatchId !== batch.id) {
      obligation.dimobBatchId = batch.id;
      await obligation.save({ transaction });
      await registrarAuditoria(
        { groupId, companyId, actorUserId, action: 'correspondent.fiscal.obligation_relinked', entityType: 'FiscalObligation', entityId: obligation.id, reason: `A obrigação DIMOB ${batch.referenceYear} passou a apontar para a versão ${batch.version} do batch.` },
        transaction
      );
    }
    return obligation;
  }
  return completeObligation(obligation.id, null, actorUserId, groupId, companyId, transaction, { dimobBatchId: batch.id });
}

/** createObligation — cadastro pela tela: se já existe a do tipo/ano, recusa em vez de devolver a existente em silêncio. */
async function createObligation(input, actorUserId, groupId, companyId, transaction) {
  const year = Number(input?.referenceYear);
  const existing = Number.isInteger(year) && OBLIGATION_TYPES[input?.obligationType]
    ? await FiscalObligation.findOne({ where: { groupId, companyId, obligationType: input.obligationType, referenceYear: year }, transaction })
    : null;
  if (existing) {
    throw AppError.conflict(
      `Já existe a obrigação ${OBLIGATION_TYPES[existing.obligationType]} do ano-base ${year} (${{ PENDING: 'pendente', COMPLETED: 'concluída', OVERDUE: 'vencida' }[existing.status] || existing.status}). Ela está na lista do calendário.`,
      'FISCAL_OBLIGATION_ALREADY_EXISTS'
    );
  }
  return ensureObligation(input || {}, actorUserId, groupId, companyId, transaction);
}

module.exports = { updateObligationDueDate, createObligation, ensureObligation, listObligations, completeObligation, completeByDimobBatch, defaultDimobDueDate, OBLIGATION_TYPES };
