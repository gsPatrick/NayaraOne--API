'use strict';

/**
 * M9-D710 — fonte CONTRACT_SIGNED: contrato cujo estado passou a assinado. Assinado = status SIGNED, ACTIVE, SUSPENDED, TERMINATED ou CLOSED; o instante é a última assinatura confirmada
 * (legal.signatures SIGNED, signed_at), porque o contrato não guarda a data. Sem assinatura com data a linha fica sem occurred_at (o KPI sai INCOMPLETE). Revertido = contrato cancelado ou
 * excluído DEPOIS de ter sido assinado (prova: evento legal.contract.status_changed para SIGNED no outbox). Valor = total_value do contrato (nulo = sem valor). Tipo = contract_type.
 */
const { withReversal, firstEvent, NIL_UUID, NIL_TEXT } = require('./sql');

const KIND = 'CONTRACT_SIGNED';
const SIGNED_STATUSES = Object.freeze(['SIGNED', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'CLOSED']);
const EVENTS = Object.freeze(['legal.contract.status_changed', 'contract.activated', 'contract.terminated']);
const STATUS_EVENT = (to) => firstEvent('c.id', 'legal.contract.status_changed', { field: 'toStatus', value: to });
const SIGNED_AT = `(SELECT max(s.signed_at) FROM legal.signatures s JOIN legal.contract_versions v ON v.id = s.contract_version_id AND v.company_id = s.company_id
   WHERE v.contract_id = c.id AND s.company_id = c.company_id AND s.status = 'SIGNED')`;
const REVERSED = "(c.deleted_at IS NOT NULL OR c.status = 'CANCELLED')";

const fact = () => `
  SELECT ${SIGNED_AT} AS occurred_at, c.total_value AS amount, false AS is_third_party, ${NIL_UUID} AS broker_id, c.contract_type, ${NIL_TEXT} AS origin, ${NIL_UUID} AS account_id,
         ${STATUS_EVENT('SIGNED')} AS event_id, ${STATUS_EVENT('CANCELLED')} AS reversal_event_id,
         (c.status IN (:signedStatuses) OR (${REVERSED} AND ${STATUS_EVENT('SIGNED')} IS NOT NULL)) AS live, ${REVERSED} AS reversed
    FROM legal.contracts c WHERE c.company_id = :companyId AND c.id = :sourceId`;

const keysSql = ({ full }) => `SELECT c.id::text AS source_id FROM legal.contracts c WHERE c.company_id = :companyId
  AND (c.status IN (:signedStatuses) OR (${REVERSED} AND ${STATUS_EVENT('SIGNED')} IS NOT NULL))${full ? '' : ' AND c.updated_at >= :since'}`;

module.exports = { kind: KIND, sourceType: 'Contract', eventTypes: EVENTS, idOf: (event) => (event.payloadJson || event.payload || {}).id || event.aggregateId, slice: () => withReversal('Contract', fact()), keysSql, replacements: () => ({ signedStatuses: SIGNED_STATUSES }) };
