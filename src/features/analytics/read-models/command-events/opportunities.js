'use strict';

/**
 * M9-D710 — fonte OPPORTUNITY_WON: oportunidade que entrou no estágio ganho (WON, com closed_at). Valor = proposta ACCEPTED mais recente (nulo = sem proposta aceita: entra em
 * details.withoutValue). Corretor = owner_user_id; origem = lead_source (vazio = SEM_ORIGEM). Revertida = oportunidade que tinha sido ganha (evento crm.opportunity.won no outbox) e hoje
 * está excluída ou fora de WON; o instante do ganho continua o closed_at.
 */
const { withReversal, firstEvent, NIL_TEXT, NIL_UUID } = require('./sql');

const KIND = 'OPPORTUNITY_WON';
const EVENTS = Object.freeze(['crm.opportunity.won', 'crm.opportunity.stage_changed']);
const WON_EVENT = firstEvent('o.id', 'crm.opportunity.won');
const IS_WON = "(o.stage = 'WON' AND o.closed_at IS NOT NULL)";
const LIVE = `(${IS_WON} OR (o.closed_at IS NOT NULL AND ${WON_EVENT} IS NOT NULL))`;

const fact = () => `
  SELECT o.closed_at AS occurred_at,
         (SELECT p.value FROM crm.proposals p WHERE p.opportunity_id = o.id AND p.company_id = o.company_id AND p.status = 'ACCEPTED' AND p.deleted_at IS NULL
           ORDER BY COALESCE(p.decided_at, p.updated_at) DESC, p.id LIMIT 1) AS amount,
         false AS is_third_party, o.owner_user_id AS broker_id, ${NIL_TEXT} AS contract_type, COALESCE(NULLIF(o.lead_source, ''), 'SEM_ORIGEM') AS origin, ${NIL_UUID} AS account_id,
         ${WON_EVENT} AS event_id, ${NIL_UUID} AS reversal_event_id, ${LIVE} AS live, (o.deleted_at IS NOT NULL OR o.stage <> 'WON') AS reversed
    FROM crm.opportunities o WHERE o.company_id = :companyId AND o.id = :sourceId`;

const keysSql = ({ full }) => `SELECT o.id::text AS source_id FROM crm.opportunities o WHERE o.company_id = :companyId AND ${LIVE}${full ? '' : ' AND o.updated_at >= :since'}`;

module.exports = { kind: KIND, sourceType: 'Opportunity', eventTypes: EVENTS, idOf: (event) => (event.payloadJson || event.payload || {}).id || event.aggregateId, slice: () => withReversal('Opportunity', fact()), keysSql, replacements: () => ({}) };
