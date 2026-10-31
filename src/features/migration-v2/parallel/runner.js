'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { getSetting } = require('../../settings/settings.service');
const { KEYS: INGEST_KEYS, INGEST_SETTING_DEFAULTS } = require('../ingest/ingest.settings');
const logger = require('../../../utils/logger');
const { KEYS, PARALLEL_SETTING_DEFAULTS } = require('./parallel.settings');
const windows = require('./window.repository');
const runs = require('./run.repository');
const results = require('./results.repository');
const refs = require('./refs.repository');
const { compareEntity, tupleKey } = require('./comparator');
const { RESULT } = require('./compare.rule');

const MIN_MS = 60 * 1000;

const audit = (tenant, actor, action, entityType, entityId, afterJson, reason, transaction) => registrarAuditoria({
  groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor && actor.userId, action, entityType, entityId, afterJson, reason,
}, transaction);

/**
 * A comparação está na hora? (M9-D903 §3.1 e §3.6). Sem execução anterior, sim; depois, a cada `interval_min`. Passado o `ends_at`, a janela ainda RUNNING continua no ritmo
 * normal enquanto houver diferença aberta; e na primeira vez que o tempo acaba (a última execução concluída é anterior ao fim) roda uma comparação final, sem esperar o intervalo.
 */
function isDue(window, last, now) {
  if (!last) return true;
  if (now - new Date(last.started_at) >= window.interval_min * MIN_MS) return true;
  return now >= new Date(window.ends_at) && last.status === 'COMPLETED' && new Date(last.started_at) < new Date(window.ends_at);
}

/** Fase 1 (transação curta, janela travada): decide se roda, abre a execução e junta o que a execução precisa. */
async function reserve(tenant, actor, windowId, now) {
  return openTenantTx(tenant, async (transaction) => {
    let window = await windows.lock(tenant, windowId, transaction);
    if (!window) return { skipped: 'NOT_FOUND' };
    if (window.status === 'CLOSED') return { skipped: 'CLOSED' };
    if (window.status === 'SCHEDULED') {
      if (now < new Date(window.starts_at)) return { skipped: 'NOT_STARTED' };
      if (now >= new Date(window.ends_at)) return { skipped: 'EXPIRED' };
      window = await windows.setStatus(tenant, windowId, 'RUNNING', transaction);
      await audit(tenant, actor, 'migration.parallel.window.started', 'ParallelWindow', windowId, { status: 'RUNNING' }, 'Janela de comparação paralela iniciada.', transaction);
    }
    const timeout = Number(await getSetting(KEYS.TIMEOUT_MIN, tenant, transaction, PARALLEL_SETTING_DEFAULTS[KEYS.TIMEOUT_MIN]));
    await runs.failStale(tenant, windowId, new Date(now.getTime() - timeout * MIN_MS), transaction);
    if (await runs.running(tenant, windowId, transaction)) return { skipped: 'BUSY' };
    if (!isDue(window, await runs.last(tenant, windowId, transaction), now)) return { skipped: 'NOT_DUE' };
    const run = await runs.open(tenant, windowId, now, transaction);
    const sources = [];
    for (const entity of window.entities) {
       
      const source = await refs.sourceFor(tenant, window.source_system, entity, transaction);
      if (source) sources.push(source);
    }
    const rules = (await windows.listRules(tenant, windowId, transaction)).map((rule) => ({
      entity: rule.entity, field: rule.field, rule: rule.rule, tolerance: rule.tolerance, enumMap: rule.enum_map, options: rule.options,
    }));
    const open = await results.openBlockers(tenant, windowId, transaction);
    const timeZone = String(await getSetting(KEYS.TIMEZONE, tenant, transaction, PARALLEL_SETTING_DEFAULTS[KEYS.TIMEZONE])).trim();
    const pageSize = Number(await getSetting(INGEST_KEYS.BATCH_SIZE, tenant, transaction, INGEST_SETTING_DEFAULTS[INGEST_KEYS.BATCH_SIZE]));
    return { window, run, sources, rules, open, timeZone, pageSize };
  });
}

const emptyTally = () => ({ records: 0, fields: 0, MATCH: 0, DIFF_ALLOWED: 0, DIFF_BLOCKER: 0, MISSING_IN_NEW: 0, MISSING_IN_OLD: 0 });
const sumTally = (a, b) => Object.fromEntries(Object.keys(a).map((key) => [key, a[key] + (b[key] || 0)]));

/** Fase 2 (sem transação aberta): lê a origem e compara, entidade por entidade. Sai com as linhas a gravar e a contagem. */
async function compareAll(tenant, plan) {
  const openSet = new Set(plan.open.map((row) => tupleKey(row.entity, row.source_key, row.field)));
  const ctx = { timeZone: plan.timeZone };
  let rows = [];
  let tally = emptyTally();
  const perEntity = {};
  for (const source of plan.sources) {
     
    const out = await compareEntity({ tenant, source, rules: plan.rules, ctx, pageSize: plan.pageSize, openSet });
    rows = rows.concat(out.rows);
    tally = sumTally(tally, out.tally);
    perEntity[source.entity] = out.tally;
  }
  return { rows, tally, perEntity, openSet };
}

/**
 * Fase 3 (uma transação): grava os resultados, tira da lista as diferenças em aberto que esta execução não repetiu (o MATCH que as fecha), conclui a execução e, passado o
 * `ends_at`, fecha a janela se não sobrou diferença. Tudo ou nada: se algo falha, a execução vira FAILED e nenhum resultado fica.
 */
async function persist(tenant, actor, plan, outcome, now) {
  return openTenantTx(tenant, async (transaction) => {
    const window = await windows.lock(tenant, plan.window.id, transaction);
    const blockerNow = new Set(outcome.rows.filter((row) => row.result === RESULT.BLOCKER).map((row) => tupleKey(row.entity, row.sourceKey, row.field)));
    const written = new Set(outcome.rows.map((row) => tupleKey(row.entity, row.sourceKey, row.field)));
    const closing = plan.open
      .filter((row) => !blockerNow.has(tupleKey(row.entity, row.source_key, row.field)) && !written.has(tupleKey(row.entity, row.source_key, row.field)))
      .map((row) => ({ entity: row.entity, sourceKey: row.source_key, field: row.field, result: RESULT.MATCH, kind: null }));
    await results.insertMany(tenant, window, plan.run, [...outcome.rows, ...closing], transaction);
    const summary = { ...outcome.tally, resolved: plan.open.filter((row) => !blockerNow.has(tupleKey(row.entity, row.source_key, row.field))).length, per_entity: outcome.perEntity };
    await runs.finish(tenant, plan.run.id, 'COMPLETED', null, summary, now, transaction);
    const open = await results.openBlockers(tenant, window.id, transaction);
    let closed = false;
    if (window.status === 'RUNNING' && now >= new Date(window.ends_at) && open.length === 0) {
      await windows.setStatus(tenant, window.id, 'CLOSED', transaction);
      await audit(tenant, actor, 'migration.parallel.window.closed', 'ParallelWindow', window.id, { runNumber: plan.run.run_number, blockers: 0 }, 'Janela de comparação paralela fechada: nenhuma diferença bloqueante aberta.', transaction);
      closed = true;
    }
    await audit(tenant, actor, 'migration.parallel.run.completed', 'ParallelRun', plan.run.id, { windowId: window.id, runNumber: plan.run.run_number, summary, openBlockers: open.length }, 'Comparação paralela concluída.', transaction);
    return { summary, openBlockers: open.length, closed };
  });
}

async function markFailed(tenant, actor, plan, err, now) {
  const code = err && typeof err.code === 'string' && err.code.startsWith('GOV_') ? err.code : 'GOV_PARALLEL_RUN_FAILED';
  await openTenantTx(tenant, async (transaction) => {
    await runs.finish(tenant, plan.run.id, 'FAILED', code, { error: code }, now, transaction);
    await audit(tenant, actor, 'migration.parallel.run.failed', 'ParallelRun', plan.run.id, { windowId: plan.window.id, runNumber: plan.run.run_number, code }, 'Comparação paralela não terminou; não conta como sem diferenças.', transaction);
  });
  return code;
}

/**
 * Uma volta do comparador numa janela (M9-D903). Devolve { action: 'SKIPPED', reason } | { action: 'FAILED', code } | { action: 'COMPLETED', runNumber, summary, openBlockers, closed }.
 * `now` é injetável (testes). Duas instâncias do job na mesma janela não correm juntas: a janela é travada e só uma execução RUNNING existe por janela.
 */
async function tickWindow(tenant, windowId, { now = new Date(), actor = { userId: null } } = {}) {
  const plan = await reserve(tenant, actor, windowId, now);
  if (plan.skipped) return { action: 'SKIPPED', reason: plan.skipped };
  let outcome;
  try {
    outcome = await compareAll(tenant, plan);
  } catch (err) {
    const code = await markFailed(tenant, actor, plan, err, now);
    logger.warn({ windowId, runNumber: plan.run.run_number, code }, 'migration.parallel.run.failed');
    return { action: 'FAILED', code, runNumber: plan.run.run_number };
  }
  try {
    const done = await persist(tenant, actor, plan, outcome, now);
    return { action: 'COMPLETED', runNumber: plan.run.run_number, ...done };
  } catch (err) {
    const code = await markFailed(tenant, actor, plan, err, now);
    logger.error({ windowId, runNumber: plan.run.run_number, code, err: err.message }, 'migration.parallel.persist.failed');
    return { action: 'FAILED', code, runNumber: plan.run.run_number };
  }
}

module.exports = { tickWindow, isDue };
