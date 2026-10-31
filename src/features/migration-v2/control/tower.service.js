'use strict';

const runs = require('../ingest/run.repository');
const { UUID } = require('../externalRefs.input');
const raci = require('../raci/raci.service');
const errors = require('./control.errors');
const counters = require('./counters.service');
const countersRepo = require('./counters.repository');
const rules = require('./blockers.rules');
const blockersRepo = require('./blockers.repository');
const { syncBlockers } = require('./blockers.sync');
const { computeEta } = require('./eta.service');
const providers = require('./blockers.providers');
require('../parallel/blockers.provider'); // registra os blockers da comparação paralela (M9-D903) no ponto de extensão
require('../rollback/blockers.provider'); // registra os blockers do plano de rollback (M9-D907) no ponto de extensão

/** A execução pedida (404 se não existir nesta empresa) ou a mais recente; sem nenhuma execução, o escopo é a empresa toda. */
async function pickRun(tenant, runId, transaction) {
  if (runId !== undefined && runId !== null && runId !== '') {
    const run = UUID.test(String(runId)) ? await runs.get(tenant, String(runId), transaction) : null;
    if (!run) throw errors.runNotFound();
    return run;
  }
  return runs.latest(tenant, transaction);
}

const inScope = (blocker, scope) => (!scope.sourceSystem || !blocker.detail.source_system || blocker.detail.source_system === scope.sourceSystem) && (!scope.entity || !blocker.entity || blocker.entity === scope.entity);
const view = (b) => ({ code: b.code, entity: b.entity, ref: b.ref, since: b.since, owner: b.owner, detail: b.detail });

/** Os blockers de agora, sobre a empresa toda (nada é gravado): condições próprias da Torre e provedores registrados. Também usado pelo avanço do canary (M9-D904). */
async function computeBlockers(tenant, scope, transaction) {
  const [rows, batchStates, matrix, extra] = await Promise.all([
    countersRepo.readSideBySide(tenant, transaction), blockersRepo.batchStates(tenant, transaction), raci.getMatrix(tenant, transaction), providers.collect(tenant, scope, transaction),
  ]);
  const summary = counters.summarize(rows);
  return { summary, blockers: rules.evaluate({ groups: summary, batchStates, activities: matrix.activities, extra }) };
}

/**
 * GET /migration/control-tower (M9-D901): contadores (total, migrated, reconciled, quarantined, pending_review, excluded, not_started) no total e por entidade, os blockers
 * abertos, o ETA e o que depende de pessoas. Os blockers são calculados sobre a empresa toda e gravados (abrem/fecham com auditoria); a resposta mostra os do escopo da execução.
 */
async function getTower(tenant, actor, { runId } = {}, transaction) {
  const run = await pickRun(tenant, runId, transaction);
  const scope = { sourceSystem: run ? run.source_system : null, entity: run ? run.entity : null };
  const { summary, blockers } = await computeBlockers(tenant, scope, transaction);
  const open = await syncBlockers(tenant, actor, blockers, transaction);
  const { totals, byEntity, invariants } = counters.aggregate(summary, scope);
  return {
    run_id: run ? run.id : null,
    run: run ? { id: run.id, status: run.status, source_system: run.source_system, entity: run.entity, last_delta: run.last_delta, created_at: run.created_at, finished_at: run.finished_at } : null,
    scope: { source_system: scope.sourceSystem, entity: scope.entity },
    totals,
    by_entity: byEntity,
    invariants,
    blockers: open.filter((b) => inScope(b, scope)).map(view),
    eta: await computeEta(tenant, scope, totals.not_started, transaction),
    pending_human: { quarantined: totals.quarantined, pending_review: totals.pending_review },
    excluded_summary: { count: totals.excluded },
    generated_at: new Date().toISOString(),
  };
}

module.exports = { getTower, computeBlockers };
