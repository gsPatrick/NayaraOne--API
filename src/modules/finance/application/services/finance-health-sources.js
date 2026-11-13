'use strict';

/**
 * Leituras do relatório semanal de saúde (Caderno M4 §19; Guia §13 "FinanceHealthReport"), todas sob o RLS da empresa do
 * contexto e somadas no banco em decimal (numeric). Verificação independente 11/11/2026 (sondas P6, P10, P12, P13):
 *   - a pagar / a receber saem do SALDO EM ABERTO de PENDING e PARTIALLY_SETTLED (valor menos o realizado pelas baixas
 *     filhas, já descontados os estornos de cada baixa) — o R$ 0,30 com 0,10 baixado mostra 0,20 a receber;
 *   - o realizado (receita, custo, terceiros) sai da view finance.ledger: o pai quitado em baixas parciais não é linha do
 *     ledger (as filhas é que são), então nada conta em dobro; o estorno entra com o sinal contrário;
 *   - o caixa disponível soma só as linhas do extrato conciliadas (cada linha uma vez, mesmo em conciliação em grupo);
 *   - pendências de conciliação somam o valor absoluto; comissões provisionadas são as parcelas ainda não pagas;
 *     repasses pendentes incluem o aprovado e ainda não pago.
 */
const { sequelize } = require('../../../../models');
const { REALIZED_BY_CHILDREN } = require('../../infrastructure/repositories/ledger-sql');

const select = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: sequelize.QueryTypes.SELECT });

/** Lançamentos em aberto (a pagar, a receber e terceiros) com o saldo em aberto de cada um. */
function readOpenEntries(transaction) {
  return select(
    `SELECT id, nature, status, due_at, is_third_party_funds, amount::text AS amount, open_amount::text AS open_amount
       FROM (SELECT e.id, e.nature, e.status, e.due_at, e.is_third_party_funds, e.amount, e.amount - ${REALIZED_BY_CHILDREN('e')} AS open_amount
               FROM finance.financial_entries e
              WHERE e.status IN ('PENDING', 'PARTIALLY_SETTLED') AND e.ledger_exclusion_reason IS NULL
                AND e.nature IN ('PAYABLE', 'RECEIVABLE')) o
      WHERE open_amount > 0`,
    {},
    transaction
  );
}

/** Dinheiro de terceiro retido (realizado no ledger) e a parte dele que já está em linha de extrato conciliada. */
async function readThirdPartyHeld(transaction) {
  const [row] = await select(
    `SELECT COALESCE(SUM(l.cash_amount), 0)::text AS held,
            COALESCE(SUM(l.cash_amount) FILTER (WHERE EXISTS (SELECT 1 FROM finance.reconciliations r WHERE r.financial_entry_id = l.id)), 0)::text AS held_reconciled
       FROM finance.ledger l WHERE l.is_third_party_funds`,
    {},
    transaction
  );
  return row;
}

/** Saldo do extrato: todo o importado (informativo) e só o conciliado (§19 "saldos conciliados"), cada linha uma vez. */
async function readBankBalances(transaction) {
  const [row] = await select(
    `SELECT COALESCE(SUM(bt.amount), 0)::text AS gross,
            COALESCE(SUM(bt.amount) FILTER (WHERE EXISTS (SELECT 1 FROM finance.reconciliations r WHERE r.bank_transaction_id = bt.id)), 0)::text AS reconciled
       FROM finance.bank_transactions bt`,
    {},
    transaction
  );
  return row;
}

/** Margem por centro de resultado (§19 "Receita realizada - custos atribuídos"), do ledger próprio; o estorno entra com sinal contrário. */
function readMarginBySector(transaction) {
  return select(
    `SELECT l.result_center_id,
            COALESCE(SUM(l.cash_amount) FILTER (WHERE l.business_nature = 'RECEIVABLE'), 0)::text AS revenue,
            COALESCE(-SUM(l.cash_amount) FILTER (WHERE l.business_nature = 'PAYABLE'), 0)::text AS costs
       FROM finance.ledger l
      WHERE NOT l.is_third_party_funds AND l.business_nature IN ('RECEIVABLE', 'PAYABLE')
      GROUP BY l.result_center_id`,
    {},
    transaction
  );
}

/** Extrato sem conciliação: quantidade e valor ABSOLUTO (entrada e saída não se anulam), com a abertura por sentido. */
async function readPendingReconciliations(transaction) {
  const [row] = await select(
    `SELECT count(*)::int AS count, COALESCE(SUM(abs(bt.amount)), 0)::text AS total,
            COALESCE(SUM(bt.amount) FILTER (WHERE bt.amount > 0), 0)::text AS inflow,
            COALESCE(-SUM(bt.amount) FILTER (WHERE bt.amount < 0), 0)::text AS outflow
       FROM finance.bank_transactions bt
      WHERE NOT EXISTS (SELECT 1 FROM finance.reconciliations r WHERE r.bank_transaction_id = bt.id)`,
    {},
    transaction
  );
  return row;
}

/** §19 "Comissões provisionadas — direitos ainda não pagos": parcelas não pagas de comissão não cancelada (e a comissão antiga sem parcelas). */
async function readProvisionedCommissions(transaction) {
  const [row] = await select(
    `SELECT count(*)::int AS count, COALESCE(SUM(unpaid), 0)::text AS total FROM (
       SELECT c.id, CASE WHEN EXISTS (SELECT 1 FROM finance.commission_installments i0 WHERE i0.commission_id = c.id)
                         THEN COALESCE((SELECT SUM(i.amount) FROM finance.commission_installments i WHERE i.commission_id = c.id AND i.status NOT IN ('PAID', 'CANCELLED')), 0)
                         ELSE CASE WHEN c.status IN ('PENDING', 'APPROVED') THEN c.total_amount ELSE 0 END END AS unpaid
         FROM finance.commissions c WHERE c.deleted_at IS NULL AND c.status <> 'CANCELLED') x
      WHERE unpaid > 0`,
    {},
    transaction
  );
  return row;
}

/** §19 "Repasses pendentes — valores de terceiros/proprietários": gerado e ainda não pago (aguardando aprovação ou aprovado). */
async function readPendingOwnerRepasses(transaction) {
  const [row] = await select(
    `SELECT count(*)::int AS count, COALESCE(SUM(net_amount), 0)::text AS total,
            count(*) FILTER (WHERE status = 'APPROVED')::int AS approved_count,
            COALESCE(SUM(net_amount) FILTER (WHERE status = 'APPROVED'), 0)::text AS approved_total
       FROM finance.owner_repasses WHERE status IN ('PENDING', 'APPROVED')`,
    {},
    transaction
  );
  return row;
}

module.exports = {
  readOpenEntries,
  readThirdPartyHeld,
  readBankBalances,
  readMarginBySector,
  readPendingReconciliations,
  readProvisionedCommissions,
  readPendingOwnerRepasses,
};
