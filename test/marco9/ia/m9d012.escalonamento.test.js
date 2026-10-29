'use strict';

// M9-D012 — escalonamento do pequeno para o avançado: uma vez só, por saída fora do schema ou confiança baixa, respeitando parâmetro e orçamento.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { novoRoteador, entrada, tenantCtx, LIVRE } = require('../_helpers/iaRouter');
const P = require('../_helpers/iaProviders');
const H = require('../_helpers/iaAvaliacao');

let tenantA;
before(async () => {
  ({ tenantA } = await prepararTenants());
  await H.carregarPessoas();
  await P.prepararAmbiente(tenantA);
});
after(async () => { await sequelize.close(); });

const input = (over = {}) => entrada({ taskType: 'classificar', budgetState: LIVRE, ...over });

test('m9d012_escalonamento_unico_por_baixa_confianca', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { router } = novoRoteador();
    const ctx = tenantCtx(tenantA);
    const pequeno = await router.decide(input(), ctx, tx);
    assert.equal(pequeno.path, 'SMALL_MODEL');
    // Confiança no limite (0,6) não escala; abaixo, escala.
    assert.equal(await router.escalate(pequeno, { schemaValid: true, confidence: 0.6 }, input(), ctx, tx), null);
    assert.equal(await router.escalate(pequeno, { schemaValid: true }, input(), ctx, tx), null, 'sem confiança informada e schema válido: não escala');
    const avancado = await router.escalate(pequeno, { schemaValid: true, confidence: 0.59 }, input(), ctx, tx);
    assert.equal(avancado.path, 'ADVANCED_MODEL');
    assert.equal(avancado.escalated, true);
    assert.equal(avancado.model, 'sandbox-advanced-1');
    // Uma vez só: a decisão já escalada não escala de novo, nem a partir do avançado.
    assert.equal(await router.escalate(avancado, { schemaValid: false, confidence: 0 }, input(), ctx, tx), null);
    assert.equal(await router.escalate({ ...pequeno, escalated: true }, { schemaValid: false }, input(), ctx, tx), null);
    // Saída fora do schema escala mesmo com confiança alta.
    assert.equal((await router.escalate(pequeno, { schemaValid: false, confidence: 0.99 }, input(), ctx, tx)).path, 'ADVANCED_MODEL');
  });
});

test('m9d012_escalonamento_respeita_parametros_e_orcamento', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { router } = novoRoteador();
    const ctx = tenantCtx(tenantA);
    const pequeno = await router.decide(input(), ctx, tx);
    // A confiança mínima é parâmetro da empresa.
    await P.ajustar(tenantA, 'ia.router.confianca_minima', 0.9, tx);
    assert.equal((await router.escalate(pequeno, { schemaValid: true, confidence: 0.8 }, input(), ctx, tx)).path, 'ADVANCED_MODEL');
    assert.equal(await router.escalate(pequeno, { schemaValid: true, confidence: 0.9 }, input(), ctx, tx), null);
    // Orçamento a partir de 90%: o avançado não é liberado para agente não crítico, então não escala.
    const degradado = { configured: true, state: 'DEGRADED', allowedPaths: ['RULE', 'CACHE', 'SMALL_MODEL', 'EMBEDDING'] };
    assert.equal(await router.escalate(pequeno, { schemaValid: false }, input({ budgetState: degradado }), ctx, tx), null);
    // O parâmetro desliga o escalonamento.
    await P.ajustar(tenantA, 'ia.router.escalonar_para_avancado', false, tx);
    assert.equal(await router.escalate(pequeno, { schemaValid: false }, input(), ctx, tx), null);
  });
});
