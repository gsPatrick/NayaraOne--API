'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  PeriodClosure,
  PeriodClosureSnapshot,
  FinancialEntry,
  BankTransaction,
  BankStatementImport,
  OwnerRepass,
  CommissionInstallment,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishPeriodClosed } = require('./financeEvents.service');
const { businessDateKey } = require('../../utils/businessDate');

// Fuso de negócio: America/Sao_Paulo (UTC-3 fixo desde 2019). Os limites de mês do fechamento
// são meia-noite em São Paulo, nunca meia-noite UTC — um lançamento às 22h do dia 31 em
// Brasília pertence ao dia 31, não ao dia 1º do mês seguinte.
const SAO_PAULO_UTC_OFFSET_HOURS = 3;

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
 * toReferenceMonth — "YYYY-MM" de um valor:
 *   - "YYYY-MM" (competência) volta como está;
 *   - "YYYY-MM-DD" (data de calendário) usa o próprio mês, sem conversão de fuso;
 *   - instante (Date/ISO) é convertido para o dia em São Paulo antes de tirar o mês.
 * F02 (2ª rodada): antes usava UTC, e um instante às 22h do dia 31 em Brasília (01h UTC do dia
 * 1º) caía no mês seguinte.
 */
function toReferenceMonth(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (REFERENCE_MONTH_REGEX.test(trimmed)) return trimmed;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed.slice(0, 7);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return businessDateKey(parsed).slice(0, 7);
}

async function getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate = false } = {}) {
  return PeriodClosure.findOne({
    where: { companyId, referenceMonth },
    transaction,
    ...(forUpdate && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
}

async function isPeriodClosed(companyId, referenceMonth, transaction) {
  if (!referenceMonth) return false;
  const closure = await getClosureByMonth(companyId, referenceMonth, transaction);
  return Boolean(closure && closure.status === 'CLOSED');
}

/**
 * assertPeriodOpenForEntry — guarda usada por financialEntries.service.js. Recebe as datas
 * relevantes do lançamento (vencimento, criação e/ou a própria competência "YYYY-MM") e recusa a
 * operação se QUALQUER uma delas cair num mês CLOSED. Só CLOSED bloqueia aqui: durante REVIEW o
 * caixa continua andando (baixa, confirmação do banco); o que muda o número em revisão vira
 * conferência desatualizada e o aprovador devolve o período para OPEN (returnPeriodToOpen).
 * Para mudança de COMPETÊNCIA use assertCompetenceOpen, que bloqueia CLOSED e REVIEW.
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

/**
 * assertCompetenceOpen — F02 (2ª rodada; Caderno §16: "CLOSED bloqueia alteração comum de
 * competência"). Guarda de COMPETÊNCIA: recusa criar um lançamento com competência num mês
 * fechado, mover um lançamento PARA um mês fechado e TIRAR um lançamento de um mês fechado
 * (quem chama passa a competência atual e a nova). Também bloqueia mês em REVIEW: o que está
 * em revisão é o retrato que vai ser aprovado — se algo precisa entrar ou sair da competência,
 * o aprovador devolve o período para OPEN (returnPeriodToOpen) com motivo.
 *
 * Assinatura: assertCompetenceOpen(companyId, competenceMonths, transaction)
 *   competenceMonths: string "YYYY-MM" ou array delas (null/undefined/'' são ignorados; valores
 *   repetidos são conferidos uma vez). Lança AppError 409 FINANCE_PERIOD_CLOSED (CLOSED) ou
 *   FINANCE_PERIOD_IN_REVIEW (REVIEW), com details { referenceMonth }; 400
 *   FINANCE_PERIOD_VALIDATION se algum valor não for "YYYY-MM".
 */
async function assertCompetenceOpen(companyId, competenceMonths, transaction) {
  const values = (Array.isArray(competenceMonths) ? competenceMonths : [competenceMonths])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .map((value) => assertValidReferenceMonth(String(value).trim()));
  for (const month of new Set(values)) {
    const closure = await getClosureByMonth(companyId, month, transaction);
    if (closure && closure.status === 'CLOSED') {
      throw AppError.conflict(
        `A competência ${month} está fechada — nenhum lançamento pode entrar nela ou sair dela. Reabra o período (com justificativa) se a correção for mesmo necessária, ou lance o ajuste no período corrente com referência a ${month}.`,
        'FINANCE_PERIOD_CLOSED',
        { referenceMonth: month }
      );
    }
    if (closure && closure.status === 'REVIEW') {
      throw AppError.conflict(
        `A competência ${month} está em revisão de fechamento — nada pode entrar nela ou sair dela enquanto o retrato do mês é aprovado. Peça ao aprovador para devolver o período para aberto.`,
        'FINANCE_PERIOD_IN_REVIEW',
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
// Critérios objetivos (2ª rodada, revisor independente 18/10). "Caixa" é contado pela DATA DE
// LIQUIDAÇÃO (settled_at) no fuso de São Paulo, não pela competência: é o dinheiro que passou
// pela conta no mês que tem de estar no extrato e conciliado.
//   BANK_STATEMENTS_IMPORTED  toda conta bancária com movimento de caixa no mês precisa ter uma
//                             importação de extrato cujo período cubra o mês INTEIRO (do dia 1º
//                             ao último dia). Uma transação solta no mês não basta.
//   RECONCILIATION_PENDINGS   nenhuma transação de extrato do mês sem conciliação E nenhum
//                             movimento de caixa bancário do mês (inclusive baixa manual com
//                             comprovante) sem conciliação — os dois lados.
//   CLASSIFICATION_PENDINGS   nenhum excedente PENDING_CLASSIFICATION da competência sem decisão.
//   PAYMENTS_IN_TRANSIT       nenhuma intenção de pagamento enviada ao banco (SUBMITTED/
//                             SUBMITTING) ainda sem resposta para lançamento da competência.
//   THIRD_PARTY_CASH_CHECKED  conferência explícita do caixa de terceiros (quem, quando,
//                             observação) e nada de terceiros mudou desde então — retrato item a
//                             item (id/status/valor), não só o líquido.
//   COMMISSIONS_REPASSES_REVIEWED  revisão explícita de comissões/repasses do mês, e nenhuma
//                             comissão/repasse do mês mudou desde a revisão.
// As duas conferências humanas existem porque o sistema não tem como deduzir sozinho que um
// contador "conferiu" algo — e uma regra automática inventada aqui seria frágil. Ambas guardam um
// retrato do que foi conferido: se o dado mudar depois, a conferência fica desatualizada e o
// fechamento volta a ser bloqueado até nova conferência.
// ---------------------------------------------------------------------------------------------

const CHECK_TYPES = ['THIRD_PARTY_CASH', 'COMMISSIONS_REPASSES'];
const IN_TRANSIT_INTENT_STATUSES = ['SUBMITTED', 'SUBMITTING'];

// Início (inclusive) e fim (exclusivo) do mês em São Paulo, mais o primeiro e o último dia de
// calendário ("YYYY-MM-DD") — usados para cobertura de extrato.
function monthRange(referenceMonth) {
  const [year, month] = referenceMonth.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1, SAO_PAULO_UTC_OFFSET_HOURS));
  const end = new Date(Date.UTC(year, month, 1, SAO_PAULO_UTC_OFFSET_HOURS));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start, end, firstDayKey: `${referenceMonth}-01`, lastDayKey: `${referenceMonth}-${String(lastDay).padStart(2, '0')}` };
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

// "Movimento de caixa" = lançamento liquidado que é o fato de caixa em si: a própria baixa
// integral, ou cada baixa parcial (filha). Uma raiz que tem filhas da mesma natureza não conta
// de novo (o dinheiro está nas filhas). Excedente PENDING_CLASSIFICATION não é caixa conferível.
const CASH_EVENT_SQL = `
  e.status = 'SETTLED'
  AND e.settled_at IS NOT NULL
  AND e.nature IN ('RECEIVABLE', 'PAYABLE')
  AND NOT EXISTS (
    SELECT 1 FROM "finance"."financial_entries" c
    WHERE c.parent_entry_id = e.id AND c.nature = e.nature
  )`;

/**
 * computeThirdPartyState — caixa de terceiros (Caderno §13/§16). F02 (2ª rodada):
 *   - inclui baixas parciais de caução: a filha da baixa parcial nasce com is_third_party_funds
 *     false, então "é de terceiro" vale pelo próprio lançamento OU pela raiz;
 *   - apresenta o SALDO de terceiros no fim do mês (tudo liquidado até lá), além do movimento
 *     do mês;
 *   - fingerprint item a item (movimentos de caixa do mês + lançamentos de terceiros da
 *     competência, com id/status/valor): +500/−500 depois da conferência muda o fingerprint
 *     mesmo com líquido igual.
 */
async function computeThirdPartyState(companyId, referenceMonth, transaction) {
  const { start, end } = monthRange(referenceMonth);
  const [cashRows] = await sequelize.query(
    `SELECT e.id, e.nature, e.status, e.amount, e.settled_at AS "settledAt"
       FROM "finance"."financial_entries" e
       LEFT JOIN "finance"."financial_entries" p ON p.id = e.parent_entry_id
      WHERE e.company_id = :companyId
        AND (e.is_third_party_funds = true OR p.is_third_party_funds = true)
        AND e.settled_at < :end
        AND ${CASH_EVENT_SQL}
      ORDER BY e.id`,
    { replacements: { companyId, end }, transaction }
  );
  const [competenceRows] = await sequelize.query(
    `SELECT e.id, e.nature, e.status, e.amount
       FROM "finance"."financial_entries" e
       LEFT JOIN "finance"."financial_entries" p ON p.id = e.parent_entry_id
      WHERE e.company_id = :companyId
        AND e.competence_month = :referenceMonth
        AND (e.is_third_party_funds = true OR p.is_third_party_funds = true)
      ORDER BY e.id`,
    { replacements: { companyId, referenceMonth }, transaction }
  );

  let receivedCents = 0;
  let releasedCents = 0;
  let balanceCents = 0;
  const monthCash = [];
  for (const row of cashRows) {
    const cents = centsOf(row.amount);
    const signed = row.nature === 'RECEIVABLE' ? cents : -cents;
    balanceCents += signed;
    if (new Date(row.settledAt) >= start) {
      if (row.nature === 'RECEIVABLE') receivedCents += cents;
      else releasedCents += cents;
      monthCash.push([row.id, row.nature, row.status, moneyOf(cents)]);
    }
  }
  const fingerprint = sha256(
    canonicalJson({
      monthCash,
      competence: competenceRows.map((row) => [row.id, row.nature, row.status, moneyOf(centsOf(row.amount))]),
    })
  );
  return {
    received: moneyOf(receivedCents),
    released: moneyOf(releasedCents),
    net: moneyOf(receivedCents - releasedCents),
    balanceAtMonthEnd: moneyOf(balanceCents),
    monthCashCount: monthCash.length,
    competenceEntriesCount: competenceRows.length,
    fingerprint,
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

// Movimentos de caixa BANCÁRIOS do mês (pela data de liquidação em São Paulo).
async function listBankCashEvents(companyId, referenceMonth, transaction) {
  const { start, end } = monthRange(referenceMonth);
  const [rows] = await sequelize.query(
    `SELECT e.id, e.bank_account_id AS "bankAccountId", e.parent_entry_id AS "parentEntryId",
            e.settlement_method AS "settlementMethod"
       FROM "finance"."financial_entries" e
      WHERE e.company_id = :companyId
        AND e.bank_account_id IS NOT NULL
        AND e.settled_at >= :start AND e.settled_at < :end
        AND ${CASH_EVENT_SQL}
      ORDER BY e.id`,
    { replacements: { companyId, start, end }, transaction }
  );
  return rows;
}

/**
 * computeBankStatementsCheck — F02 (2ª rodada): conta com movimento de caixa no mês só passa se
 * houver importação de extrato (finance.bank_statement_imports) cujo período cubra o mês
 * inteiro. Antes bastava UMA transação qualquer no mês, e o mês era o da competência.
 */
async function computeBankStatementsCheck(companyId, referenceMonth, transaction, cashEvents) {
  const { firstDayKey, lastDayKey } = monthRange(referenceMonth);
  const accounts = [...new Set(cashEvents.map((row) => row.bankAccountId))].sort();
  const missing = [];
  for (const bankAccountId of accounts) {
    const covering = await BankStatementImport.count({
      where: {
        companyId,
        bankAccountId,
        periodStart: { [Op.lte]: firstDayKey },
        periodEnd: { [Op.gte]: lastDayKey },
      },
      transaction,
    });
    if (covering === 0) missing.push(bankAccountId);
  }
  return { accountsWithMovement: accounts.length, accountsWithoutStatement: missing };
}

/**
 * computeReconciliationPendings — os DOIS lados da conciliação (F02, 2ª rodada):
 *   - transações de extrato datadas no mês sem conciliação;
 *   - movimentos de caixa bancários liquidados no mês sem conciliação — inclusive a baixa manual
 *     com comprovante (MANUAL_WITH_EVIDENCE), que só fica confirmada quando aparece no extrato.
 *     Uma baixa parcial conta como conciliada se ela própria ou a raiz foi conciliada.
 */
async function computeReconciliationPendings(companyId, referenceMonth, transaction, cashEvents) {
  const { start, end } = monthRange(referenceMonth);
  const unreconciledStatementLines = await BankTransaction.count({
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

  let unreconciledEntries = [];
  if (cashEvents.length > 0) {
    const [reconciled] = await sequelize.query(
      `SELECT DISTINCT r.financial_entry_id AS id FROM "finance"."reconciliations" r
        WHERE r.financial_entry_id IN (:ids)`,
      { replacements: { ids: [...new Set(cashEvents.flatMap((row) => [row.id, row.parentEntryId].filter(Boolean)))] }, transaction }
    );
    const reconciledIds = new Set(reconciled.map((row) => String(row.id)));
    unreconciledEntries = cashEvents.filter(
      (row) => !reconciledIds.has(String(row.id)) && !(row.parentEntryId && reconciledIds.has(String(row.parentEntryId)))
    );
  }
  return {
    unreconciledStatementLines,
    unreconciledEntryIds: unreconciledEntries.map((row) => row.id),
    unreconciledManualSettlements: unreconciledEntries.filter((row) => row.settlementMethod === 'MANUAL_WITH_EVIDENCE').length,
  };
}

async function computePaymentsInTransit(companyId, referenceMonth, transaction) {
  const [rows] = await sequelize.query(
    `SELECT pi.id FROM "finance"."payment_intents" pi
       JOIN "finance"."financial_entries" e ON e.id = pi.financial_entry_id
      WHERE pi.company_id = :companyId
        AND pi.status IN (:statuses)
        AND e.competence_month = :referenceMonth
      ORDER BY pi.id`,
    { replacements: { companyId, referenceMonth, statuses: IN_TRANSIT_INTENT_STATUSES }, transaction }
  );
  return rows.map((row) => row.id);
}

/**
 * computePeriodPreconditions — avaliação das 5 pré-condições do Caderno §16 para o mês. Não muda
 * nada; é usada pelo endpoint de leitura, por closePeriod (→ REVIEW) e por approvePeriodClosure
 * (→ CLOSED), que reavalia tudo no momento de fechar.
 */
async function computePeriodPreconditions(companyId, referenceMonth, closure, transaction) {
  const cashEvents = await listBankCashEvents(companyId, referenceMonth, transaction);
  const bank = await computeBankStatementsCheck(companyId, referenceMonth, transaction, cashEvents);
  const reconciliation = await computeReconciliationPendings(companyId, referenceMonth, transaction, cashEvents);
  const unreconciled = reconciliation.unreconciledStatementLines + reconciliation.unreconciledEntryIds.length;
  const classificationPendings = await FinancialEntry.count({
    where: { companyId, competenceMonth: referenceMonth, nature: 'PENDING_CLASSIFICATION', status: 'PENDING' },
    transaction,
  });
  const paymentsInTransit = await computePaymentsInTransit(companyId, referenceMonth, transaction);
  const thirdParty = await computeThirdPartyState(companyId, referenceMonth, transaction);
  const commissions = await computeCommissionsRepassesState(companyId, referenceMonth, transaction);

  const thirdPartyChecked = Boolean(closure && closure.thirdPartyCheckedAt);
  // Conferência registrada antes da migration 387 não tem fingerprint: cai na comparação antiga
  // (líquido), que é a única informação gravada naquela época.
  const thirdPartyStale =
    thirdPartyChecked &&
    (closure.thirdPartyFingerprintAtCheck
      ? closure.thirdPartyFingerprintAtCheck !== thirdParty.fingerprint
      : centsOf(closure.thirdPartyBalanceAtCheck) !== centsOf(thirdParty.net));
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
          ? 'Todas as transações de extrato do mês e todos os movimentos de caixa bancários do mês estão conciliados.'
          : [
            reconciliation.unreconciledStatementLines > 0
              ? `${reconciliation.unreconciledStatementLines} transação(ões) de extrato do mês sem conciliação`
              : null,
            reconciliation.unreconciledEntryIds.length > 0
              ? `${reconciliation.unreconciledEntryIds.length} lançamento(s) liquidado(s) em conta bancária no mês sem conciliação com o extrato${reconciliation.unreconciledManualSettlements > 0 ? ` (${reconciliation.unreconciledManualSettlements} baixa(s) manual(is) com comprovante)` : ''}`
              : null,
          ].filter(Boolean).join('; ') + '.',
      unreconciledStatementLines: reconciliation.unreconciledStatementLines,
      unreconciledEntryIds: reconciliation.unreconciledEntryIds,
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
      code: 'PAYMENTS_IN_TRANSIT',
      label: 'Nenhum pagamento em trânsito no banco',
      ok: paymentsInTransit.length === 0,
      count: paymentsInTransit.length,
      detail:
        paymentsInTransit.length === 0
          ? 'Nenhuma intenção de pagamento do mês aguardando resposta do banco.'
          : `${paymentsInTransit.length} pagamento(s) do mês enviado(s) ao banco ainda sem resposta — aguarde a confirmação ou a falha antes de fechar.`,
      paymentIntentIds: paymentsInTransit,
    },
    {
      code: 'THIRD_PARTY_CASH_CHECKED',
      label: 'Caixa de terceiros conferido',
      ok: thirdPartyChecked && !thirdPartyStale,
      count: thirdPartyChecked && !thirdPartyStale ? 0 : 1,
      detail: !thirdPartyChecked
        ? `Conferência ainda não registrada. Saldo de terceiros no fim do mês: ${thirdParty.balanceAtMonthEnd} (no mês: recebido ${thirdParty.received}, devolvido ${thirdParty.released}).`
        : thirdPartyStale
          ? `Lançamentos de terceiros mudaram depois da conferência (saldo conferido ${closure.thirdPartyBalanceAtCheck}, saldo atual ${thirdParty.balanceAtMonthEnd}). Confira de novo.`
          : `Conferido em ${closure.thirdPartyCheckedAt.toISOString()} (saldo de terceiros no fim do mês ${thirdParty.balanceAtMonthEnd}).`,
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

  let closure = await getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
  if (closure && closure.status !== 'OPEN') {
    throw AppError.conflict(
      `O período ${referenceMonth} está ${closure.status === 'CLOSED' ? 'fechado' : 'em revisão'} — conferências só podem ser registradas com o período aberto${closure.status === 'REVIEW' ? ' (o aprovador pode devolver o período para aberto)' : ''}.`,
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
    const thirdParty = await computeThirdPartyState(companyId, referenceMonth, transaction);
    closure.thirdPartyCheckedAt = new Date();
    closure.thirdPartyCheckedByUserId = actorUserId || null;
    closure.thirdPartyCheckNote = note;
    closure.thirdPartyBalanceAtCheck = thirdParty.balanceAtMonthEnd;
    closure.thirdPartyFingerprintAtCheck = thirdParty.fingerprint;
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
    requestedByUserId: closure.reviewRequestedByUserId || closure.updatedBy || null,
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
      thirdPartyFingerprint: preconditions.thirdParty.fingerprint,
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

  let closure = await getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
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
        reviewRequestedByUserId: actorUserId || null,
        reviewRequestedAt: new Date(),
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
    closure.reviewRequestedByUserId = actorUserId || null;
    closure.reviewRequestedAt = new Date();
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

  // FOR UPDATE: duas aprovações simultâneas do mesmo mês são serializadas — a segunda espera a
  // primeira e reavalia o status (já CLOSED), em vez de gravar um segundo snapshot.
  const closure = await getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
  if (!closure) {
    throw AppError.notFound(`Não há solicitação de fechamento para o período ${referenceMonth}.`, 'FINANCE_PERIOD_NOT_FOUND');
  }
  if (closure.status !== 'REVIEW') {
    throw AppError.conflict(`O período ${referenceMonth} não está aguardando aprovação de fechamento.`, 'FINANCE_PERIOD_NOT_IN_REVIEW');
  }
  const requesterId = closure.reviewRequestedByUserId || closure.updatedBy;
  if (actorUserId && requesterId && String(actorUserId) === String(requesterId)) {
    throw AppError.forbidden(
      'Quem solicitou o fechamento deste período não pode ser quem aprova — peça para outra pessoa confirmar.',
      'FINANCE_PERIOD_SELF_APPROVAL_BLOCKED'
    );
  }
  // Segregação nas conferências (decisão documentada): o Caderno §16 exige as conferências e a
  // aprovação, sem dizer quem confere. Exigir que quem PEDE o fechamento não confira travaria a
  // operação de equipes pequenas sem ganho de controle; o controle efetivo é que quem APROVA não
  // tenha conferido nada — assim o mês nunca fecha só com a palavra de quem certificou o caixa.
  const checkers = [closure.thirdPartyCheckedByUserId, closure.commissionsReviewedByUserId].filter(Boolean).map(String);
  if (actorUserId && checkers.includes(String(actorUserId))) {
    throw AppError.forbidden(
      'Quem registrou uma das conferências do mês (caixa de terceiros ou comissões/repasses) não pode ser quem aprova o fechamento — a aprovação tem de vir de outra pessoa.',
      'FINANCE_PERIOD_CHECKER_APPROVAL_BLOCKED'
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

  const closure = await getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
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
  closure.thirdPartyFingerprintAtCheck = null;
  closure.reviewRequestedByUserId = null;
  closure.reviewRequestedAt = null;
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

/**
 * returnPeriodToOpen — F02 (2ª rodada): saída controlada de REVIEW para OPEN. Antes não existia:
 * se algo mudava no mês depois do pedido (conferência desatualizada), a aprovação falhava, a
 * conferência não podia ser refeita (só em OPEN), o pedido não podia ser refeito (já em REVIEW) e
 * a reabertura só vale para CLOSED — o período ficava preso. Exige motivo; fica na auditoria.
 * As conferências são mantidas: se o dado mudou, elas aparecem desatualizadas e precisam ser
 * refeitas antes de pedir o fechamento de novo (o pedido novo reinicia a segregação).
 */
async function returnPeriodToOpen(payload, actorUserId, transaction) {
  const { companyId, reason } = payload;
  const referenceMonth = assertValidReferenceMonth(payload.referenceMonth);
  if (!companyId) {
    throw AppError.badRequest('O campo "companyId" é obrigatório.', 'FINANCE_PERIOD_VALIDATION');
  }
  if (!reason || !String(reason).trim()) {
    throw AppError.badRequest(
      'O campo "reason" é obrigatório para devolver o período para aberto (o que precisa ser corrigido).',
      'FINANCE_PERIOD_RETURN_REASON_REQUIRED'
    );
  }
  const closure = await getClosureByMonth(companyId, referenceMonth, transaction, { forUpdate: true });
  if (!closure) {
    throw AppError.notFound(`Não há solicitação de fechamento para o período ${referenceMonth}.`, 'FINANCE_PERIOD_NOT_FOUND');
  }
  if (closure.status !== 'REVIEW') {
    throw AppError.conflict(
      `O período ${referenceMonth} não está em revisão — só um pedido de fechamento em revisão pode voltar para aberto.`,
      'FINANCE_PERIOD_NOT_IN_REVIEW'
    );
  }

  const beforeJson = closure.toJSON();
  closure.status = 'OPEN';
  closure.returnedToOpenAt = new Date();
  closure.returnedToOpenByUserId = actorUserId || null;
  closure.returnToOpenReason = String(reason).trim();
  closure.reviewRequestedByUserId = null;
  closure.reviewRequestedAt = null;
  closure.updatedBy = actorUserId || null;
  await closure.save({ transaction });

  await registrarAuditoria(
    {
      groupId: closure.groupId,
      companyId: closure.companyId,
      actorUserId,
      action: 'finance.period_closure.return_to_open',
      entityType: 'PeriodClosure',
      entityId: closure.id,
      beforeJson,
      afterJson: closure.toJSON(),
      reason: `Pedido de fechamento de ${referenceMonth} devolvido para aberto. Motivo: ${closure.returnToOpenReason}`,
    },
    transaction
  );

  return closure;
}

module.exports = {
  closePeriod,
  returnPeriodToOpen,
  assertCompetenceOpen,
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
