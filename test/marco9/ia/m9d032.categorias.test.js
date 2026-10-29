'use strict';

// M9-D032 — as sete categorias da avaliação (livro §13) medidas com o provider sandbox, limiares configuráveis e execução de
// verdade (itens, métricas, estado final). Roda com nayara_runtime em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { AiEvaluationService, registerCaseSource, registerEvalProvider } = require('../../../src/features/ai/evaluations');
const { SUITE_CATEGORIES } = require('../../../src/features/ai/evaluations/evaluations.constants');
const { sandboxGenerate } = require('../../../src/features/ai/providers/sandbox/sandboxGenerate');
const H = require('../_helpers/iaAvaliacao');

const svc = new AiEvaluationService();
let tenantA;
before(async () => { ({ tenantA } = await H.prepararTenants()); await H.carregarPessoas(); });
after(async () => { await H.sequelize.close(); });

const gestor = () => ({ ...H.ctxDe(tenantA), permissions: ['ai:evaluate'] });

test('m9d032_sete_categorias_medidas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = gestor();
    const { code } = await H.criarAgente(tenantA, tx);
    const ev = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'all' });
    assert.equal(ev.status, 'PASSED', JSON.stringify(ev.metrics));
    assert.equal(ev.suite, 'ALL');
    assert.deepEqual(Object.keys(ev.metrics).filter((k) => SUITE_CATEGORIES.ALL.includes(k)).sort(), [...SUITE_CATEGORIES.ALL].sort());
    const porCategoria = new Map();
    for (const i of ev.items) porCategoria.set(i.category, (porCategoria.get(i.category) || 0) + 1);
    for (const c of ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'INJECTION']) assert.ok(porCategoria.get(c) >= 1, `sem itens de ${c}`);
    assert.equal(ev.metrics.GROUNDING.pct, '100.00');
    assert.equal(ev.metrics.GROUNDING.thresholdPct, '100.00');
    assert.equal(ev.metrics.TOOL_SELECTION.thresholdPct, '95.00');
    assert.equal(ev.metrics.INJECTION.thresholdPct, '100.00');
    assert.ok(ev.metrics.COST.measured > 0 && ev.metrics.COST.ok);
    assert.ok(ev.metrics.LATENCY.measured > 0 && ev.metrics.LATENCY.p95Ms <= ev.metrics.LATENCY.budgetMs);
    assert.equal(ev.totals.failed, 0);
    assert.ok(ev.startedAt && ev.finishedAt);
    assert.equal(ev.homologatedBy, null, 'passar não homologa');
    // a suíte de ouro não mede injeção; a adversarial não mede grounding
    const ouro = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'golden' });
    assert.ok(!('INJECTION' in ouro.metrics) && 'GROUNDING' in ouro.metrics);
    const adv = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'adversarial' });
    assert.ok('INJECTION' in adv.metrics && !('GROUNDING' in adv.metrics));
  });
});

test('m9d032_categoria_falha_reprova_e_agente_sem_tool_nao_mede_tool', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = gestor();
    const { code } = await H.criarAgente(tenantA, tx, { tools: [] });
    const ev = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'all' });
    assert.equal(ev.status, 'PASSED', JSON.stringify(ev.metrics));
    assert.deepEqual(ev.metrics.notApplicable, ['TOOL_SELECTION', 'PERMISSIONS']);
    // caso de HALLUCINATION que reprova: a fonte sustenta o dado, então a resposta NÃO é insuficiência
    const sai = registerCaseSource(() => [{ id: 'HALLUCINATION:ruim', category: 'HALLUCINATION', suite: 'GOLDEN', input: '[[ECO]] O saldo é R$ 10,00 [1].', sources: [{ sourceType: 'READ_MODEL', title: 'Saldo', excerpt: 'Saldo R$ 10,00.', relevanceScore: 1 }] }]);
    try {
      const reprovada = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'golden' });
      assert.equal(reprovada.status, 'FAILED');
      assert.deepEqual(reprovada.totals.failedCategories, ['HALLUCINATION']);
      assert.equal(reprovada.items.find((i) => i.caseId === 'HALLUCINATION:ruim').passed, false);
    } finally { sai(); }
  });
});

test('m9d032_usa_sandbox_por_padrao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = gestor();
    const { code } = await H.criarAgente(tenantA, tx);
    const ev = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'golden' });
    assert.equal(ev.providerCode, 'ai-sandbox');
    assert.equal(ev.modelCode, 'sandbox-1');
    // sem rede: o provider chamado é a função determinística local; mesma entrada, mesma saída
    const a = sandboxGenerate({ system: 's', messages: [{ role: 'user', content: 'oi' }] });
    assert.deepEqual(a, sandboxGenerate({ system: 's', messages: [{ role: 'user', content: 'oi' }] }));
    // provider real só com o parâmetro ligado e registrado
    await H.rejeita(svc.request(ctx, { agentCode: code, suite: 'golden', providerCode: 'anbtech' }, tx), 409, 'AI_REAL_PROVIDER_EVAL_DISABLED');
    await H.ajustar('ia.avaliacao.permitir_provider_real', true, ctx, tx);
    await H.rejeita(svc.request(ctx, { agentCode: code, suite: 'golden', providerCode: 'anbtech' }, tx), 404, 'AI_PROVIDER_NOT_FOUND');
    registerEvalProvider('anbtech', (e) => ({ ...sandboxGenerate(e), providerCode: 'anbtech', modelCode: 'm-real' }));
    const real = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'golden', providerCode: 'anbtech' });
    assert.equal(real.providerCode, 'anbtech'); assert.equal(real.modelCode, 'm-real');
  });
});

test('m9d032_limiares_configuraveis', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = gestor();
    const { code } = await H.criarAgente(tenantA, tx, { tools: [] });
    // 40 casos de grounding (2 de base + 38 do lote): 39 corretos e 1 sem fonte -> 97,50% < 100% (exemplo do livro)
    const fonte = { sourceType: 'READ_MODEL', title: 'Saldo', excerpt: 'Saldo R$ 10,00.', relevanceScore: 1 };
    const lote = Array.from({ length: 38 }, (_, i) => ({
      id: `GROUNDING:lote-${i}`, category: 'GROUNDING', suite: 'GOLDEN', input: '[[ECO]] O saldo é R$ 10,00 [1].', sources: i === 0 ? [] : [fonte],
    }));
    const sai = registerCaseSource(() => lote);
    try {
      const falha = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'golden' });
      assert.equal(falha.status, 'FAILED');
      assert.equal(falha.metrics.GROUNDING.pct, '97.50');
      assert.equal(falha.metrics.GROUNDING.ok, false);
      // o administrador baixa o mínimo para 97: a mesma bateria passa (parâmetro lido, não valor fixo)
      await H.ajustar('ia.avaliacao.grounding_min', 97, ctx, tx);
      const passa = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'golden' });
      assert.equal(passa.metrics.GROUNDING.thresholdPct, '97.00');
      assert.equal(passa.metrics.GROUNDING.ok, true);
      assert.equal(passa.status, 'PASSED');
      // teto de custo: abaixo do custo médio reprova COST
      await H.ajustar('ia.avaliacao.custo_max_por_caso', 0.000001, ctx, tx);
      const caro = await H.avaliar(svc, ctx, tx, { agentCode: code, suite: 'golden' });
      assert.equal(caro.metrics.COST.ok, false);
      assert.ok(caro.totals.failedCategories.includes('COST'));
    } finally { sai(); }
    // tool_selection_min configurável: 0 aceita qualquer taxa
    await H.ajustar('ia.avaliacao.tool_selection_min', 80, ctx, tx);
    const { code: comTool } = await H.criarAgente(tenantA, tx);
    const ev = await H.avaliar(svc, ctx, tx, { agentCode: comTool, suite: 'golden' });
    assert.equal(ev.metrics.TOOL_SELECTION.thresholdPct, '80.00');
  });
});
