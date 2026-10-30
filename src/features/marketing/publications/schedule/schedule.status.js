'use strict';

const jobs = require('./schedule.jobs');

const TERMINAL = ['PUBLISHED', 'FAILED'];
const ACTIVE = jobs.ACTIVE;

/**
 * Status do item derivado dos jobs (M9-D410 item 3). Jobs CANCELLED são ignorados. Sem job restante: null (vale a transição da M9-D406, SCHEDULED -> APPROVED).
 * Todos PUBLISHED: PUBLISHED. Todos terminados e algum falhou: FAILED. Enquanto houver PENDING, RUNNING ou UNKNOWN: PUBLISHING, desde que o item já tenha saído
 * de SCHEDULED (primeiro job RUNNING, ou algum job já terminado); senão continua como está (agendado, ainda sem job em andamento).
 */
function deriveItemStatus(jobStatuses, currentStatus) {
  const live = jobStatuses.filter((s) => s !== 'CANCELLED');
  if (live.length === 0) return null;
  if (live.every((s) => s === 'PUBLISHED')) return 'PUBLISHED';
  if (live.every((s) => TERMINAL.includes(s))) return 'FAILED';
  const started = live.includes('RUNNING') || live.some((s) => TERMINAL.includes(s)) || currentStatus === 'PUBLISHING';
  return started ? 'PUBLISHING' : currentStatus;
}

const isActive = (status) => ACTIVE.includes(status);

/**
 * Recalcula e aplica o status do item a partir dos jobs da versão corrente, pela máquina de estados (M9-D406): de SCHEDULED a PUBLISHED/FAILED passa por PUBLISHING;
 * todos os jobs cancelados devolvem SCHEDULED a APPROVED e limpam o passo `schedule` da versão (para poder agendar de novo). Idempotente.
 */
async function recomputeItemStatus({ tenant, actor, itemId, reason }, transaction) {
  const content = require('../../content');
  const item = await content.service.repo.lockItem(itemId, transaction);
  if (!item || !item.current_version_id) return { itemId, status: item ? item.status : null, changed: false };
  const rows = await jobs.statusesOfVersion(item.current_version_id, transaction);
  const target = deriveItemStatus(rows.map((r) => r.status), item.status);
  const change = (to, why) => content.service.changeStatus({ tenant, actor, itemId, to, reason: why || reason }, transaction);
  const unchanged = { itemId, status: item.status, changed: false };
  if (target === null) {
    if (item.status !== 'SCHEDULED') return unchanged;
    await jobs.dropScheduleCheck(item.current_version_id, actor, transaction);
    return { ...(await change('APPROVED', 'Todas as publicações agendadas foram canceladas.')), changed: true };
  }
  if (target === item.status || !['SCHEDULED', 'PUBLISHING'].includes(item.status)) return unchanged;
  if (item.status === 'SCHEDULED' && target !== 'PUBLISHING') await change('PUBLISHING');
  return { ...(await change(target)), changed: true };
}

module.exports = { deriveItemStatus, recomputeItemStatus, isActive };
