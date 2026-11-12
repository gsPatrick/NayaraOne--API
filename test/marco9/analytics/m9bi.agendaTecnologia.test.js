'use strict';

// DI-BI-3 — os read models de Tecnologia e IA têm agenda própria (analyticsTechRefreshJob, a cada analytics.tec.recalculo_min, padrão 4) fora da agenda geral (padrão 15 min),
// para os indicadores técnicos (frescor de 5 minutos) não passarem a maior parte do tempo desatualizados; e tec.availability ganha a versão 2 (frescor de 5 minutos,
// não 1) pelo caminho da M9-D604 (versão nova, auditada, aceite PENDING), porque a v1 exigia recálculo a cada minuto e nenhum job recalcula a cada minuto.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d680Env');
const readModels = require('../../../src/features/analytics/read-models');
const { TECNOLOGIA_IA_MODELS } = require('../../../src/features/analytics/read-models/tecnologia-seguranca-ia.readmodel');
const { runAnalyticsTechRefreshJob, resetAnalyticsTechRefreshState } = require('../../../src/engines/jobs/analyticsTechRefreshJob');
const { DEFINITIONS } = require('../../../src/features/analytics/metrics/kpis/tecnologia/definitions');
const { publishMetric } = require('../../../src/features/analytics/metrics/registry.service');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { definicoesPorEmpresa, removerDefinicoesNovas } = require('../_helpers/analyticsResiduo');

let env;
let definicoesAntes; // o job recalcula TODAS as empresas e publica a definição vigente nas do seed também: o `after` apaga o que nasceu aqui fora de cX e cY
const JOB_BASE = new Date('2026-09-15T15:00:00Z');
const jobAt = (minutes) => new Date(JOB_BASE.getTime() + minutes * 60000);
const pass = (t, options) => kit.inTx(t, { commit: true }, async (tx) => readModels.refreshCompanyScheduled(
  { companyId: t.companyId, groupId: t.groupId }, await readModels.readRefreshParams(t, tx), tx, { now: kit.NOW, ...options }
));
const scheduledRuns = async (t, since) => // as passadas do job feitas exatamente naquele instante (o job grava a fonte no instante em que começou)
  (await env.admin.query(
  "SELECT read_model FROM analytics.read_model_refreshes WHERE company_id = :c AND \"trigger\" = 'SCHEDULE' AND source_snapshot_at = :since ORDER BY read_model",
  { replacements: { c: t.companyId, since } }
))[0].map((r) => r.read_model);

before(async () => {
  env = await kit.setup();
  definicoesAntes = await definicoesPorEmpresa(env.admin);
  await kit.hourlyProbes(env);
});
after(async () => {
  resetAnalyticsTechRefreshState();
  await removerDefinicoesNovas(env.admin, definicoesAntes, [env.cX.companyId, env.cY.companyId]);
  await kit.teardown(env);
});

test('m9bi agenda: os nove read models de Tecnologia e IA têm agenda própria e a agenda geral não os disputa', async () => {
  assert.equal(TECNOLOGIA_IA_MODELS.length, 9);
  for (const name of TECNOLOGIA_IA_MODELS) assert.equal(readModels.getReadModel(name).ownCadence, 'tech', name);
  const own = (await pass(env.cX, { cadence: 'tech' })).map((r) => r.readModel).sort();
  assert.deepEqual(own, [...TECNOLOGIA_IA_MODELS].sort(), 'a passada própria recalcula só os de Tecnologia e IA');
  const general = (await pass(env.cX, { skipOwnCadence: true })).map((r) => r.readModel);
  assert.equal(general.filter((m) => TECNOLOGIA_IA_MODELS.includes(m)).length, 0, 'a agenda geral do servidor deixa os de Tecnologia e IA para o job próprio');
  assert.ok(general.length > 0, 'e continua recalculando os demais');
});

// antes do teste do job: o job recalcula TODAS as empresas e publicaria a definição vigente na empresa Y
test('m9bi versão: tec.availability publicada na v1 (frescor de 1 minuto) ganha a v2 de 5 minutos, auditada e com aceite PENDING', async () => {
  const def = DEFINITIONS.find((d) => d.metricCode === 'tec.availability');
  assert.deepEqual([def.version, def.refreshPolicy.maxStalenessMinutes, def.qualityRule.maxStalenessMinutes], [2, 5, 5]);
  const ctx = { groupId: env.cY.groupId, companyId: env.cY.companyId, actorUserId: null, permissions: ['analytics:manage'] };
  await kit.inTx(env.cY, { commit: true }, async (tx) => {
    const { version: _v, changeReason: _r, ...fields } = def; // a v1 como estava publicada antes desta correção
    return publishMetric({
      ...fields, scopeLevel: 'COMPANY', filters: {}, version: 1, validFrom: '2026-01-01', formulaId: def.metricCode, ownerRole: 'Tecnologia (papel ti-gestor)',
      refreshPolicy: { mode: 'SCHEDULE', cron: '* * * * *', maxStalenessMinutes: 1 }, qualityRule: { ...def.qualityRule, maxStalenessMinutes: 1 },
    }, ctx, tx);
  });
  await kit.rebuild(env.cY);
  await kit.kpis(env.cY);
  const [versions] = await env.admin.query(
    `SELECT v.version, v.valid_from::text AS valid_from, v.valid_until::text AS valid_until, v.refresh_policy FROM analytics.metric_versions v JOIN analytics.metric_definitions d ON d.id = v.metric_id
      WHERE d.company_id = :c AND d.metric_code = 'tec.availability' ORDER BY v.version`, { replacements: { c: env.cY.companyId } }
  );
  assert.deepEqual(versions.map((v) => [v.version, v.valid_from, v.valid_until, v.refresh_policy.maxStalenessMinutes]), [[1, '2026-01-01', '2026-10-28', 1], [2, '2026-10-28', null, 5]]);
  const [[audit]] = await env.admin.query("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = :c AND action = 'analytics.metric.version_published'", { replacements: { c: env.cY.companyId } });
  assert.equal(audit.n, 1);
  const [[acceptance]] = await env.admin.query("SELECT status FROM analytics.metric_acceptance WHERE company_id = :c AND metric_code = 'tec.availability' AND metric_version = 2", { replacements: { c: env.cY.companyId } });
  assert.equal(acceptance.status, 'PENDING');
  const read = await kit.readKpi(env.cY, 'tec.availability');
  assert.deepEqual([read.version, read.freshness.maxStalenessMinutes], [2, 5]);
  await kit.kpis(env.cY);
  const [[again]] = await env.admin.query("SELECT count(*)::int AS n FROM analytics.metric_versions v JOIN analytics.metric_definitions d ON d.id = v.metric_id WHERE d.company_id = :c AND d.metric_code = 'tec.availability'", { replacements: { c: env.cY.companyId } });
  assert.equal(again.n, 2, 'a próxima passada não publica de novo');
});

// o job recalcula TODAS as empresas do banco: roda numa data fora da data-base dos outros testes (28/10), para não deixar snapshot de 28/10 em empresa alheia
test('m9bi agenda: o job próprio respeita analytics.tec.recalculo_min de cada empresa (padrão 4)', async () => {
  assert.deepEqual([SETTINGS_SCHEMA['analytics.tec.recalculo_min'].min, SETTINGS_SCHEMA['analytics.tec.recalculo_min'].max], [1, 60]);
  await kit.setSetting(env, env.cY, 'analytics.tec.recalculo_min', 10);
  resetAnalyticsTechRefreshState();
  kit.clock.setClock(jobAt(1));
  try {
    const first = await runAnalyticsTechRefreshJob();
    assert.equal(first.errors, 0);
    assert.equal((await scheduledRuns(env.cX, jobAt(1))).length, 9, 'primeira passada: recalcula');
    kit.clock.setClock(jobAt(3));
    await runAnalyticsTechRefreshJob();
    assert.equal((await scheduledRuns(env.cX, jobAt(3))).length, 0, '2 minutos depois: ainda não venceu o intervalo de 4');
    kit.clock.setClock(jobAt(6));
    await runAnalyticsTechRefreshJob();
    assert.equal((await scheduledRuns(env.cX, jobAt(6))).length, 9, '5 minutos depois: venceu');
    assert.equal((await scheduledRuns(env.cY, jobAt(6))).length, 0, 'a empresa com 10 minutos ainda não venceu');
  } finally {
    kit.clock.setClock(kit.NOW);
  }
});

test('m9bi versão: empresa nova já nasce com a definição vigente na v1 (nada a versionar)', async () => {
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
  const read = await kit.readKpi(env.cX, 'tec.availability');
  assert.deepEqual([read.version, read.freshness.maxStalenessMinutes], [1, 5]);
});
