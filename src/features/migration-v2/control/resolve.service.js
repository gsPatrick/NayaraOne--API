'use strict';

const { DECISIONS } = require('./record.states');
const { FINAL_RECONCILIATION } = require('../raci/raci.constants');
const access = require('../raci/raci.access');
const errors = require('./control.errors');
const { lockRecord, transitionLocked } = require('./record.transition');
const { approveRecord } = require('./resolve.apply');

const EXCLUDE = 'EXCLUDE';

function parseBody(body) {
  const decision = body && typeof body.decision === 'string' ? body.decision.trim().toUpperCase() : '';
  const reason = body && typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!decision || !reason) throw errors.reasonRequired();
  return { decision, reason };
}

/**
 * POST /migration/records/:id/resolve (M9-D901 §3.1.1): decisão humana sobre um registro em QUARANTINED (REPROCESS, SEND_TO_REVIEW, EXCLUDE) ou PENDING_REVIEW (APPROVE,
 * QUARANTINE, EXCLUDE), sempre com motivo. Ordem das recusas: 400 sem decisão/motivo, 404 sem registro, 403 sem ser R ou A da reconciliação final, 409 decisão fora da lista do
 * estado atual, 403 EXCLUDE sem ser o A. REPROCESS só devolve o registro a PENDING; o próximo lote do aplicador da D900 o processa.
 */
async function resolveRecord(tenant, actor, recordId, body, transaction) {
  const { decision, reason } = parseBody(body);
  const record = await lockRecord(tenant, recordId, transaction);
  const roles = await access.rolesOf(tenant, actor, FINAL_RECONCILIATION, transaction);
  if (!access.isResponsibleOrAccountable(roles)) throw errors.raciForbidden(false);
  const to = (DECISIONS[record.state] || {})[decision];
  if (!to) throw errors.invalidTransition(record.state, decision);
  if (decision === EXCLUDE && !roles.A) throw errors.raciForbidden(true);
  const saved = decision === 'APPROVE'
    ? await approveRecord(tenant, actor, record, reason, transaction)
    : await transitionLocked(tenant, actor, record, to, { reason, decision }, transaction);
  return { id: record.id, decision, previous_state: record.state, state: saved.state, reason, target_entity_id: saved.target_entity_id || null };
}

module.exports = { resolveRecord };
