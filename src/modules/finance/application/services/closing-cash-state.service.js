'use strict';

// Leituras do mês que alimentam as pré-condições do fechamento (Caderno §16): caixa de
// terceiros, comissões/repasses, extratos importados, conciliação e pagamentos em trânsito.

const { Op } = require('sequelize');
const {
  sequelize,
  BankTransaction,
  BankStatementImport,
  OwnerRepass,
  CommissionInstallment,
} = require('../../../../models');
const { centsOf, moneyOf, sha256, canonicalJson } = require('./closing-hash');

// Fuso de negócio: America/Sao_Paulo (UTC-3 fixo desde 2019). Os limites de mês do fechamento
// são meia-noite em São Paulo, nunca meia-noite UTC — um lançamento às 22h do dia 31 em
// Brasília pertence ao dia 31, não ao dia 1º do mês seguinte.
const SAO_PAULO_UTC_OFFSET_HOURS = 3;

// Guia M4 §3 (DEC-056): enviando/enviado ao banco e sem resposta final = EXECUTING (a fase fica em submission_phase).
const IN_TRANSIT_INTENT_STATUSES = ['EXECUTING'];

// Início (inclusive) e fim (exclusivo) do mês em São Paulo, mais o primeiro e o último dia de
// calendário ("YYYY-MM-DD") — usados para cobertura de extrato.
function monthRange(referenceMonth) {
  const [year, month] = referenceMonth.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1, SAO_PAULO_UTC_OFFSET_HOURS));
  const end = new Date(Date.UTC(year, month, 1, SAO_PAULO_UTC_OFFSET_HOURS));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start, end, firstDayKey: `${referenceMonth}-01`, lastDayKey: `${referenceMonth}-${String(lastDay).padStart(2, '0')}` };
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

module.exports = {
  computeThirdPartyState,
  computeCommissionsRepassesState,
  listBankCashEvents,
  computeBankStatementsCheck,
  computeReconciliationPendings,
  computePaymentsInTransit,
};
