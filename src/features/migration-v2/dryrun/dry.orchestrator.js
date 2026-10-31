'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { getSetting } = require('../../settings/settings.service');
const clock = require('../clock/clock.service');
const sources = require('../ingest/source.repository');
const tower = require('../control/tower.service');
const tzSample = require('../timezone/timezone.sample');
const { TIMEZONE_SETTING_DEFAULTS, KEYS: TZ_KEYS } = require('../timezone/timezone.settings');
const repo = require('./dry.repository');
const { timedPhase } = require('./dry.timing');
const load = require('./dry.load');
const volume = require('./dry.volume');
const compare = require('./dry.compare');
const { simulateRollback } = require('./dry.rollback');
const { displaySamples } = require('./dry.display');
const { evaluate } = require('./dry.criteria');
const { exportReport } = require('./dry.export');
const { KEYS, DRY_SETTING_DEFAULTS } = require('./dry.settings');

const read = (tenant, key, defaults, transaction) => getSetting(key, tenant, transaction, defaults[key]);
const query = (tenant, sql, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId } });

/** Amostra de datas de borda de todas as fontes (M9-D908 §3.2.3). Falha ao ler uma fonte falha a fase. */
async function sampleAll(tenant, facts) {
  const { list, options, limit } = await openTenantTx(tenant, async (transaction) => ({
    list: await sources.list(tenant, {}, transaction),
    options: { zone: String(await read(tenant, TZ_KEYS.ORIGIN_ZONE, TIMEZONE_SETTING_DEFAULTS, transaction)).trim(), ambiguous: String(await read(tenant, TZ_KEYS.AMBIGUOUS, TIMEZONE_SETTING_DEFAULTS, transaction)).trim().toUpperCase() },
    limit: Number(await read(tenant, TZ_KEYS.SAMPLE, TIMEZONE_SETTING_DEFAULTS, transaction)),
  }));
  facts.sampled = [];
  for (const source of list) {
     
    facts.sampled.push(await tzSample.sampleSource({ tenant, source, options, limit }));
  }
  facts.tz = {
    checked: facts.sampled.reduce((sum, item) => sum + item.checked, 0),
    divergences: facts.sampled.reduce((sum, item) => sum + item.divergences.length, 0),
  };
  return { entities: facts.sampled.map((item) => ({ entity: item.entity, fields: item.fields, sampled: item.sampled, edge: item.edge, checked: item.checked, quarantined: item.quarantined, divergences: item.divergences.map((d) => ({ sourceKey: d.sourceKey, fields: d.fields.map((f) => f.field) })) })) };
}

/** Estado final: blockers da Torre (também gravados lá), lotes das execuções do ensaio e registros por estado. */
async function finalFacts(tenant, actor, runIds, facts) {
  return openTenantTx(tenant, async (transaction) => {
    await tower.getTower(tenant, actor, runIds.length ? { runId: runIds[runIds.length - 1] } : {}, transaction); // abre e fecha os blockers gravados da Torre
    facts.blockers = (await tower.computeBlockers(tenant, {}, transaction)).blockers;
    const batches = runIds.length ? await sequelize.query('SELECT status, count(*)::int AS n FROM governance.mig_batches WHERE company_id = :companyId AND run_id IN (:runIds) GROUP BY status', { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, runIds } }) : [];
    facts.batches = { total: batches.reduce((sum, row) => sum + row.n, 0), verified: (batches.find((row) => row.status === 'VERIFIED') || { n: 0 }).n, byStatus: Object.fromEntries(batches.map((row) => [row.status, row.n])) };
    const states = await query(tenant, 'SELECT state, count(*)::int AS n FROM governance.mig_records WHERE company_id = :companyId GROUP BY state', transaction);
    facts.quarantine = Object.fromEntries(states.map((row) => [row.state, row.n]));
    return { blockers: facts.blockers.length, batches: facts.batches, records: facts.quarantine };
  });
}

/**
 * Executa o DRY3 do relatório `reportId` (M9-D908 §3.3): relógio, carga inicial, delta, verificação de hash por lote, contagem por entidade, amostra de datas de borda, comparação
 * paralela, ativação por setor com simulação de rollback e a Torre. Cada fase registra a duração e o erro; a conclusão sai dos seis critérios (sem aprovação manual). Erro
 * inesperado marca o ensaio ABORTED, nunca aprovado. Devolve o relatório final.
 */
async function runDryRun(tenant, actor, reportId, { now = new Date() } = {}) {
  const phases = [];
  const runIds = [];
  const facts = { blockers: [], volumes: [], batches: { total: 0, verified: 0 }, compare: { blockers: 0, failed: 1 }, clock: { status: 'UNMEASURED' }, tz: { divergences: 0, checked: 0 }, rollback: { complete: false }, sampled: [], quarantine: {} };
  const progress = (parts = {}) => openTenantTx(tenant, (transaction) => repo.save(tenant, reportId, { phases, runIds, ...parts }, transaction));
  const step = async (name, fn) => { const entry = await timedPhase(phases, name, fn); await progress(); return entry; };
  try {
    await step('CLOCK', async () => {
      const result = await clock.check(tenant, { context: 'DRY3', dryRunId: reportId });
      facts.clock = { status: result.status };
      if (result.status !== 'OK') { const err = new Error('Os relógios dos sistemas diferem além do permitido.'); err.code = result.status === 'DRIFT' ? 'GOV_MIG_CLOCK_DRIFT' : 'GOV_MIG_CLOCK_UNMEASURED'; throw err; }
      return { driftMs: result.driftMs, maxDriftMs: result.maxDriftMs, systems: result.readings.map((reading) => reading.system) };
    });
    for (const [name, lastDelta] of [['LOAD', false], ['DELTA', true]]) {
       
      await step(name, async () => {
        try {
          const summary = await load.loadAll(tenant, actor, { lastDelta });
          runIds.push(summary.runId);
          return summary;
        } catch (err) {
          if (err.runId) runIds.push(err.runId);
          throw err;
        }
      });
    }
    await step('VERIFY', () => load.verifyAll(tenant, actor));
    await step('VOLUME', async () => {
      const counted = await volume.countVolumes(tenant);
      facts.volumes = counted.volumes;
      volume.assertVolumesMatch(counted.volumes);
      return { entities: counted.volumes.length };
    });
    await step('TZ_SAMPLE', () => sampleAll(tenant, facts));
    await step('COMPARE', async () => {
      const summary = await compare.compareAll(tenant, actor, { now });
      facts.compare = { blockers: summary.blockers, failed: summary.failed };
      return summary;
    });
    await step('ROLLBACK', async () => {
      facts.rollback = await simulateRollback(tenant, actor);
      return facts.rollback;
    });
    await step('TOWER', () => finalFacts(tenant, actor, runIds, facts));
    const { criteria, conclusion } = evaluate(phases, facts);
    const samples = await openTenantTx(tenant, async (transaction) => displaySamples(tenant, { groupId: tenant.groupId, companyId: tenant.companyId, userId: actor.userId || null, permissions: [] }, facts.sampled, {
      clearPii: await read(tenant, KEYS.CLEAR_PII, DRY_SETTING_DEFAULTS, transaction) === true, limit: Number(await read(tenant, KEYS.SAMPLES, DRY_SETTING_DEFAULTS, transaction)),
    }));
    const errors = phases.filter((phase) => phase.error).map((phase) => ({ phase: phase.name, ...phase.error }));
    const blockers = facts.blockers.map((blocker) => ({ code: blocker.code, entity: blocker.entity, ref: blocker.ref }));
    const parts = { phases, runIds, volumes: facts.volumes, criteria, blockers, errors, quarantine: facts.quarantine, samples };
    const final = await openTenantTx(tenant, async (transaction) => {
      await repo.finish(tenant, reportId, { status: 'COMPLETED', conclusion, parts }, transaction);
      await registrarAuditoria({
        groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId || null, action: 'migration.dry3.completed', entityType: 'MigDryReport', entityId: reportId,
        afterJson: { conclusion, criteria: Object.fromEntries(Object.entries(criteria).map(([name, value]) => [name, value.ok])) }, reason: `Ensaio DRY3 concluído: ${conclusion}.`,
      }, transaction);
      const saved = await repo.get(tenant, reportId, transaction);
      exportReport(saved); // dentro da transação: se o arquivo não puder ser escrito, o ensaio não fica COMPLETED (vira ABORTED) e nada é aprovado
      return saved;
    });
    return final;
  } catch (err) {
    logger.error({ reportId, err: err.message }, 'migration.dry3.aborted');
    return openTenantTx(tenant, async (transaction) => {
      await repo.finish(tenant, reportId, { status: 'ABORTED', conclusion: null, parts: { phases, runIds, errors: [{ phase: 'ORCHESTRATOR', code: err.code || 'ERROR', message: String(err.message || err).slice(0, 300) }] } }, transaction);
      await registrarAuditoria({
        groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId || null, action: 'migration.dry3.aborted', entityType: 'MigDryReport', entityId: reportId,
        afterJson: { code: err.code || 'ERROR' }, reason: 'Ensaio DRY3 interrompido: sem aprovação.',
      }, transaction);
      return repo.get(tenant, reportId, transaction);
    });
  }
}

module.exports = { runDryRun };
