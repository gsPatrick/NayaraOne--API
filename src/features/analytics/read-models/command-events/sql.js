'use strict';

/**
 * M9-D710 — peças de SQL comuns às três fontes dos fatos do Centro de Comando. Cada fonte entrega uma consulta "fato" (CTE `f`) com as colunas
 * occurred_at, amount, is_third_party, broker_id, contract_type, origin, account_id, event_id, reversal_event_id, live (o fato existiu) e reversed (foi revertido na origem);
 * `withReversal` a transforma nas linhas do read model: a original (revision 0) e, se revertido, a compensatória (revision 1) com o MESMO instante, valor negado e count_effect -1.
 * A original nunca muda por causa da reversão; a compensatória herda occurred_at para que a soma de qualquer janela que contém o fato dê zero (DI-D710-2).
 */
const { sqlDay } = require('../aggregateModel.sql');

const COLUMNS = ['source_type', 'occurred_at', 'occurred_date', 'amount', 'is_reversal', 'is_third_party', 'broker_id', 'source_event_id', 'contract_type', 'origin', 'account_id', 'count_effect'];
const NIL_UUID = "CAST(NULL AS uuid)";
const NIL_TEXT = "CAST(NULL AS text)";

/** Primeiro evento do outbox (por instante e id) do registro com o tipo dado e, opcionalmente, um campo do payload igual a `payloadEquals`. */
function firstEvent(aggregateIdExpr, eventType, payloadEquals) {
  const filter = payloadEquals ? ` AND ob.payload_json->>'${payloadEquals.field}' = '${payloadEquals.value}'` : '';
  return `(SELECT ob.id FROM integration.outbox_events ob WHERE ob.company_id = :companyId AND ob.aggregate_id = ${aggregateIdExpr} AND ob.event_type = '${eventType}'${filter} ORDER BY ob.occurred_at, ob.id LIMIT 1)`;
}

const side = (revision, sourceType, reversal) => `
  SELECT ${revision} AS revision, '${sourceType}' AS source_type, f.occurred_at, CASE WHEN f.occurred_at IS NULL THEN NULL ELSE to_char(${sqlDay('f.occurred_at')}, 'YYYY-MM-DD') END AS occurred_date,
         ${reversal ? '-f.amount' : 'f.amount'} AS amount, ${reversal ? 'true' : 'false'} AS is_reversal, f.is_third_party, f.broker_id,
         ${reversal ? 'f.reversal_event_id' : 'f.event_id'} AS source_event_id, f.contract_type, f.origin, f.account_id, ${reversal ? '-1' : '1'} AS count_effect
    FROM f WHERE f.live${reversal ? ' AND f.reversed' : ''}`;

const withReversal = (sourceType, fact) => `WITH f AS (${fact}) ${side(0, sourceType, false)} UNION ALL ${side(1, sourceType, true)}`;

module.exports = { COLUMNS, NIL_UUID, NIL_TEXT, firstEvent, withReversal };
