'use strict';

// M9-D019 — duas conexões aceitando a mesma proposta: a recomendação é travada (FOR UPDATE), a primeira executa uma única vez e a
// segunda recebe 200 replayed=true (mesmo decisor) ou 409 AI_RECOMMENDATION_STATE (outro usuário). Grava linhas COMMITADAS.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const approval = require('../../../src/features/ai/approval');
const { sequelize, ctxAprovador, contar, q, setParam } = require('../_helpers/iaAprovacao');
const { propor } = require('../_helpers/iaAprovacaoFluxo');

let tenantA;
const DISPOSABLE = process.env.DISPOSABLE_DB === '1';
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => {
  // o parâmetro foi COMMITADO: volta ao padrão Desligado para não vazar para os outros arquivos de teste
  await comoTenant((tx) => setParam(tenantA, tx, 'ia.financeira.permitir_proposta_pagamento', false));
  await sequelize.close();
});

function comoTenant(fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenantA.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenantA.companyId }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: tenantA.userId }, transaction });
    return fn(transaction);
  });
}

test('m9d019_execucao_idempotente_duas_conexoes', { skip: DISPOSABLE ? false : 'precisa do cluster descartável' }, async () => {
  const { c, id } = await comoTenant((tx) => propor(tenantA, tx));
  const ctx = ctxAprovador(tenantA, c.aprovador);
  const ctxOutro = ctxAprovador(tenantA, c.outro);
  const resultados = await Promise.allSettled([
    comoTenant((tx) => approval.approveRecommendation(ctx, id, {}, tx)),
    comoTenant((tx) => approval.approveRecommendation(ctx, id, {}, tx)),
    comoTenant((tx) => approval.approveRecommendation(ctx, id, {}, tx)),
    comoTenant((tx) => approval.approveRecommendation(ctxOutro, id, {}, tx)),
  ]);
  const ok = resultados.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const falhas = resultados.filter((r) => r.status === 'rejected').map((r) => r.reason);
  // Mesmo decisor: uma execução e as outras viram replay. Outro usuário: 409 (se chegou depois) ou 409 por perder a corrida.
  const executou = ok.filter((r) => r.replayed === false);
  assert.equal(executou.length, 1, 'uma única execução');
  assert.equal(executou[0].outcome, 'EXECUTED');
  assert.ok(ok.filter((r) => r.replayed === true).every((r) => r.outcome === 'EXECUTED'));
  for (const f of falhas) assert.equal(f.code, 'AI_RECOMMENDATION_STATE');
  assert.equal(ok.length + falhas.length, 4);
  const intencoes = await comoTenant((tx) => contar('finance.payment_intents', 'financial_entry_id = :e', { e: c.entry.id }, tx));
  const aceites = await comoTenant((tx) => q("SELECT 1 FROM integration.outbox_events WHERE event_type = 'ai.recommendation.accepted' AND aggregate_id = :i", { i: id }, tx));
  const [linha] = await comoTenant((tx) => q('SELECT status, outcome FROM ai.ai_recommendations WHERE id = :i', { i: id }, tx));
  assert.equal(intencoes, 1, 'uma intenção de pagamento');
  assert.equal(aceites.length, 1, 'um evento de aceite');
  assert.equal(linha.status, 'EXECUTED');
});
