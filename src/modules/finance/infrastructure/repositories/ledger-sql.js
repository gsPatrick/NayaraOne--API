'use strict';

/**
 * Trechos SQL únicos do ledger (Caderno M4 §6/§7) para quem soma direto em finance.financial_entries — o relatório semanal
 * (finance-health-sources.js) e a NAY Financeira. A regra mora no banco (funções da migration 20260101010520), a mesma que o
 * read model do BI (rm_finance_health) chama, para os números baterem entre o Financeiro e a NAY (verificação 11/11/2026,
 * sondas P6 e P10):
 *   - REALIZED_BY_CHILDREN: quanto as baixas filhas realizaram (cada baixa menos os estornos que apontam para ela);
 *   - OPEN_AMOUNT: saldo em aberto = valor - realizado pelas baixas (vale para PENDING e PARTIALLY_SETTLED);
 *   - IS_LEDGER_ROW: o lançamento é ele mesmo linha do ledger — o pai com baixas filhas não é (as filhas é que são),
 *     senão o recebimento quitado em baixas parciais conta duas vezes.
 */
const REALIZED_BY_CHILDREN = (alias) => `finance.entry_realized_by_children(${alias}.id)`;

const OPEN_AMOUNT = (alias) => `(${alias}.amount - finance.entry_realized_by_children(${alias}.id))`;

const IS_LEDGER_ROW = (alias) => `(${alias}.ledger_exclusion_reason IS NULL AND NOT finance.entry_has_settlement_children(${alias}.id))`;

module.exports = { REALIZED_BY_CHILDREN, OPEN_AMOUNT, IS_LEDGER_ROW };
