'use strict';

const { actionKey } = require('./idempotency.keys');

/**
 * M9-D415 — regras de replay de uma run (Guia §5): COMPLETED/BLOCKED não reexecutam; WAITING nunca é "travada" (espera o due_at das ações
 * SCHEDULED, M9-D414); FAILED, ou STARTED sem fim há mais de `marketing.runner.timeout_s`, reexecutam SOMENTE as ações cuja entrada não é
 * OK nem SKIPPED. Ação UNKNOWN passa antes por reconciliação (consulta ao adapter pela action_key). Ação SCHEDULED mantém a mesma action_key.
 */
const UNKNOWN_MESSAGE = 'Verificando a ação antes de repetir.';
const asDate = (v) => (v instanceof Date ? v : new Date(v));

function isRunStuck(run, timeoutS, now = new Date()) {
  if (run.status !== 'STARTED' || run.finishedAt) return false;
  return now.getTime() - asDate(run.startedAt).getTime() > Number(timeoutS) * 1000;
}

function shouldReplayRun(run, timeoutS, now) {
  if (run.status === 'FAILED') return true;
  return isRunStuck(run, timeoutS, now);
}

/** Lista inicial de actions_result: uma entrada PENDING por ação, com a action_key calculada uma vez e nunca mais trocada. */
function buildActionsResult(runKey, actions) {
  return actions.map((action, index) => ({
    index, type: action.type, action_key: actionKey(runKey, index, action.type), status: 'PENDING', due_at: null, provider_ref: null, error_code: null,
  }));
}

/** Adia a ação `index` até `dueAt`: muda o status e o due_at, NUNCA a action_key. */
function markScheduled(actionsResult, index, dueAt) {
  return actionsResult.map((e, i) => (i === index ? { ...e, status: 'SCHEDULED', due_at: new Date(dueAt).toISOString() } : e));
}

/** Menor due_at entre as ações SCHEDULED (coluna next_due_at da run), ou null. */
function nextDueAt(actionsResult) {
  const dues = actionsResult.filter((e) => e.status === 'SCHEDULED' && e.due_at).map((e) => asDate(e.due_at).getTime());
  return dues.length ? new Date(Math.min(...dues)) : null;
}

/** Pergunta ao adapter se a ação UNKNOWN chegou a acontecer. Sem resposta confiável, segue UNKNOWN (nunca repete às cegas). */
async function reconcileEntry(entry, adapter) {
  if (!adapter || typeof adapter.findByActionKey !== 'function') return { ...entry, error_code: 'MKT_ACTION_UNKNOWN' };
  try {
    const found = await adapter.findByActionKey(entry.action_key);
    if (found && found.found) return { ...entry, status: 'OK', provider_ref: found.providerRef || entry.provider_ref || null, error_code: null };
    return { ...entry, status: 'PENDING', error_code: null };
  } catch (_) {
    return { ...entry, error_code: 'MKT_ACTION_UNKNOWN' };
  }
}

/**
 * Prepara o replay. Devolve { shouldReplay, pending: [{index, type, actionKey}], actionsResult (com a reconciliação aplicada),
 * unresolved: [{actionKey, code, message}] }. `adapterFor(entry)` devolve o adapter que sabe consultar a ação.
 */
async function prepareReplay({ run, now = new Date(), timeoutS, adapterFor }) {
  const empty = { shouldReplay: false, pending: [], actionsResult: run.actionsResult || [], unresolved: [] };
  if (!shouldReplayRun(run, timeoutS, now)) return empty;
  const pending = [];
  const unresolved = [];
  const actionsResult = [];
  for (const [i, original] of (run.actionsResult || []).entries()) {
    let entry = original;
    if (entry.status === 'UNKNOWN') {
      entry = await reconcileEntry(entry, adapterFor ? adapterFor(entry) : null);
      if (entry.status === 'UNKNOWN') unresolved.push({ actionKey: entry.action_key, code: 'MKT_ACTION_UNKNOWN', message: UNKNOWN_MESSAGE });
    }
    actionsResult.push(entry);
    const deferred = entry.status === 'SCHEDULED' && entry.due_at && asDate(entry.due_at).getTime() > now.getTime();
    if (['OK', 'SKIPPED', 'UNKNOWN'].includes(entry.status) || deferred) continue;
    pending.push({ index: entry.index ?? i, type: entry.type, actionKey: entry.action_key });
  }
  return { shouldReplay: true, pending, actionsResult, unresolved };
}

module.exports = { UNKNOWN_MESSAGE, isRunStuck, shouldReplayRun, buildActionsResult, markScheduled, nextDueAt, prepareReplay };
