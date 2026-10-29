'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { publishMarketingEvent } = require('../marketing.events.publish');

const ACTIVE_ACTION = 'SCHEDULED';

/** Reescreve o actions_result: ação SCHEDULED do canal (e da finalidade, se a supressão for por finalidade) vira SKIPPED/SUPPRESSED. */
function skipScheduled(actionsResult, channel, purpose) {
  let changed = 0;
  const next = actionsResult.map((action) => {
    const sameChannel = !action.channel || String(action.channel).toUpperCase() === channel;
    const samePurpose = !purpose || !action.purpose || String(action.purpose).toUpperCase() === purpose;
    if (action.status !== ACTIVE_ACTION || !sameChannel || !samePurpose) return action;
    changed += 1;
    return { ...action, status: 'SKIPPED', reason: 'SUPPRESSED' };
  });
  return { next, changed };
}

/**
 * Efeito da supressão, na MESMA transação: toda ação SCHEDULED daquelas pessoas no canal, em run WAITING (M9-D414), vira SKIPPED
 * com SUPPRESSED, e a run termina BLOCKED (evento automation.run.blocked). Os steps de campanha não têm linha por pessoa: o
 * disparo (M9-D412) chama o canSend na hora do envio e registra BLOCKED/SUPPRESSED, então nada de campanha fica agendado para a
 * pessoa e o step compartilhado dos demais destinatários não é cancelado (DI-D418-2). Devolve os ids das runs bloqueadas.
 */
async function cancelPendingForSuppression({ personIds, channel, purpose }, tenant, transaction) {
  if (!personIds.length) return [];
  const runs = await sequelize.query(
    `SELECT id, actions_result FROM marketing.automation_runs
      WHERE company_id = :companyId AND status = 'WAITING' AND subject_type = 'PERSON' AND subject_id IN (:personIds) ORDER BY id FOR UPDATE`,
    { replacements: { companyId: tenant.companyId, personIds }, type: QueryTypes.SELECT, transaction }
  );
  const blockedRuns = [];
  for (const row of runs) {
    const { next, changed } = skipScheduled(row.actions_result, channel, purpose);
    if (changed === 0) continue;
    await sequelize.query(
      `UPDATE marketing.automation_runs SET actions_result = CAST(:next AS jsonb), status = 'BLOCKED', blocked_reason = 'SUPPRESSED',
              next_due_at = NULL, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = :id AND company_id = :companyId`,
      { replacements: { next: JSON.stringify(next), id: row.id, companyId: tenant.companyId }, transaction }
    );
    await publishMarketingEvent({ type: 'automation.run.blocked', payload: { runId: row.id, blockedReason: 'SUPPRESSED' }, tenant }, transaction);
    blockedRuns.push(row.id);
  }
  return blockedRuns;
}

module.exports = { cancelPendingForSuppression, skipScheduled };
