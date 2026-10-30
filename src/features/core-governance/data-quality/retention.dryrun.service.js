'use strict';

const { getSetting } = require('../../settings/settings.service');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const policyService = require('./retention.policy.service');
const runRepository = require('./retention.run.repository');
const { analyzePolicy, emptyCounts } = require('./retention.dryrun.analyze');
const { KEYS, RETENTION_SETTING_DEFAULTS } = require('./retention.settings');
const { todayInZone } = require('./retention.calendar');
const errors = require('./retention.errors');

const read = (tenant, tx, key) => getSetting(key, tenant, tx, RETENTION_SETTING_DEFAULTS[key]);
const sumTotals = (policies) => policies.reduce((sum, p) => Object.fromEntries(Object.keys(sum).map((key) => [key, sum[key] + p[key]])), emptyCounts());

/**
 * Simulação (M9-D911 §3.3.2): NÃO altera nenhum dado de negócio. Grava a rodada (governance.retention_runs, DRY_DONE) com o relatório por política (elegíveis, bloqueados por
 * hold e por exceção, o que seria apagado, anonimizado, arquivado ou vai para revisão, amostra de chaves) e o conjunto exato a descartar (retention_run_items).
 * `policyCodes` limita as políticas (o job automático só simula as de aplicação automática).
 */
async function runDryRun(tenant, actor, { policyCodes = null, source = 'API', now = new Date() } = {}, transaction) {
  const all = await policyService.ensurePolicies(tenant, transaction);
  const wanted = policyCodes ? [...new Set(policyCodes.map((code) => String(code).trim().toUpperCase()))] : null;
  if (wanted && wanted.some((code) => !all.some((policy) => policy.code === code))) throw errors.validation('Política desconhecida.', { policyCodes: wanted });
  const selected = wanted ? all.filter((policy) => wanted.includes(policy.code)) : all;
  const [batchSize, sampleSize] = [await read(tenant, transaction, KEYS.LOTE), await read(tenant, transaction, KEYS.AMOSTRA)];
  const today = todayInZone(now);
  const run = await runRepository.createRun(tenant, { source, referenceDate: today, batchSize, policyCodes: selected.map((policy) => policy.code) }, actor.userId, transaction);
  const ctx = { tenant, today, batchSize, sampleSize, runId: run.id, transaction };
  const policies = [];
  for (const policy of selected) policies.push(await analyzePolicy(ctx, policy));
  const report = { referenceDate: today, generatedAt: now.toISOString(), policies, totals: sumTotals(policies) };
  await runRepository.saveReport(run.id, report, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId, action: 'governance.retention.dry_run', entityType: 'RetentionRun', entityId: run.id,
    beforeJson: null, afterJson: { source, policies: selected.map((policy) => policy.code), totals: report.totals }, reason: 'Simulação de retenção gerada; nenhum dado foi alterado.',
  }, transaction);
  return { ...run, report };
}

module.exports = { runDryRun };
