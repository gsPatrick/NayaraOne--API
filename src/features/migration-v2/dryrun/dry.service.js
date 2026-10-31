'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { getSetting } = require('../../settings/settings.service');
const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { UUID } = require('../externalRefs.input');
const errors = require('./dry.errors');
const repo = require('./dry.repository');
const { assertDisposableDatabase } = require('./dry.guard');
const { currentCommit } = require('./dry.export');
const { runDryRun } = require('./dry.orchestrator');
const { KEYS, DRY_SETTING_DEFAULTS } = require('./dry.settings');

const MIN_MS = 60 * 1000;

/**
 * POST /migration/dry-runs (M9-D908 §5): recusa fora de banco descartável (GOV_MIG_DRY_SHARED_DB), recusa um segundo ensaio em andamento (GOV_MIG_DRY_RUNNING; o ensaio RUNNING
 * além de `migracao.dry3.timeout_min` é dado como ABORTED, porque o processo caiu) e abre o relatório RUNNING. Devolve o relatório aberto; quem executa é `runDryRun`.
 */
async function openDryRun(tenant, actor, { now = new Date() } = {}) {
  assertDisposableDatabase();
  return openTenantTx(tenant, async (transaction) => {
    const timeoutMin = Number(await getSetting(KEYS.TIMEOUT_MIN, tenant, transaction, DRY_SETTING_DEFAULTS[KEYS.TIMEOUT_MIN]));
    const stale = await repo.running(tenant, transaction);
    if (stale && now - new Date(stale.startedAt) > timeoutMin * MIN_MS) {
      await repo.finish(tenant, stale.id, { status: 'ABORTED', conclusion: null, parts: { errors: [{ phase: 'ORCHESTRATOR', code: 'GOV_MIG_DRY_STALE', message: 'Ensaio sem fim dentro do prazo: processo caído.' }] } }, transaction);
    }
    const report = await repo.open(tenant, { userId: actor.userId, commit: currentCommit() }, transaction);
    if (!report) throw errors.running({ reportId: (await repo.running(tenant, transaction) || {}).id || null });
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId || null, action: 'migration.dry3.started', entityType: 'MigDryReport', entityId: report.id,
      afterJson: { commit: report.commit }, reason: 'Ensaio DRY3 da migração iniciado.',
    }, transaction);
    return report;
  });
}

/** Abre e executa o ensaio inteiro (testes e linha de comando); a rota HTTP abre e deixa a execução para depois da resposta 202. */
async function executeDryRun(tenant, actor, options = {}) {
  const report = await openDryRun(tenant, actor, options);
  return runDryRun(tenant, actor, report.id, options);
}

/** GET /migration/dry-runs/:id/report (M9-D908 §3.3.3): o relatório do ensaio, sem dado pessoal em claro (os exemplos já saem mascarados). */
async function getReport(tenant, id, transaction) {
  if (!UUID.test(String(id || ''))) throw errors.notFound();
  const row = await repo.get(tenant, id, transaction);
  if (!row) throw errors.notFound();
  return { ...row, durationMs: row.finishedAt ? new Date(row.finishedAt) - new Date(row.startedAt) : null };
}

module.exports = { openDryRun, executeDryRun, getReport };
