'use strict';

const repo = require('./delivery.repository');
const { ALL_STATUSES, OPEN_STATUSES, STATUS, REPROCESSABLE_FAILED, CODES } = require('./delivery.constants');

const NO_REASON = 'SEM_MOTIVO';

/** Esta linha (status, motivo) pode ser reprocessada pelo administrador? */
const isReprocessable = (status, reason) => (status === STATUS.FAILED && REPROCESSABLE_FAILED.includes(reason)) || (status === STATUS.BLOCKED && reason === CODES.CANSEND_ERROR);

/**
 * Resumo das entregas da campanha para a consulta (GET /marketing/campaigns/:id): contagem por status (SENT, BLOCKED, FAILED, RETRY, UNKNOWN, CANCELLED), os
 * motivos de cada status que não é SENT, quantas estão abertas (voltam sozinhas), a próxima volta agendada e quantas o administrador pode reprocessar.
 * Só contagens: nenhuma pessoa, endereço ou conteúdo sai (Caderno §14).
 */
async function deliverySummary(campaignId, tenant, transaction) {
  const rows = await repo.summaryRows(campaignId, tenant, transaction);
  const byStatus = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  const reasonsByStatus = {};
  let nextAttemptAt = null;
  let reprocessable = 0;
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + r.n;
    if (r.status !== STATUS.SENT) {
      reasonsByStatus[r.status] = reasonsByStatus[r.status] || {};
      const key = r.reason || NO_REASON;
      reasonsByStatus[r.status][key] = (reasonsByStatus[r.status][key] || 0) + r.n;
    }
    if (OPEN_STATUSES.includes(r.status) && r.next_at && (!nextAttemptAt || new Date(r.next_at) < nextAttemptAt)) nextAttemptAt = new Date(r.next_at);
    if (isReprocessable(r.status, r.reason)) reprocessable += r.n;
  }
  return {
    byStatus, reasonsByStatus, open: OPEN_STATUSES.reduce((n, s) => n + byStatus[s], 0), nextAttemptAt: nextAttemptAt ? nextAttemptAt.toISOString() : null, reprocessable,
  };
}

module.exports = { deliverySummary, isReprocessable };
