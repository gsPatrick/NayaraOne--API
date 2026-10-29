'use strict';

// M9-D007 — concorrência: duas decisões simultâneas (FOR UPDATE) e duas criações simultâneas da mesma sugestão (trava de dedup).
// Grava linhas COMMITADAS em conexões diferentes: roda só em banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const rec = require('../../../src/features/ai/recommendations');
const { sequelize, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiRuns');
const { dadosRec, dadosComAcao, eventosDe, comPerm, vincular } = require('../_helpers/iaRecomendacao');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

async function comoTenant(fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction });
    return fn(transaction);
  });
}

test('m9d007_decisoes_simultaneas_so_uma_vence', async () => {
  const nay = comPerm(ctxDe(tenantA), 'ai:use');
  const ana = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
  const beto = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
  const { recommendation } = await comoTenant((tx) => rec.createRecommendation(nay, dadosComAcao(), tx));
  const resultados = await Promise.allSettled([
    comoTenant((tx) => rec.acceptRecommendation(ana, recommendation.id, {}, tx)),
    comoTenant((tx) => rec.rejectRecommendation(beto, recommendation.id, { reason: 'não' }, tx)),
    comoTenant((tx) => rec.acceptRecommendation(beto, recommendation.id, {}, tx)),
  ]);
  const ok = resultados.filter((r) => r.status === 'fulfilled');
  const falhas = resultados.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'uma única decisão vale');
  assert.equal(falhas.length, 2);
  for (const f of falhas) assert.equal(f.reason.code, 'AI_RECOMMENDATION_STATE');
  const vencedora = ok[0].value.recommendation;
  const eventos = await comoTenant(async (tx) => [
    ...(await eventosDe('ai.recommendation.accepted', recommendation.id, tx)), ...(await eventosDe('ai.recommendation.rejected', recommendation.id, tx)),
  ]);
  assert.equal(eventos.length, 1, 'um único evento de decisão');
  assert.equal(eventos[0].event_type, vencedora.decision === 'ACCEPTED' ? 'ai.recommendation.accepted' : 'ai.recommendation.rejected');
});

test('m9d007_criacoes_simultaneas_da_mesma_sugestao_nao_duplicam', async () => {
  const nay = comPerm(ctxDe(tenantA), 'ai:use');
  await comoTenant((tx) => vincular(tenantA, tx, nay.userId));
  const dados = dadosRec();
  const resultados = await Promise.all([1, 2, 3, 4].map(() => comoTenant((tx) => rec.createRecommendation(nay, dados, tx))));
  assert.equal(resultados.filter((r) => !r.replayed).length, 1);
  assert.equal(new Set(resultados.map((r) => r.recommendation.id)).size, 1);
  const eventos = await comoTenant((tx) => eventosDe('ai.recommendation.created', resultados[0].recommendation.id, tx));
  assert.equal(eventos.length, 1);
});
