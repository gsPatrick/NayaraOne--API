'use strict';

// Apoio dos testes M9-D901 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Estes testes COMMITAM dados; cada teste usa um sistema de origem exclusivo.
const env = require('./m9d900Env');
const raci = require('../../../src/features/migration-v2/raci/raci.service');
const tower = require('../../../src/features/migration-v2/control/tower.service');
const resolver = require('../../../src/features/migration-v2/control/resolve.service');
const counters = require('../../../src/features/migration-v2/control/counters.service');

const { openTenantTx, q } = env;
const ACTIVITY = 'FINAL_RECONCILIATION';

/** Insere N registros de origem no estado dado (direto no banco, como o aplicador deixaria). Chaves `<prefixo><i>`. */
async function seedRecords(tenant, system, entity, counts, { prefix = 'k', payload = null } = {}) {
  let offset = 0;
  for (const [state, n] of Object.entries(counts)) {
    if (!n) continue;
     
    await q(
      `INSERT INTO governance.mig_records (group_id, company_id, source_system, entity, source_key, state, source_payload, row_hash)
       SELECT $1, $2, $3, $4, $5 || (gs + $7)::text, $6, $8::jsonb, md5(gs::text) FROM generate_series(1, $9::int) gs`,
      [tenant.groupId, tenant.companyId, system, entity, prefix, state, offset, payload ? JSON.stringify(payload) : null, n]
    );
    offset += n;
  }
}

/** Um registro com estado e conteúdo exatos; devolve a linha. */
async function insertRecord(tenant, system, entity, { key, state, payload = null, reason = null, targetEntityId = null, rowHash = null }) {
  const [row] = await q(
    `INSERT INTO governance.mig_records (group_id, company_id, source_system, entity, source_key, state, reason, source_payload, target_entity_id, row_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING *`,
    [tenant.groupId, tenant.companyId, system, entity, key, state, reason, payload ? JSON.stringify(payload) : null, targetEntityId, rowHash]
  );
  return row;
}

/** Execução QUEUED só para delimitar o escopo da Torre (sistema e entidade opcionais). */
async function newRun(tenant, system, entity) {
  const runsService = require('../../../src/features/migration-v2/ingest/runs.service');
  const { runId } = await openTenantTx(tenant, (tx) => runsService.createRun(tenant, { userId: tenant.userId }, { sourceSystem: system, entity }, tx));
  return runId;
}

const setRaci = (tenant, activity, entries) => openTenantTx(tenant, (tx) => raci.replaceActivity(tenant, { userId: tenant.userId }, { activity, entries }, tx));
/** Deixa a atividade da reconciliação final com o usuário como A (e um perfil como R). */
const setReconciliationRaci = (tenant, accountableUserId, responsible) => setRaci(tenant, ACTIVITY, [{ userId: accountableUserId, raci: 'A' }, ...responsible]);

const getTower = (tenant, runId) => openTenantTx(tenant, (tx) => tower.getTower(tenant, { userId: tenant.userId }, { runId }, tx));
const resolve = (tenant, actor, recordId, body) => openTenantTx(tenant, (tx) => resolver.resolveRecord(tenant, actor, recordId, body, tx));
const recount = (tenant) => openTenantTx(tenant, (tx) => counters.recount(tenant, tx));
/** Usuário novo da empresa com vínculo ativo, COMMITADO (a auditoria exige o usuário real). */
const committedUser = (tenant) => openTenantTx(tenant, (tx) => env.newUser(tenant, tx));
const fail = (promise) => promise.then(() => null, (err) => err);

const openBlockers = (tenant, code) => q('SELECT * FROM governance.mig_blockers WHERE company_id = $1 AND closed_at IS NULL AND ($2::text IS NULL OR code = $2) ORDER BY code, entity, ref', [tenant.companyId, code || null]);
const codesOf = (blockers, entity) => blockers.filter((b) => !entity || b.entity === entity).map((b) => b.code).sort();
const stateOf = async (id) => (await q('SELECT state, reason, source_version, source_payload, target_entity_id FROM governance.mig_records WHERE id = $1', [id]))[0];

/** Lote já concluído, com tempos e linhas escolhidos (para o cálculo da vazão). */
async function insertBatch(tenant, system, entity, { rows, minutes, status = 'APPLIED', finishedAt, replayOf = null, runId }) {
  const [source] = await q('SELECT id FROM governance.mig_sources WHERE company_id = $1 AND source_system = $2 AND entity = $3', [tenant.companyId, system, entity]);
  const [row] = await q(
    `INSERT INTO governance.mig_batches (group_id, company_id, run_id, source_id, source_system, entity, row_count, status, started_at, finished_at, replay_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz - make_interval(mins => $10::int), $9::timestamptz, $11) RETURNING *`,
    [tenant.groupId, tenant.companyId, runId, source.id, system, entity, rows, status, finishedAt || new Date().toISOString(), minutes, replayOf]
  );
  return row;
}

module.exports = { ...env, ACTIVITY, seedRecords, insertRecord, newRun, setRaci, setReconciliationRaci, getTower, resolve, recount, committedUser, fail, openBlockers, codesOf, stateOf, insertBatch, raci };
