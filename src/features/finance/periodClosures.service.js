'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  PeriodClosure,
  PeriodClosureSnapshot,
  FinancialEntry,
  BankTransaction,
  OwnerRepass,
  CommissionInstallment,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishPeriodClosed } = require('./financeEvents.service');

// M4-19 — Fechamento mensal com bloqueio de período.
//
// Uma vez que um mês é CLOSED, nenhum lançamento novo pode ser criado nele e nenhum lançamento
// existente daquele mês pode ser editado. Isso é o que dá sentido a "fechamento": o número que
// o contador/o cliente viram no dia do fechamento continua sendo o mesmo amanhã.
//
// Consistente com o ledger imutável (FIN-003/FIN-010): reabrir um período NÃO é uma forma de
// reescrever histórico silenciosamente — exige motivo obrigatório, carimba quem reabriu e
// quando, e registra na trilha de auditoria.

const REFERENCE_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertValidReferenceMonth(referenceMonth) {
  if (!referenceMonth || !REFERENCE_MONTH_REGEX.test(String(referenceMonth))) {
    throw AppError.badRequest(
      'O campo "referenceMonth" deve estar no formato "YYYY-MM" (ex.: "2026-09").',
      'FINANCE_PERIOD_VALIDATION'
    );
  }
  return String(referenceMonth);
}

/**
 * toReferenceMonth — converte uma data em "YYYY-MM" usando UTC, o mesmo fuso em que `due_at`
 * é persistido — evita que um vencimento no dia 1º ou no último dia do mês caia no mês errado
 * por causa do offset local da máquina que rodou o código.
 */
function toReferenceMonth(date) {
  if (!date) return null;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getClosureByMonth(companyId, referenceMonth, transaction) {
  return PeriodClosure.findOne({ where: { companyId, referenceMonth }, transaction });
}

async function isPeriodClosed(companyId, referenceMonth, transaction) {
  if (!referenceMonth) return false;
  const closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  return Boolean(closure && closure.status === 'CLOSED');
}

/**
 * assertPeriodOpenForEntry — guarda usada por financialEntries.service.js. Recebe as datas
 * relevantes do lançamento (vencimento e criação) e recusa a operação se QUALQUER uma delas
 * cair num mês fechado. Um lançamento com vencimento em mês fechado é tão proibido quanto um
 * criado (competência) em mês fechado — ambos alterariam um número já reportado.
 */
async function assertPeriodOpenForEntry(companyId, dates, transaction) {
  const months = new Set(
    (Array.isArray(dates) ? dates : [dates]).map(toReferenceMonth).filter(Boolean)
  );
  for (const month of months) {
    if (await isPeriodClosed(companyId, month, transaction)) {
      throw AppError.conflict(
        `O período ${month} está fechado — nenhum lançamento pode ser criado ou editado nesse mês. Reabra o período (com justificativa) se a correção for mesmo necessária.`,
        'FINANCE_PERIOD_CLOSED',
        { referenceMonth: month }
      );
    }
  }
}

async function listPeriodClosures(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.referenceMonth) where.referenceMonth = filters.referenceMonth;
  return PeriodClosure.findAll({ where, order: [['reference_month', 'DESC']], transaction });
}

// ---------------------------------------------------------------------------------------------
// F02 (conferência Nayara 18/10/2026) — pré-condições do fechamento (Caderno Financeiro §16:
// "Antes de fechar: extratos importados, pendências de conciliação classificadas, caixa de
// terceiros conferido, comissões/repasses revisados"; Guia §12 "assert ... calculate closing
// snapshot").
//
// Critérios objetivos, todos restritos ao mês de referência (competência) da empresa:
//   BANK_STATEMENTS_IMPORTED  toda conta bancária com lançamento liquidado na competência do mês
//                             precisa ter extrato importado (ao menos uma transação bancária
//                             datada no mês). Conta movimentada sem extrato = não conferível.
//   RECONCILIATION_PENDINGS   nenhuma transação de extrato datada no mês sem conciliação.
//   CLASSIFICATION_PENDINGS   nenhum excedente PENDING_CLASSIFICATION da competência sem decisão.
//   THIRD_PARTY_CASH_CHECKED  conferência explícita do caixa de terceiros do mês (quem, quando,
//                             observação), e o movimento de terceiros não mudou desde então.
//   COMMISSIONS_REPASSES_REVIEWED  revisão explícita de comissões/repasses do mês, e nenhuma
//                             comissão/repasse do mês mudou desde a revisão.
// As duas conferências humanas existem porque o sistema não tem como deduzir sozinho que um
// contador "conferiu" algo — e uma regra automática inventada aqui seria frágil. Ambas guardam um
// retrato do que foi conferido: se o dado mudar depois, a conferência fica desatualizada e o
// fechamento volta a ser bloqueado até nova conferência.
// ---------------------------------------------------------------------------------------------

const CHECK_TYPES = ['THIRD_PARTY_CASH', 'COMMISSIONS_REPASSES'];

function monthRange(referenceMonth) {
  const [year, month] = referenceMonth.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

function centsOf(value) {
  return Math.round(Number(value || 0) * 100);
}

function moneyOf(cents) {
  return (cents / 100).toFixed(2);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// JSON canônico (chaves ordenadas) — o mesmo conteúdo sempre gera o mesmo hash.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
}

async function computeThirdPartyMovement(companyId, referenceMonth, transaction) {
  const entries = await FinancialEntry.findAll({
    where: {
      companyId,
      competenceMonth: referenceMonth,
      isThirdPartyFunds: true,
      status: 'SETTLED',
      parentEntryId: null,
    },
    attributes: ['nature', 'amount'],
    transaction,
  });
  let receivedCents = 0;
  let releasedCents = 0;
  for (const entry of entries) {
    if (entry.nature === 'RECEIVABLE') receivedCents += centsOf(entry.amount);
    if (entry.nature === 'PAYABLE') releasedCents += centsOf(entry.amount);
  }
  return {
    received: moneyOf(receivedCents),
    released: moneyOf(releasedCents),
    net: moneyOf(receivedCents - releasedCents),
  };
}

async function computeCommissionsRepassesState(companyId, referenceMonth, transaction) {
  const { start, end } = monthRange(referenceMonth);
  const repasses = await OwnerRepass.findAll({
    where: { companyId, referenceMonth },
    attributes: ['id', 'status', 'netAmount'],
    order: [['id', 'ASC']],
    transaction,
  });
  const installments = await CommissionInstallment.findAll({
    where: { companyId, dueAt: { [Op.gte]: start, [Op.lt]: end } },
    attributes: ['id', 'status', 'amount'],
    order: [['id', 'ASC']],
    transaction,
  });
  const fingerprint = sha256(
    canonicalJson({
      repasses: repasses.map((r) => [r.id, r.status, moneyOf(centsOf(r.netAmount))]),
      installments: installments.map((i) => [i.id, i.status, moneyOf(centsOf(i.amount))]),
    })
  );
  return {
    fingerprint,
    repassesCount: repasses.length,
    repassesPending: repasses.filter((r) => r.status === 'PENDING').length,
    commissionInstallmentsCount: installments.length,
    commissionInstallmentsPending: installments.filter((i) => i.status === 'PENDING').length,
  };
}

async function computeBankStatementsCheck(companyId, referenceMonth, transaction) {
  const { start, end } = monthRange(referenceMonth);
  const movedAccounts = await FinancialEntry.findAll({
    where: {
      companyId,
      competenceMonth: referenceMonth,
      bankAccountId: { [Op.ne]: null },
      status: { [Op.in]: ['SETTLED', 'PARTIALLY_SETTLED'] },
    },
    attributes: [[sequelize.fn('DISTINCT', sequelize.col('bank_account_id')), 'bankAccountId']],
    raw: true,
    transaction,
  });
  const missing = [];
  for (const row of movedAccounts) {
    const count = await BankTransaction.count({
      where: { companyId, bankAccountId: row.bankAccountId, transactionDate: { [Op.gte]: start, [Op.lt]: end } },
      transaction,
    });
    if (count === 0) missing.push(row.bankAccountId);
  }
  return { accountsWithMovement: movedAccounts.length, accountsWithoutStatement: missing };
}

async function computeUnreconciledBankTransactions(companyId, referenceMonth, transaction) {
  const { start, end } = monthRange(referenceMonth);
  return BankTransaction.count({
    where: {
      companyId,
      transactionDate: { [Op.gte]: start, [Op.lt]: end },
      [Op.and]: [
        sequelize.literal(
          'NOT EXISTS (SELECT 1 FROM "finance"."reconciliations" r WHERE r.bank_transaction_id = "BankTransaction"."id")'
        ),
      ],
    },
    transaction,
  });
}

/**
 * computePeriodPreconditions — avaliação das 5 pré-condições do Caderno §16 para o mês. Não muda
 * nada; é usada pelo endpoint de leitura, por closePeriod (→ REVIEW) e por approvePeriodClosure
 * (→ CLOSED), que reavalia tudo no momento de fechar.
 */
async function computePeriodPreconditions(companyId, referenceMonth, closure, transaction) {
  const bank = await computeBankStatementsCheck(companyId, referenceMonth, transaction);
  const unreconciled = await computeUnreconciledBankTransactions(companyId, referenceMonth, transaction);
  const classificationPendings = await FinancialEntry.count({
    where: { companyId, competenceMonth: referenceMonth, nature: 'PENDING_CLASSIFICATION', status: 'PENDING' },
    transaction,
  });
  const thirdParty = await computeThirdPartyMovement(companyId, referenceMonth, transaction);
  const commissions = await computeCommissionsRepassesState(companyId, referenceMonth, transaction);

  const thirdPartyChecked = Boolean(closure && closure.thirdPartyCheckedAt);
  const thirdPartyStale =
    thirdPartyChecked && centsOf(closure.thirdPartyBalanceAtCheck) !== centsOf(thirdParty.net);
  const commissionsReviewed = Boolean(closure && closure.commissionsReviewedAt);
  const commissionsStale = commissionsReviewed && closure.commissionsFingerprintAtReview !== commissions.fingerprint;

  const items = [
    {
      code: 'BANK_STATEMENTS_IMPORTED',
      label: 'Extratos bancários importados',
      ok: bank.accountsWithoutStatement.length === 0,
      count: bank.accountsWithoutStatement.length,
      detail:
        bank.accountsWithoutStatement.length === 0
          ? `${bank.accountsWithMovement} conta(s) movimentada(s) no mês, todas com extrato importado.`
          : `${bank.accountsWithoutStatement.length} conta(s) com lançamento liquidado no mês sem extrato importado.`,
      bankAccountIds: bank.accountsWithoutStatement,
    },
    {
      code: 'RECONCILIATION_PENDINGS',
      label: 'Pendências de conciliação classificadas',
      ok: unreconciled === 0,
      count: unreconciled,
      detail:
        unreconciled === 0
          ? 'Todas as transações de extrato do mês estão conciliadas.'
          : `${unreconciled} transação(ões) de extrato do mês ainda sem conciliação.`,
    },
    {
      code: 'CLASSIFICATION_PENDINGS',
      label: 'Excedentes classificados',
      ok: classificationPendings === 0,
      count: classificationPendings,
      detail:
        classificationPendings === 0
          ? 'Nenhum valor excedente aguardando classificação no mês.'
          : `${classificationPendings} valor(es) excedente(s) do mês aguardando classificação.`,
    },
    {
      code: 'THIRD_PARTY_CASH_CHECKED',
      label: 'Caixa de terceiros conferido',
      ok: thirdPartyChecked && !thirdPartyStale,
      count: thirdPartyChecked && !thirdPartyStale ? 0 : 1,
      detail: !thirdPartyChecked
        ? `Conferência ainda não registrada. Movimento de terceiros do mês: recebido ${thirdParty.received}, devolvido ${thirdParty.released}, líquido ${thirdParty.net}.`
        : thirdPartyStale
          ? `O movimento de terceiros mudou depois da conferência (conferido ${closure.thirdPartyBalanceAtCheck}, atual ${thirdParty.net}). Confira de novo.`
          : `Conferido em ${closure.thirdPartyCheckedAt.toISOString()} (líquido ${thirdParty.net}).`,
      thirdParty,
    },
    {
      code: 'COMMISSIONS_REPASSES_REVIEWED',
      label: 'Comissões e repasses revisados',
      ok: commissionsReviewed && !commissionsStale,
      count: commissionsReviewed && !commissionsStale ? 0 : 1,
      detail: !commissionsReviewed
        ? `Revisão ainda não registrada. Mês com ${commissions.repassesCount} repasse(s) (${commissions.repassesPending} pendente(s)) e ${commissions.commissionInstallmentsCount} parcela(s) de comissão (${commissions.commissionInstallmentsPending} pendente(s)).`
        : commissionsStale
          ? 'Comissões ou repasses do mês mudaram depois da revisão. Revise de novo.'
          : `Revisado em ${closure.commissionsReviewedAt.toISOString()}.`,
      commissions: {
        repassesCount: commissions.repassesCount,
        repassesPending: commissions.repassesPending,
        commissionInstallmentsCount: commissions.commissionInstallmentsCount,
        commissionInstallmentsPending: commissions.commissionInstallmentsPending,
      },
    },
  ];

  return {
    referenceMonth,
    allOk: items.every((item) => item.ok),
    items,
    thirdParty,
    commissionsFingerprint: commissions.fingerprint,
  };
}

function assertPreconditionsMet(preconditions, stageLabel) {
  if (preconditions.allOk) return;
  const missing = preconditions.items.filter((item) => !item.ok);
  throw AppError.conflict(
    `O período ${preconditions.referenceMonth} não pode ${stageLabel}: ${missing.map((item) => `${item.label} — ${item.detail}`).join(' | ')}`,
    'FINANCE_PERIOD_PRECONDITIONS_NOT_MET',
    { referenceMonth: preconditions.referenceMonth, missing: missing.map((item) => ({ code: item.code, label: item.label, count: item.count, detail: item.detail })) }
  );
}

async function getPeriodPreconditions(payload, transaction) {
  const { companyId } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!companyId) {
    throw AppError.badRequest('O campo "companyId" é obrigatório.', 'FINANCE_PERIOD_VALIDATION');
  }
  const closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  const preconditions = await computePeriodPreconditions(companyId, referenceMonth, closure, transaction);
  const snapshot = closure && closure.currentSnapshotId
    ? await PeriodClosureSnapshot.findByPk(closure.currentSnapshotId, { transaction })
    : null;
  return { closure, status: closure ? closure.status : 'OPEN', preconditions, snapshot };
}

/**
 * confirmPeriodCheck — registra uma das duas conferências humanas do Caderno §16 (caixa de
 * terceiros; comissões/repasses), com quem, quando, observação obrigatória e o retrato do dado
 * conferido. Só antes de pedir o fechamento (período OPEN).
 */
async function confirmPeriodCheck(payload, actorUserId, transaction) {
  const { groupId, companyId } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  const checkType = String(payload.checkType || '').toUpperCase();
  const note = payload.note === undefined || payload.note === null ? '' : String(payload.note).trim();
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCE_PERIOD_VALIDATION');
  }
  if (!CHECK_TYPES.includes(checkType)) {
    throw AppError.badRequest(`O campo "checkType" deve ser um de: ${CHECK_TYPES.join(', ')}.`, 'FINANCE_PERIOD_VALIDATION');
  }
  if (!note) {
    throw AppError.badRequest(
      'Informe a observação da conferência (o que foi conferido e como) — ela fica registrada no fechamento.',
      'FINANCE_PERIOD_CHECK_NOTE_REQUIRED'
    );
  }

  let closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  if (closure && closure.status !== 'OPEN') {
    throw AppError.conflict(
      `O período ${referenceMonth} está ${closure.status === 'CLOSED' ? 'fechado' : 'em revisão'} — conferências só podem ser registradas antes de pedir o fechamento.`,
      'FINANCE_PERIOD_CHECK_NOT_ALLOWED'
    );
  }
  if (!closure) {
    closure = await PeriodClosure.create(
      { groupId, companyId, referenceMonth, status: 'OPEN', createdBy: actorUserId || null, updatedBy: actorUserId || null },
      { transaction }
    );
  }
  const beforeJson = closure.toJSON();

  if (checkType === 'THIRD_PARTY_CASH') {
    const thirdParty = await computeThirdPartyMovement(companyId, referenceMonth, transaction);
    closure.thirdPartyCheckedAt = new Date();
    closure.thirdPartyCheckedByUserId = actorUserId || null;
    closure.thirdPartyCheckNote = note;
    closure.thirdPartyBalanceAtCheck = thirdParty.net;
  } else {
    const commissions = await computeCommissionsRepassesState(companyId, referenceMonth, transaction);
    closure.commissionsReviewedAt = new Date();
    closure.commissionsReviewedByUserId = actorUserId || null;
    closure.commissionsReviewNote = note;
    closure.commissionsFingerprintAtReview = commissions.fingerprint;
  }
  await closure.save({ transaction });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: checkType === 'THIRD_PARTY_CASH' ? 'finance.period_closure.third_party_checked' : 'finance.period_closure.commissions_reviewed',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: closure.toJSON(),
      reason: `${checkType === 'THIRD_PARTY_CASH' ? 'Caixa de terceiros conferido' : 'Comissões e repasses revisados'} para ${referenceMonth}: ${note}`,
    },
    transaction
  );

  return closure;
}

async function buildClosingSnapshot(closure, preconditions, actorUserId, transaction) {
  const totals = await FinancialEntry.findAll({
    where: { companyId: closure.companyId, competenceMonth: closure.referenceMonth, parentEntryId: null },
    attributes: [
      'nature',
      'status',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
      [sequelize.fn('SUM', sequelize.col('amount')), 'sum'],
    ],
    group: ['nature', 'status'],
    order: [['nature', 'ASC'], ['status', 'ASC']],
    raw: true,
    transaction,
  });
  const snapshotJson = {
    companyId: closure.companyId,
    referenceMonth: closure.referenceMonth,
    closedAt: new Date().toISOString(),
    requestedByUserId: closure.updatedBy || null,
    approvedByUserId: actorUserId || null,
    totalsByNatureAndStatus: totals.map((row) => ({
      nature: row.nature,
      status: row.status,
      count: Number(row.count),
      sum: moneyOf(centsOf(row.sum)),
    })),
    thirdParty: preconditions.thirdParty,
    preconditions: preconditions.items.map((item) => ({ code: item.code, ok: item.ok, count: item.count, detail: item.detail })),
    checks: {
      thirdPartyCheckedAt: closure.thirdPartyCheckedAt ? closure.thirdPartyCheckedAt.toISOString() : null,
      thirdPartyCheckedByUserId: closure.thirdPartyCheckedByUserId,
      thirdPartyCheckNote: closure.thirdPartyCheckNote,
      commissionsReviewedAt: closure.commissionsReviewedAt ? closure.commissionsReviewedAt.toISOString() : null,
      commissionsReviewedByUserId: closure.commissionsReviewedByUserId,
      commissionsReviewNote: closure.commissionsReviewNote,
      commissionsFingerprint: preconditions.commissionsFingerprint,
    },
  };
  const snapshotHash = sha256(canonicalJson(snapshotJson));
  return PeriodClosureSnapshot.create(
    {
      groupId: closure.groupId,
      companyId: closure.companyId,
      periodClosureId: closure.id,
      referenceMonth: closure.referenceMonth,
      snapshotJson,
      snapshotHash,
      createdBy: actorUserId || null,
    },
    { transaction }
  );
}

function verifySnapshotIntegrity(snapshot) {
  return sha256(canonicalJson(snapshot.snapshotJson)) === snapshot.snapshotHash;
}

/**
 * closePeriod — ACHADO REAL CORRIGIDO (auditoria independente Nayara, 14/10/2026, A06): esta
 * função pulava direto pra CLOSED, sem nenhuma etapa de REVIEW/revisão antes (o Caderno, páginas
 * 121/128, pede OPEN → REVIEW → CLOSED). Agora ela só leva o período pra REVIEW — "fechamento
 * solicitado, pendente de aprovação" — nunca fecha de verdade sozinha. Só `approvePeriodClosure`
 * (ação separada, com permissão + MFA de step-up) move REVIEW → CLOSED.
 */
async function closePeriod(payload, actorUserId, transaction) {
  const { groupId, companyId } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCE_PERIOD_VALIDATION');
  }

  let closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  if (closure && closure.status === 'CLOSED') {
    throw AppError.conflict(`O período ${referenceMonth} já está fechado.`, 'FINANCE_PERIOD_ALREADY_CLOSED');
  }
  if (closure && closure.status === 'REVIEW') {
    throw AppError.conflict(`O período ${referenceMonth} já está em revisão, aguardando aprovação do fechamento.`, 'FINANCE_PERIOD_ALREADY_IN_REVIEW');
  }

  // F02 — Caderno §16: nada vai para revisão de fechamento com pré-condição pendente.
  const preconditions = await computePeriodPreconditions(companyId, referenceMonth, closure, transaction);
  assertPreconditionsMet(preconditions, 'ir para revisão de fechamento');

  const beforeJson = closure ? closure.toJSON() : null;
  if (!closure) {
    closure = await PeriodClosure.create(
      {
        groupId,
        companyId,
        referenceMonth,
        status: 'REVIEW',
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  } else {
    // Reabertura anterior existe: solicitar fechamento de novo limpa os carimbos de reabertura
    // (o motivo da reabertura já está preservado na trilha de auditoria — não se perde informação).
    closure.status = 'REVIEW';
    closure.reopenedAt = null;
    closure.reopenedByUserId = null;
    closure.reopenReason = null;
    closure.updatedBy = actorUserId || null;
    await closure.save({ transaction });
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.period_closure.request_review',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: closure.toJSON(),
      reason: `Fechamento do período ${referenceMonth} solicitado — em revisão, ainda não bloqueado. Aguardando aprovação.`,
    },
    transaction
  );

  return closure;
}

/**
 * approvePeriodClosure — único caminho que move REVIEW → CLOSED de verdade, bloqueando o período.
 * Exige um ator DIFERENTE de quem solicitou o fechamento (mesmo princípio de segregação já usado
 * em outros gates desta sessão — Compras, Ajuste de inventário, Perdas, Requisição de material).
 */
async function approvePeriodClosure(payload, actorUserId, transaction) {
  const { companyId } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!companyId) {
    throw AppError.badRequest('O campo "companyId" é obrigatório.', 'FINANCE_PERIOD_VALIDATION');
  }

  const closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  if (!closure) {
    throw AppError.notFound(`Não há solicitação de fechamento para o período ${referenceMonth}.`, 'FINANCE_PERIOD_NOT_FOUND');
  }
  if (closure.status !== 'REVIEW') {
    throw AppError.conflict(`O período ${referenceMonth} não está aguardando aprovação de fechamento.`, 'FINANCE_PERIOD_NOT_IN_REVIEW');
  }
  if (actorUserId && closure.updatedBy && String(actorUserId) === String(closure.updatedBy)) {
    throw AppError.forbidden(
      'Quem solicitou o fechamento deste período não pode ser quem aprova — peça para outra pessoa confirmar.',
      'FINANCE_PERIOD_SELF_APPROVAL_BLOCKED'
    );
  }

  // F02 — reavalia TODAS as pré-condições no momento de fechar (algo pode ter mudado desde o
  // pedido de revisão: transação de extrato nova, comissão alterada, movimento de terceiros).
  const preconditions = await computePeriodPreconditions(companyId, referenceMonth, closure, transaction);
  assertPreconditionsMet(preconditions, 'ser fechado');

  const beforeJson = closure.toJSON();
  const snapshot = await buildClosingSnapshot(closure, preconditions, actorUserId, transaction);
  closure.status = 'CLOSED';
  closure.closedAt = new Date();
  closure.closedByUserId = actorUserId || null;
  closure.currentSnapshotId = snapshot.id;
  closure.updatedBy = actorUserId || null;
  await closure.save({ transaction });

  await publishPeriodClosed(closure, snapshot, transaction);

  await registrarAuditoria(
    {
      groupId: closure.groupId,
      companyId: closure.companyId,
      actorUserId,
      action: 'finance.period_closure.close',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: { closure: closure.toJSON(), snapshotId: snapshot.id, snapshotHash: snapshot.snapshotHash },
      reason: `Período ${referenceMonth} fechado com as 5 pré-condições do Caderno §16 atendidas — snapshot ${snapshot.snapshotHash.slice(0, 12)} gravado; lançamentos desse mês ficam bloqueados para criação/edição.`,
    },
    transaction
  );

  return closure;
}

/**
 * reopenPeriod — motivo é OBRIGATÓRIO. Reabrir um mês fechado é exatamente o tipo de ação que
 * precisa deixar rastro do "por quê", não só do "quem".
 */
async function reopenPeriod(payload, actorUserId, transaction) {
  const { companyId, reason } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!companyId) {
    throw AppError.badRequest('O campo "companyId" é obrigatório.', 'FINANCE_PERIOD_VALIDATION');
  }
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest(
      'O campo "reason" é obrigatório para reabrir um período fechado (justificativa auditável).',
      'FINANCE_PERIOD_REOPEN_REASON_REQUIRED'
    );
  }

  const closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  if (!closure) {
    throw AppError.notFound(`Não há fechamento registrado para o período ${referenceMonth}.`, 'FINANCE_PERIOD_NOT_FOUND');
  }
  if (closure.status !== 'CLOSED') {
    throw AppError.conflict(`O período ${referenceMonth} não está fechado.`, 'FINANCE_PERIOD_NOT_CLOSED');
  }

  const beforeJson = closure.toJSON();
  closure.status = 'OPEN';
  closure.reopenedAt = new Date();
  closure.reopenedByUserId = actorUserId || null;
  closure.reopenReason = String(reason).trim();
  // F02 — reabrir invalida as conferências (o mês vai mudar); fechar de novo exige conferir de
  // novo e gera um snapshot NOVO. O snapshot anterior fica preservado em
  // period_closure_snapshots (imutável) como histórico.
  closure.thirdPartyCheckedAt = null;
  closure.thirdPartyCheckedByUserId = null;
  closure.thirdPartyCheckNote = null;
  closure.thirdPartyBalanceAtCheck = null;
  closure.commissionsReviewedAt = null;
  closure.commissionsReviewedByUserId = null;
  closure.commissionsReviewNote = null;
  closure.commissionsFingerprintAtReview = null;
  closure.currentSnapshotId = null;
  closure.updatedBy = actorUserId || null;
  await closure.save({ transaction });

  await registrarAuditoria(
    {
      groupId: closure.groupId,
      companyId: closure.companyId,
      actorUserId,
      action: 'finance.period_closure.reopen',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: closure.toJSON(),
      reason: `Período ${referenceMonth} REABERTO. Justificativa: ${closure.reopenReason}`,
    },
    transaction
  );

  return closure;
}

module.exports = {
  closePeriod,
  approvePeriodClosure,
  reopenPeriod,
  listPeriodClosures,
  getPeriodPreconditions,
  computePeriodPreconditions,
  confirmPeriodCheck,
  verifySnapshotIntegrity,
  CHECK_TYPES,
  getClosureByMonth,
  isPeriodClosed,
  assertPeriodOpenForEntry,
  toReferenceMonth,
};
