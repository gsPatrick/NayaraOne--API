'use strict';

/**
 * M9-D710 — fonte PAYMENT_SETTLED: saída (DEBIT PAYABLE) liquidada. Entra TODA liquidação (o limiar "relevante" é lido do parâmetro na hora do cálculo, então mudar o valor não exige
 * reconstruir). O lançamento-pai que tem baixa parcial liquidada fica de fora (as baixas contam). Revertida = status REVERSED (estorno total; o lançamento compensatório não é um fato);
 * estorno parcial não reverte o fato (DI-D710-3). Dinheiro de terceiros fica marcado e nunca soma ao próprio. Liquidação sem settled_at fica sem occurred_at (o KPI sai INCOMPLETE).
 */
const { withReversal, firstEvent, NIL_TEXT, NIL_UUID } = require('./sql');

const KIND = 'PAYMENT_SETTLED';
const EVENTS = Object.freeze(['finance.entry.settled', 'finance.entry.reversed']);
const BASE = `e.company_id = :companyId AND e.entry_type = 'DEBIT' AND e.nature = 'PAYABLE' AND e.reversal_of_entry_id IS NULL AND e.status IN ('SETTLED', 'REVERSED')
  AND NOT EXISTS (SELECT 1 FROM finance.financial_entries ch WHERE ch.parent_entry_id = e.id AND ch.company_id = e.company_id AND ch.nature = 'PAYABLE' AND ch.status IN ('SETTLED', 'REVERSED'))`;

const fact = () => `
  SELECT e.settled_at AS occurred_at, e.amount, e.is_third_party_funds AS is_third_party, ${NIL_UUID} AS broker_id, ${NIL_TEXT} AS contract_type, ${NIL_TEXT} AS origin, e.bank_account_id AS account_id,
         ${firstEvent('e.id', 'finance.entry.settled')} AS event_id, ${firstEvent('e.id', 'finance.entry.reversed')} AS reversal_event_id, true AS live, (e.status = 'REVERSED') AS reversed
    FROM finance.financial_entries e WHERE ${BASE} AND e.id = :sourceId`;

const keysSql = ({ full }) => `SELECT e.id::text AS source_id FROM finance.financial_entries e WHERE ${BASE}${full ? '' : ' AND e.updated_at >= :since'}`;

module.exports = { kind: KIND, sourceType: 'FinancialEntry', eventTypes: EVENTS, idOf: (event) => { const p = event.payloadJson || event.payload || {}; return p.originalEntryId || p.id || event.aggregateId; }, slice: () => withReversal('FinancialEntry', fact()), keysSql, replacements: () => ({}) };
