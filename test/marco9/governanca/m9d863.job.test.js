'use strict';

// M9-D863 — finopsDegradationJob (minuto configurado, uma vez por hora), o gancho dos jobs de baixa prioridade e os parâmetros do administrador (banco descartável).

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d863Env');
const state = require('../../../src/features/core-governance/finops/degradation/state');
const { isDue, minuteInSaoPaulo, runDegradationJob } = require('../../../src/engines/jobs/finopsDegradationJob');
const { runForEachCompany } = require('../../../src/engines/jobs/calendarJobRunner');
const { readDegradationParams } = require('../../../src/features/core-governance/finops/degradation/degradation.params');
const { KEYS, DEGRADATION_SETTING_DEFAULTS, DEGRADATION_SETTINGS_SCHEMA } = require('../../../src/features/core-governance/finops/degradation/degradation.settings');
const { FINOPS_SETTINGS_SCHEMA } = require('../../../src/features/core-governance/finops/finops.settings');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);

test('m9d863 o job roda no minuto 20 de cada hora, uma vez por hora', () => {
  const tenant = { companyId: 'empresa-qa-863' };
  const params = { jobMinute: 20 };
  const at = (iso) => new Date(iso); // 15:20Z = 12:20 em Brasília
  assert.equal(minuteInSaoPaulo(at('2026-10-30T15:20:30Z')), 20);
  assert.equal(isDue(tenant, params, at('2026-10-30T15:19:59Z'), false), false);
  assert.equal(isDue(tenant, params, at('2026-10-30T15:20:10Z'), false), true);
  assert.equal(isDue(tenant, { jobMinute: 45 }, at('2026-10-30T15:20:10Z'), false), false, 'o minuto vem do parâmetro');
  assert.equal(isDue(tenant, params, at('2026-10-30T15:20:10Z'), true), true, 'force ignora o horário');
});

test('m9d863 job de baixa prioridade é adiado pelo passo e os demais não', { skip: skip() }, async () => {
  const defer = mock.method(state, 'shouldDeferJob', async (name) => name === 'dataQualityScanJob');
  try {
    const ran = [];
    const deferred = await runForEachCompany('dataQualityScanJob', async (tenant) => { ran.push(tenant.companyId); return { ok: true }; }, 'finops');
    assert.equal(ran.length, 0, 'adiado: o trabalho não rodou');
    assert.equal(deferred.ran, 0);
    const normal = await runForEachCompany('outroJob', async (tenant) => { ran.push(tenant.companyId); return { ok: true }; }, 'finops');
    assert.ok(ran.length > 0 && normal.ran === ran.length, 'job fora da lista roda normalmente');
    assert.ok(defer.mock.callCount() >= 2);
  } finally { defer.mock.restore(); }
});

test('m9d863 o job percorre as empresas sem aplicar nada quando não há política', { skip: skip() }, async () => {
  const result = await runDegradationJob(new Date(), { force: true });
  assert.equal(result.errors, 0);
  assert.ok(result.summaries.every((s) => s.applied.length === 0));
});

test('m9d863 os parâmetros do administrador valem: percentual de exportação, janela, lista de jobs, limiares e nível de log', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const put = (key, value) => upsertSetting(key, value, A, A.userId, tx);
    assert.deepEqual(Object.keys(DEGRADATION_SETTINGS_SCHEMA).sort(), Object.keys(DEGRADATION_SETTING_DEFAULTS).sort(), 'todo parâmetro tem padrão e esquema');
    assert.ok(Object.keys(DEGRADATION_SETTINGS_SCHEMA).every((k) => k in FINOPS_SETTINGS_SCHEMA), 'e entra no dicionário do administrador');
    const defaults = await readDegradationParams(A, tx);
    assert.deepEqual([defaults.firstThreshold, defaults.otherThreshold, defaults.jobMinute, defaults.logLevel, defaults.exportPercent, defaults.windowStart, defaults.windowEnd], [90, 100, 20, 'warn', 50, 0, 5]);
    await put(KEYS.exportPercent, 25);
    await put(KEYS.logLevel, 'error');
    await put(KEYS.lowPriorityJobs, 'qaJob, outroQaJob');
    await put(KEYS.windowStart, 22);
    await put(KEYS.windowEnd, 24);
    await put(KEYS.firstThreshold, 75);
    const p = await readDegradationParams(A, tx);
    assert.deepEqual([p.exportPercent, p.logLevel, p.lowPriorityJobs, p.windowStart, p.windowEnd, p.firstThreshold], [25, 'error', ['qaJob', 'outroQaJob'], 22, 24, 75]);
    const budget = await env.mkBudget(A, tx);
    const saved = await env.putPolicy(A, tx, { budgetId: budget.id, steps: [{ step: 'LIMIT_EXPORT_SIZE' }, { step: 'DEFER_NON_CRITICAL_JOBS' }] });
    assert.equal(saved.steps[0].threshold, 75, 'o limiar padrão do 1º passo vem do parâmetro');
    await env.spend(A, tx, 240000); // 80%
    await env.degrade(A, tx);
    assert.equal(await state.effectiveMaxRows(1000, A, tx), 250, 'LIMIT_EXPORT_SIZE usa o percentual configurado');
    await put(KEYS.enabled, false);
    assert.equal((await env.degrade(A, tx)).reverted.length, 1, 'desligar a degradação desfaz o que estava aplicado');
    assert.equal(await state.effectiveMaxRows(1000, A, tx), 1000);
  });
});
