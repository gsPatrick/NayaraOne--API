#!/usr/bin/env node
'use strict';

/**
 * M9-D699 — teste de carga do BI: dashboard pesado não degrada o OLTP, e o rebuild sob carga conclui reproduzindo o hash.
 *
 * Fases (Caderno §21, Guia §12 "load/rebuild"): (1) linha de base do fluxo operacional sem BI; (2) o mesmo fluxo com vários usuários abrindo os
 * painéis e alternando drill-down; (3) durante a fase 2, rebuild do FinanceHealthReadModel de uma empresa. Rodadas alternadas (base, BI, base,
 * BI) reduzem o efeito de deriva da máquina. Critérios em verdict.js: p95 de cada operação com BI <= linha de base x (1 + analytics.carga.
 * degradacao_max_pct/100), p95 de cada painel <= meta (dashboard_definitions.p95_target_ms, M9-D698), rebuild com o mesmo hash, nenhuma falha
 * inesperada. Sai com código 1 se algum critério falhar (reprova a etapa do pipeline) e imprime o painel ou a consulta responsável.
 *
 * SÓ em banco descartável (scripts/withDisposableDb.js ou o Postgres efêmero do CI). Uso:
 *   node scripts/withDisposableDb.js -- node scripts/analytics/loadTest.js [--scale light|full] [--seed 42] [--duration-sec 20] [--rounds 5]
 *        [--oltp-users 4] [--bi-users 8] [--think-ms 5] [--bi-think-ms 150] [--degradacao-max-pct N] [--tolerancia-absoluta-ms N] [--saturacao-max 0.85] [--exigir-latencia] [--latencia-observar] [--json relatorio.json] [--keep]
 */
const { fork } = require('node:child_process');
const path = require('node:path');
const { seedLoad, cleanupLoad, connect } = require('./seedLoad');
const { requireDisposable } = require('./load/seed.sizes');
const { runWindow, askChild } = require('./load/phases');
const { summarizeRaw, mergeRaw } = require('./load/stats');
const { evaluate } = require('./load/verdict');
const { buildReport, write, renderText } = require('./load/report');
const { mergeProbes, BI_APP_NAME } = require('./load/lockProbe');

const DEFAULTS = Object.freeze({ scale: 'light', seed: 42, durationMs: 20000, rounds: 5, oltpUsers: 4, biUsers: 8, thinkMs: 5, biThinkMs: 150, rebuildAtFraction: 0.3, requestTimeoutMs: 20000, lockSampleMs: 25, saturationMax: 0.85, strictLatency: false, latencyMode: 'gate' });

function parseArgs(argv) {
  const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const num = (n) => (arg(n) === undefined ? undefined : Number(arg(n)));
  return {
    scale: arg('--scale'), seed: arg('--seed'), durationMs: num('--duration-sec') === undefined ? undefined : num('--duration-sec') * 1000, rounds: num('--rounds'),
    oltpUsers: num('--oltp-users'), biUsers: num('--bi-users'), thinkMs: num('--think-ms'), biThinkMs: num('--bi-think-ms'), maxPct: num('--degradacao-max-pct'), floorMs: num('--tolerancia-absoluta-ms'), saturationMax: num('--saturacao-max'), strictLatency: argv.includes('--exigir-latencia') || undefined, latencyMode: argv.includes('--latencia-observar') ? 'report' : undefined, json: arg('--json'), keep: argv.includes('--keep'),
  };
}

async function tenantsFor(admin, companies) {
  const [[u]] = await admin.query("SELECT id FROM core.users ORDER BY (email = 'admin@nayaraone.dev') DESC, created_at LIMIT 1");
  return companies.map((c) => ({ groupId: c.groupId, companyId: c.companyId, userId: u.id }));
}

async function loadTargets(admin) {
  const [rows] = await admin.query(
    "SELECT dashboard_code, p95_target_ms, required_permission FROM analytics.dashboard_definitions WHERE status = 'PUBLISHED' AND company_id IS NULL AND group_id IS NULL ORDER BY dashboard_code"
  );
  const [metrics] = await admin.query("SELECT DISTINCT metric_code FROM analytics.metric_definitions WHERE status = 'PUBLISHED' ORDER BY metric_code");
  return {
    metrics: metrics.map((m) => m.metric_code), panels: rows.map((r) => r.dashboard_code), targets: Object.fromEntries(rows.map((r) => [r.dashboard_code, r.p95_target_ms])),
    permissions: [...new Set(['analytics:read', 'analytics:drilldown', ...rows.map((r) => r.required_permission).filter(Boolean)])],
  };
}

/** Preenche os read models de cada empresa pelo caminho da agenda (o mesmo do worker) antes de medir. */
async function warmReadModels(models, tenants) {
  const { inTenant } = require('./load/oltpOps');
  const readModels = models.readModels;
  for (const t of tenants) {
    await inTenant(models.sequelize, t, async (transaction) => {
      const params = await readModels.readRefreshParams(t, transaction);
      await readModels.refreshCompanyScheduled({ companyId: t.companyId, groupId: t.groupId }, params, transaction);
    });
  }
}

async function resolveLimit(models, tenant, override, floorOverride) {
  const { inTenant } = require('./load/oltpOps');
  const { readDegradationMaxPct, readToleranceFloorMs } = require('../../src/features/analytics/loadTest.settings');
  const floorMs = floorOverride !== undefined ? floorOverride : await inTenant(models.sequelize, tenant, (transaction) => readToleranceFloorMs(tenant, transaction));
  if (override !== undefined) return { maxPct: override, floorMs, source: 'argumento --degradacao-max-pct' };
  const maxPct = await inTenant(models.sequelize, tenant, (transaction) => readDegradationMaxPct(tenant, transaction));
  return { maxPct, floorMs, source: 'parâmetros analytics.carga.degradacao_max_pct e analytics.carga.tolerancia_absoluta_ms' };
}

function unexpectedCount(...summaries) {
  return summaries.reduce((n, s) => n + Object.values(s).reduce((m, v) => m + v.errors, 0), 0);
}

async function execute(opts, admin, massa, models) {
  const tenants = await tenantsFor(admin, massa.companies);
  const [rebuildTenant, ...oltpTenants] = tenants;
  const { panels, targets, permissions } = await loadTargets(admin);
  let metrics = [];
  const limit = await resolveLimit(models, rebuildTenant, opts.maxPct, opts.floorMs);
  await warmReadModels(models, tenants);
  metrics = (await loadTargets(admin)).metrics; // os KPIs financeiros são publicados no primeiro refresh
  const asOf = require('../../src/features/analytics/metrics/clock').businessToday();
  const biConfig = { tenants, permissions, panels, metrics, asOf, requestTimeoutMs: opts.requestTimeoutMs, users: opts.biUsers, thinkMs: opts.biThinkMs, durationMs: opts.durationMs };
  const child = fork(path.join(__dirname, 'load', 'biWorker.js'), { env: { ...process.env, PGAPPNAME: BI_APP_NAME } }) // a sessão do BI se identifica no banco (sonda de bloqueios);
  try {
    await askChild(child, { cmd: 'start', config: biConfig }, 'ready');
    const ctx = {
      sequelize: models.sequelize, admin, lockSampleMs: opts.lockSampleMs, seed: massa.sizes.seed, sizes: massa.sizes, rndSeed: Number(massa.sizes.seed) || 1, oltpTenants, thinkMs: opts.thinkMs, child, biConfig,
      rebuild: async () => {
        const r = await models.readModels.rebuildReadModel({ groupId: rebuildTenant.groupId, actorUserId: rebuildTenant.userId, permissions: ['analytics:rebuild'], reason: 'Teste de carga do BI (M9-D699)' },
          { model: 'rm_finance_health', companyId: rebuildTenant.companyId });
        return { hashBefore: r.before.hash, hashAfter: r.after.hash, rowsBefore: r.before.rows, rowsAfter: r.after.rows, changed: r.changed, snapshotsRevised: r.snapshotsRevised };
      },
    };
    await runWindow(ctx, { durationMs: Math.min(3000, opts.durationMs), oltpUsers: opts.oltpUsers, withBi: true, rebuildAtMs: 0, noRebuild: true }); // aquecimento, descartado
    const cpuBusy = [];
    const base = []; const withBi = []; const biRaw = []; const rebuilds = []; const probes = [];
    for (let round = 0; round < opts.rounds; round += 1) {
      const a = await runWindow(ctx, { durationMs: opts.durationMs, oltpUsers: opts.oltpUsers, withBi: false });
      const b = await runWindow(ctx, { durationMs: opts.durationMs, oltpUsers: opts.oltpUsers, withBi: true, rebuildAtMs: Math.round(opts.durationMs * opts.rebuildAtFraction), windowIndex: round, windowCount: opts.rounds });
      cpuBusy.push(a.cpuBusy, b.cpuBusy);
      base.push(a.oltp); withBi.push(b.oltp); biRaw.push(b.bi); if (b.rebuild) rebuilds.push(b.rebuild);
      if (b.locks) probes.push(b.locks);
    }
    return { base: mergeRaw(base), withBi: mergeRaw(withBi), roundsRaw: base.map((b, i) => ({ base: b, withBi: withBi[i] })), biRaw: mergeRaw(biRaw), rebuilds, locks: mergeProbes(probes), host: { cpuBusyMax: Math.max(...cpuBusy), saturationMax: opts.saturationMax, strict: opts.strictLatency }, latencyMode: opts.latencyMode, panels, targets, limit };
  } finally {
    child.send({ cmd: 'stop' });
  }
}

function consolidate(run) {
  const baseline = summarizeRaw(run.base);
  const withBi = summarizeRaw(run.withBi);
  const bi = summarizeRaw(run.biRaw);
  const panelSummary = Object.fromEntries(Object.entries(bi).filter(([k]) => k.startsWith('panel:')).map(([k, v]) => [k.slice(6), v]));
  const other = Object.fromEntries(Object.entries(bi).filter(([k]) => !k.startsWith('panel:')));
  const failedRebuild = run.rebuilds.find((r) => !r.completed || r.hashBefore !== r.hashAfter);
  const rebuild = failedRebuild || run.rebuilds[0] || { completed: false, error: 'o rebuild não rodou' };
  const unexpected = unexpectedCount(baseline, withBi, panelSummary, Object.fromEntries(Object.entries(other).filter(([k]) => k.startsWith('falha:'))));
  const verdict = evaluate({ baseline, withBi, panels: panelSummary, targets: run.targets, rebuild: { ...rebuild, count: run.rebuilds.length }, maxPct: run.limit.maxPct, floorMs: run.limit.floorMs, rounds: run.roundsRaw.map((r) => ({ baseline: summarizeRaw(r.base), withBi: summarizeRaw(r.withBi) })), unexpected, locks: run.locks, host: run.host, latencyMode: run.latencyMode });
  return { baseline, withBi, panelSummary, other, verdict };
}

/** Roda a carga inteira e devolve { report, text, pass }. Chamada pelo CLI e pelo teste automatizado. */
async function runLoadTest(input = {}) {
  const opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  requireDisposable(adminUrl);
  const admin = connect(adminUrl);
  const models = { sequelize: require('../../src/models').sequelize, readModels: null };
  const startedAt = new Date().toISOString();
  let massa = null;
  try {
    require('../../src/features/analytics');
    models.readModels = require('../../src/features/analytics/read-models');
    massa = await seedLoad(admin, { seed: opts.seed, scale: opts.scale, anchor: opts.anchor, groupId: opts.groupId });
    const run = await execute({ ...opts, anchor: massa.anchor }, admin, massa, models);
    const done = consolidate(run);
    const report = buildReport({
      options: { ...opts, anchor: massa.anchor }, seed: massa.sizes.seed, verdict: done.verdict, baseline: done.baseline, withBi: done.withBi, panels: done.panelSummary,
      extra: { massa: { rows: massa.rows, digest: massa.digest, companies: massa.companies.length, months: massa.sizes.months }, other: { ...done.other, rebuilds: run.rebuilds, locks: run.locks, limitSource: run.limit.source } },
      startedAt, finishedAt: new Date().toISOString(),
    });
    write(report, opts.json);
    return { report, text: renderText(report), pass: done.verdict.pass };
  } finally {
    if (massa && !opts.keep) await cleanupLoad(admin, massa.companies).catch((e) => console.error(`loadTest: limpeza falhou: ${e.message}`));
    await admin.close();
    if (opts.closeModels !== false) await models.sequelize.close(); // o teste automatizado reutiliza a conexão do processo
  }
}

if (require.main === module) {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'fatal'; // o relatório é a saída; os logs da aplicação não entram nela
  runLoadTest(parseArgs(process.argv.slice(2)))
    .then((r) => { console.log(r.text); process.exitCode = r.pass ? 0 : 1; })
    .catch((err) => { console.error(`loadTest: ${err.message}`); process.exitCode = 2; });
}

module.exports = { runLoadTest, parseArgs, resolveLimit, DEFAULTS };
