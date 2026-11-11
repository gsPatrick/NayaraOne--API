'use strict';

/**
 * M9-D615 (3.3) — componentes do read model que saem do ledger (finance.financial_entries), numa só leitura agregada no banco (nenhuma
 * linha vem para a aplicação). Regras do mapa de status do Financeiro: "a pagar" e "a receber" são PENDING; "liquidado" é SETTLED;
 * REVERSED e CANCELLED nunca somam; o lançamento de estorno (reversal_of_entry_id) não entra (o original já está REVERSED); "próprio" é
 * is_third_party_funds = false. Entrada e saída vêm de `nature` (RECEIVABLE, PAYABLE), como no relatório de saúde do Financeiro.
 */
const { sequelize } = require('../../../models');
const { iso } = require('./financeHealth.dates');
// M4LR: regra do saldo e da linha do ledger nas funções do banco (migration 20260101010520), a mesma do Financeiro — sem importar o módulo.
const OPEN_AMOUNT = (alias) => `(${alias}.amount - finance.entry_realized_by_children(${alias}.id))`;
const IS_LEDGER_ROW = (alias) => `(${alias}.ledger_exclusion_reason IS NULL AND NOT finance.entry_has_settlement_children(${alias}.id))`;

// M4LR (verificação do Marco 4, 11/11/2026, sondas P6/P10): "a pagar"/"a receber" são o SALDO EM ABERTO (open_amount) de PENDING e
// PARTIALLY_SETTLED (o recebível parcialmente recebido não some); o liquidado só conta linha do ledger (ledger_row): o pai quitado em
// baixas parciais não soma junto com as baixas. A mesma regra do relatório semanal do Financeiro (infrastructure/repositories/ledger-sql.js).
const OWN = 'NOT is_third_party_funds';
const OPEN = "status IN ('PENDING', 'PARTIALLY_SETTLED')";
const sumWhen = (cond, alias) => `COALESCE(SUM(open_amount) FILTER (WHERE ${cond}), 0)::text AS ${alias}`;
const pendingDue = (nature, from, to) => `${OPEN} AND nature = '${nature}' AND ${OWN} AND due_at >= ${from} AND due_at < ${to}`;
const SETTLED_BY_DAY_END = "status = 'SETTLED' AND settled_at < :dayEnd AND ledger_row";

async function readEntryComponents(companyId, bounds, transaction) {
  const b = Object.fromEntries(Object.entries(bounds).map(([k, v]) => [k, iso(v)]));
  const [[row]] = await sequelize.query(
    `SELECT
       (COALESCE(SUM(amount) FILTER (WHERE ${SETTLED_BY_DAY_END} AND nature = 'RECEIVABLE' AND ${OWN}), 0)
        - COALESCE(SUM(amount) FILTER (WHERE ${SETTLED_BY_DAY_END} AND nature = 'PAYABLE' AND ${OWN}), 0))::text AS free_cash,
       (COALESCE(SUM(amount) FILTER (WHERE ${SETTLED_BY_DAY_END} AND nature = 'RECEIVABLE' AND is_third_party_funds), 0)
        - COALESCE(SUM(amount) FILTER (WHERE ${SETTLED_BY_DAY_END} AND nature = 'PAYABLE' AND is_third_party_funds), 0))::text AS third_party_cash,
       ${sumWhen(pendingDue('PAYABLE', ':today', ':horizon7'), 'payables_7d')},
       ${sumWhen(pendingDue('PAYABLE', ':today', ':horizon30'), 'payables_30d')},
       ${sumWhen(pendingDue('PAYABLE', ':today', ':horizon60'), 'payables_60d')},
       ${sumWhen(pendingDue('RECEIVABLE', ':today', ':horizon7'), 'receivables_7d')},
       ${sumWhen(pendingDue('RECEIVABLE', ':today', ':horizon30'), 'receivables_30d')},
       ${sumWhen(pendingDue('RECEIVABLE', ':today', ':horizon60'), 'receivables_60d')},
       ${sumWhen(`${OPEN} AND nature = 'PAYABLE' AND NOT is_third_party_funds AND due_at < :today`, 'overdue_payables')},
       ${sumWhen(`${OPEN} AND nature = 'RECEIVABLE' AND NOT is_third_party_funds AND due_at < :today`, 'overdue_amount')},
       ${sumWhen(`${OPEN} AND nature = 'RECEIVABLE' AND NOT is_third_party_funds AND due_at >= :windowStart AND due_at < :today`, 'overdue_in_window')},
       ${sumWhen(`${OPEN} AND nature = 'RECEIVABLE' AND NOT is_third_party_funds AND due_at < :windowStart`, 'overdue_outside_window')},
       COALESCE(SUM(amount) FILTER (WHERE status NOT IN ('REVERSED', 'CANCELLED') AND parent_entry_id IS NULL AND nature = 'RECEIVABLE' AND NOT is_third_party_funds AND due_at >= :windowStart AND due_at < :dayEnd), 0)::text AS receivables_base,
       COUNT(*) FILTER (WHERE ${OPEN} AND nature IN ('PAYABLE', 'RECEIVABLE') AND NOT is_third_party_funds AND due_at IS NULL)::int AS without_due_date,
       COUNT(*) FILTER (WHERE ${OPEN} AND nature = 'PAYABLE' AND NOT is_third_party_funds AND due_at IS NULL)::int AS payables_without_due_date,
       COUNT(*) FILTER (WHERE ${OPEN} AND nature = 'RECEIVABLE' AND NOT is_third_party_funds AND due_at IS NULL)::int AS receivables_without_due_date
     FROM (SELECT e.*, ${OPEN_AMOUNT('e')} AS open_amount, ${IS_LEDGER_ROW('e')} AS ledger_row
             FROM finance.financial_entries e
            WHERE e.company_id = :companyId AND e.reversal_of_entry_id IS NULL) e`,
    { replacements: { companyId, ...b }, transaction }
  );
  return row;
}

/** Margem de UM setor e mês de competência: receita e custo próprios liquidados (nunca terceiros nem estornos). */
async function readSectorMargin(companyId, { resultCenterId, competenceMonth }, nilCenter, transaction) {
  const [[row]] = await sequelize.query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE nature = 'RECEIVABLE'), 0)::text AS revenue, COALESCE(SUM(amount) FILTER (WHERE nature = 'PAYABLE'), 0)::text AS cost
       FROM finance.financial_entries
      WHERE company_id = :companyId AND status = 'SETTLED' AND NOT is_third_party_funds AND reversal_of_entry_id IS NULL AND ${IS_LEDGER_ROW('financial_entries')}
        AND nature IN ('RECEIVABLE', 'PAYABLE') AND competence_month = :competenceMonth
        AND COALESCE(result_center_id, CAST(:nil AS uuid)) = :resultCenterId`,
    { replacements: { companyId, competenceMonth, resultCenterId, nil: nilCenter }, transaction }
  );
  return row;
}

module.exports = { readEntryComponents, readSectorMargin };
