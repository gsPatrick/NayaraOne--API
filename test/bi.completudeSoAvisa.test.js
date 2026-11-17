'use strict';

// DI-BI2-2 (resposta de 16/11/2026, item 6 e 11 do plano da segunda leva) — severidade da completude POR VERIFICAÇÃO: `analytics.qualidade.completude_bloqueia.<código>`.
// Onde o livro não exige o campo (causa da não conformidade, M6:23 e M6:138-140; contrato da vistoria, M5:203-212 e M5:148) a falha acima do limite de bloqueio
// só AVISA por padrão; ligada, volta a bloquear, e só aquela verificação (o limite por campo é compartilhado e não é o que muda). As demais continuam bloqueando.
// Forma antiga: 100% das não conformidades sem causa davam CRITICAL e degradavam o indicador. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('./marco9/_helpers/biEnv');
const quality = require('../src/features/analytics/quality');
const clock = require('../src/features/analytics/metrics/clock');
const { completeness } = require('../src/features/analytics/quality/types/completeness');
const { DEFAULTS, QUALITY_SETTINGS_SCHEMA } = require('../src/features/analytics/quality/quality.settings');
const { COMPLETENESS_BLOCK_DEFAULTS, blockKey } = require('../src/features/analytics/quality/quality.checkSeverity');

const { src } = bi;
let env;
const scopeOf = (t) => ({ companyId: t.companyId, groupId: t.groupId });
const run = (t, model) => bi.inTx(t, { commit: true }, (tx) => quality.executeChecks({ readModel: model, scope: scopeOf(t), mode: 'EVENT' }, tx));
const by = async (t, model, code) => (await run(t, model)).find((r) => r.checkCode === code);
const NC = 'project_nonconf_cause_code_completeness';
const OCC = 'project_occurrences_cause_code_completeness';
const INSP = 'rental_insp_keys_contract_id_completeness';

before(async () => {
  env = await bi.setup();
  clock.setClock(() => new Date(bi.NOW.getTime() + 60000));
});
after(async () => {
  clock.resetClock();
  await env.admin.query('DELETE FROM construction.nonconformities WHERE company_id IN (:ids)', { replacements: { ids: [env.cX.companyId, env.cY.companyId] } });
  await bi.teardown(env);
});

test('DI-BI2-2 padrões: só as três verificações em que o livro não exige o campo ficam "só avisa"; chave booleana no dicionário', () => {
  assert.deepEqual(COMPLETENESS_BLOCK_DEFAULTS, { [NC]: false, [OCC]: false, [INSP]: false });
  for (const code of [NC, OCC, INSP]) {
    assert.equal(DEFAULTS[blockKey(code)], false);
    assert.deepEqual(QUALITY_SETTINGS_SCHEMA[blockKey(code)], { type: 'boolean' });
  }
});

test('DI-BI2-2 sem o parâmetro no contexto (montado à mão) a completude continua bloqueando acima do limite', async () => {
  const check = completeness({ code: NC, field: 'cause_code', measure: async () => ({ total: 10, nulls: 10 }) });
  const out = await check.run({ params: { nullPct: { cause_code: 1 }, blockNullPct: 5 } });
  assert.deepEqual([out.passed, out.severityKey, out.expected.blocks], [false, 'COMPLETENESS_BLOCK', true]);
});

test('DI-BI2-2 não conformidade sem causa (100%) só avisa nas duas verificações; vistoria sem contrato também; origem do lead continua bloqueando', async () => {
  const t = env.cX;
  const project = await src.project(env, t, { property: src.uuid() });
  await src.insert(env, 'construction.nonconformities', t, { project_id: project, description: 'Infiltração', severity: 'HIGH', status: 'OPEN' });
  await src.inspection(env, t, { contract: null });
  await src.opportunity(env, t, { owner: src.uuid(), source: null });

  for (const [model, code] of [['rm_project_nonconformities', NC], ['rm_project_occurrences', OCC], ['rm_rental_inspections_keys', INSP]]) {
    const r = await by(t, model, code);
    assert.deepEqual([r.status, r.severity, r.observed.pct, r.expected.blocks], ['FAILED', 'WARNING', 100, false], `${code}: antes CRITICAL (indicador degradado)`);
  }
  const lead = await by(t, 'rm_crm_lead_daily', 'crm_lead_daily_lead_source_completeness');
  assert.deepEqual([lead.status, lead.severity, lead.expected.blocks], ['FAILED', 'CRITICAL', true], 'verificação sem chave própria: bloqueia como sempre');
});

test('DI-BI2-2 ligada pelo administrador, só aquela verificação volta a bloquear (o campo é o mesmo nas duas)', async () => {
  const t = env.cX;
  await bi.setSetting(env, t, blockKey(NC), true);
  try {
    assert.equal((await by(t, 'rm_project_nonconformities', NC)).severity, 'CRITICAL');
    assert.equal((await by(t, 'rm_project_occurrences', OCC)).severity, 'WARNING', 'mesma origem e mesmo campo, outra verificação: continua só avisando');
    const out = await bi.inTx(t, { commit: true }, async (tx) => quality.checkRefresh({ readModel: 'rm_project_occurrences', scope: scopeOf(t), mode: 'EVENT' }, tx));
    assert.equal(out.results.find((r) => r.checkCode === OCC).severity, 'WARNING');
  } finally {
    await env.admin.query('DELETE FROM core.tenant_settings WHERE company_id = :c AND key = :k', { replacements: { c: t.companyId, k: blockKey(NC) } });
  }
});

test('DI-BI2-2 abaixo do limite do campo a verificação aprova, com ou sem o parâmetro', async () => {
  const t = env.cY;
  const project = await src.project(env, t, { property: src.uuid() });
  await src.insert(env, 'construction.nonconformities', t, { project_id: project, description: 'Com causa', severity: 'LOW', status: 'OPEN', cause_code: 'INFILTRACAO' });
  assert.equal((await by(t, 'rm_project_nonconformities', NC)).status, 'PASSED');
});
