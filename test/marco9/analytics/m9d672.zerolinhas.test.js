'use strict';

// M9-D672 (reabertura M-3) — mês aberto no read model sem avaliação/resposta/reclamação (linha com zero) é válido e não degrada o KPI do mês seguinte; relógio fixo em 28/10/2026.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d672Env');
const sc = require('../_helpers/m9d672Scenario');
const src = require('../_helpers/m9d627Sources');

let env;
before(async () => {
  env = await kit.setup();
  await sc.avaliacoes(env, env.cX);
  await sc.reclamacoes(env, env.cX);
  await src.review(env, env.cX, { status: 'PENDING', at: '2026-08-12T15:00:00Z' }); // agosto: pedido sem retorno abre o mês com zero avaliação e zero resposta
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

const quality = require('../../../src/features/analytics/quality');

const zeroRows = async (model, column) => {
  const [rows] = await env.admin.query(`SELECT month FROM analytics.${model} WHERE company_id = :c AND ${column} = 0`, { replacements: { c: env.cX.companyId } });
  return rows;
};
const check = (t, model, code) => require('../_helpers/biObrasJuridicoEnv').inTx(t, { commit: true }, (tx) => quality.executeChecks({ readModel: model, scope: { companyId: t.companyId, groupId: t.groupId }, mode: 'EVENT' }, tx)).then((r) => r.find((x) => x.checkCode === code));

test('m9d672 linha de mês sem avaliação, resposta ou reclamação (zero) existe no read model e a invariante aprova', async () => {
  assert.ok((await zeroRows('rm_mkt_reviews', 'reviews')).length >= 1, 'o cenário precisa ter ao menos um mês aberto com zero avaliação');
  assert.ok((await zeroRows('rm_support_satisfaction', 'responses')).length >= 1, 'e um mês com zero resposta');
  for (const [model, code] of [['rm_mkt_reviews', 'mkt_reviews_invariant'], ['rm_support_satisfaction', 'support_satisfaction_invariant'], ['rm_support_complaints', 'support_complaints_invariant']]) {
    assert.equal((await check(env.cX, model, code)).status, 'PASSED', code);
  }
});

test('m9d672 sup.reviews e sup.satisfaction saem OK com valor mesmo havendo mês com zero linha', async () => {
  for (const code of ['sup.reviews', 'sup.satisfaction']) {
    const kpi = await kit.readKpi(env.cX, code);
    assert.deepEqual([kpi.status, kpi.valueReliable], ['OK', true], `${code} ${JSON.stringify(kpi.quality)}`);
    assert.notEqual(kpi.value, null);
  }
});

test('m9d672 a invariante reprova linha incoerente (contagem por nota que não fecha, nota 4 ou 5 acima das respostas)', async () => {
  await env.admin.query('UPDATE analytics.rm_mkt_reviews SET rating_5 = rating_5 + 1 WHERE company_id = :c AND reviews > 0', { replacements: { c: env.cX.companyId } });
  assert.equal((await check(env.cX, 'rm_mkt_reviews', 'mkt_reviews_invariant')).status, 'FAILED');
  await env.admin.query('UPDATE analytics.rm_mkt_reviews SET rating_5 = rating_5 - 1 WHERE company_id = :c AND reviews > 0', { replacements: { c: env.cX.companyId } });
  await env.admin.query('UPDATE analytics.rm_support_satisfaction SET positive = responses + 1 WHERE company_id = :c AND responses > 0', { replacements: { c: env.cX.companyId } });
  assert.equal((await check(env.cX, 'rm_support_satisfaction', 'support_satisfaction_invariant')).status, 'FAILED');
});
