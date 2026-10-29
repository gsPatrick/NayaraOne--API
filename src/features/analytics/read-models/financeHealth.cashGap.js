'use strict';

/**
 * M9-D620 (regra de qualidade do caixa livre) — duas conferências guardadas no read model, só como números:
 *  1. lançamentos em revisão manual ainda não liberados (requires_manual_review sem manual_review_cleared_at, fora de REVERSED e CANCELLED);
 *  2. divergência entre o caixa do ledger e o saldo da última conciliação bancária conciliada de cada conta. "Última conciliação conciliada" =
 *     o extrato importado mais recente da conta, com saldo final informado, que terminou até a data-base e em cujo período toda transação
 *     bancária tem conciliação. O caixa do ledger da conta no fim do período do extrato = saldo de abertura da conta (se o parâmetro estiver
 *     ligado) + lançamentos liquidados da conta até o fim do dia do extrato (receber menos pagar, próprios e de terceiros, mais as pernas de
 *     transferência). A divergência guardada é a MAIOR, em valor absoluto, entre as contas conferidas (nula quando nenhuma conta tem extrato conciliado).
 */
const { sequelize } = require('../../../models');
const money = require('../metrics/formulas/money');

const SP = "AT TIME ZONE 'America/Sao_Paulo'";
const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

async function readManualReviewPending(companyId, transaction) {
  const [{ n }] = await rows(
    `SELECT count(*)::int AS n FROM finance.financial_entries
      WHERE company_id = :companyId AND requires_manual_review AND manual_review_cleared_at IS NULL AND status NOT IN ('REVERSED', 'CANCELLED')`, { companyId }, transaction);
  return n;
}

const LEDGER_AT_END = `
  COALESCE((SELECT SUM(CASE WHEN e.nature = 'PAYABLE' THEN -e.amount WHEN e.nature = 'RECEIVABLE' THEN e.amount
                            WHEN e.nature = 'ADJUSTMENT' AND e.idempotency_key LIKE 'intercompany-transfer:%' THEN (CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE -e.amount END)
                            ELSE 0 END)
              FROM finance.financial_entries e
             WHERE e.company_id = :companyId AND e.bank_account_id = i.bank_account_id AND e.status IN (:realized) AND e.reversal_of_entry_id IS NULL
               AND e.settled_at < ((i.period_end + 1)::timestamp ${SP})), 0)`;

/** { gap: texto decimal | null, accounts: n } com a maior divergência entre as contas conferidas. */
async function readReconciliationGap(companyId, dayEnd, { includeOpening, realizedStatuses }, transaction) {
  const found = await rows(
    `SELECT i.bank_account_id::text AS account, i.closing_balance::text AS closing,
            (${LEDGER_AT_END} + CASE WHEN :includeOpening THEN COALESCE((SELECT a.opening_balance FROM finance.bank_accounts a WHERE a.id = i.bank_account_id), 0) ELSE 0 END)::text AS ledger
       FROM (SELECT DISTINCT ON (s.bank_account_id) s.* FROM finance.bank_statement_imports s
              WHERE s.company_id = :companyId AND s.closing_balance IS NOT NULL AND ((s.period_end + 1)::timestamp ${SP}) <= :dayEnd
                AND NOT EXISTS (SELECT 1 FROM finance.bank_transactions t
                                 WHERE t.bank_account_id = s.bank_account_id AND (t.transaction_date ${SP})::date BETWEEN s.period_start AND s.period_end
                                   AND NOT EXISTS (SELECT 1 FROM finance.reconciliations r WHERE r.bank_transaction_id = t.id))
              ORDER BY s.bank_account_id, s.period_end DESC, s.created_at DESC) i`,
    { companyId, dayEnd, includeOpening: Boolean(includeOpening), realized: realizedStatuses }, transaction);
  let gap = null;
  for (const f of found) {
    const abs = money.money(money.toString(money.sub(f.ledger, f.closing)).replace(/^-/, ''));
    if (gap === null || money.cmp(abs, gap) > 0) gap = abs;
  }
  return { gap, accounts: found.length };
}

module.exports = { readManualReviewPending, readReconciliationGap };
