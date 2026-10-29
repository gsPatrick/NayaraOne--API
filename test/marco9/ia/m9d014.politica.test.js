'use strict';

// M9-D014 — política de degradação por orçamento (tabela do livro): agente NON_CRITICAL e CRITICAL em 90% e 100%.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, carregarPessoas, run } = require('../../helpers/aiRuns');
const { inserirAgente, levarPara } = require('../../helpers/aiAgents');
const budgets = require('../../../src/features/ai/budgets');
const {
  AGORA, agente, criarOrcamento, gastar, lerOrcamento, definirParametro, rejeita,
} = require('../_helpers/iaOrcamento');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const tenta = (tx, agentCode, routingPath, extra = {}) => gastar(tenantA, tx, { agentCode, routingPath, pedido: '[[CUSTO:1]]', ...extra });

test('m9d014_orcamento_90_bloqueia_avancado_nao_critico', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    await criarOrcamento(tenantA, tx, { agentCode, limit: '200.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:179]]' }); // 89,5%: ainda normal
    const normal = await tenta(tx, agentCode, 'ADVANCED_MODEL');
    assert.equal(normal.reservation.state, 'NORMAL');
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:1]]' }); // 181/200 = 90,5%
    const err = await rejeita(tenta(tx, agentCode, 'ADVANCED_MODEL'), 429, 'AI_BUDGET_EXHAUSTED');
    assert.equal(err.details.state, 'DEGRADED');
    for (const path of ['SMALL_MODEL', 'EMBEDDING', 'RULE', 'CACHE']) assert.ok(await tenta(tx, agentCode, path), path);
    // O agente CRITICAL segue normal até 100%.
    assert.equal((await tenta(tx, agentCode, 'ADVANCED_MODEL', { criticality: 'CRITICAL' })).reservation.state, 'NORMAL');
  });
});

test('adv_budget_estoura_politica_de_degradacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const bloqueia = agente();
    await criarOrcamento(tenantA, tx, { agentCode: bloqueia, limit: '200.00' });
    await gastar(tenantA, tx, { agentCode: bloqueia, pedido: '[[CUSTO:200]]' }); // 100%
    // BLOCK (padrão): não crítico recebe 429 em qualquer caminho pago e no cache; a regra determinística (custo zero) segue.
    for (const path of ['SMALL_MODEL', 'ADVANCED_MODEL', 'EMBEDDING', 'CACHE']) await rejeita(tenta(tx, bloqueia, path), 429, 'AI_BUDGET_EXHAUSTED');
    assert.ok(await tenta(tx, bloqueia, 'RULE'));
    // DEGRADE: só RULE e CACHE.
    const degrada = agente();
    await criarOrcamento(tenantA, tx, { agentCode: degrada, limit: '200.00', actionAt100: 'DEGRADE' });
    await gastar(tenantA, tx, { agentCode: degrada, pedido: '[[CUSTO:200]]' });
    assert.ok(await tenta(tx, degrada, 'RULE')); assert.ok(await tenta(tx, degrada, 'CACHE'));
    for (const path of ['SMALL_MODEL', 'ADVANCED_MODEL', 'EMBEDDING']) await rejeita(tenta(tx, degrada, path), 429, 'AI_BUDGET_EXHAUSTED');
    // A ação vem do parâmetro quando a linha não define: com DEGRADE na empresa, a linha sem ação degrada.
    await definirParametro(tenantA, 'ia.orcamento.acao_ao_100', 'DEGRADE', tx);
    const seguePar = agente();
    await criarOrcamento(tenantA, tx, { agentCode: seguePar, limit: '10.00' });
    await gastar(tenantA, tx, { agentCode: seguePar, pedido: '[[CUSTO:10]]' });
    assert.ok(await tenta(tx, seguePar, 'CACHE'));
  });
});

test('m9d014_critico_segue_com_modelo_pequeno_no_100', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '100.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:100]]' });
    for (const path of ['CACHE', 'SMALL_MODEL', 'EMBEDDING']) {
      const r = await tenta(tx, agentCode, path, { criticality: 'CRITICAL' });
      assert.equal(r.reservation.state, 'EXHAUSTED', path);
    }
    // A reserva e o consumo do crítico acima de 100% são registrados do mesmo jeito.
    const linha = await lerOrcamento(b.id, tx);
    assert.equal(Number(linha.consumed_amount), 102);
    assert.equal(Number(linha.reserved_amount), 0);
  });
});

test('m9d014_critico_com_tarefa_avancada_no_100_falha_fechada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '100.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:100]]' });
    const err = await rejeita(tenta(tx, agentCode, 'ADVANCED_MODEL', { criticality: 'CRITICAL' }), 429, 'AI_BUDGET_EXHAUSTED');
    assert.equal(err.details.state, 'EXHAUSTED');
    assert.equal(Number((await lerOrcamento(b.id, tx)).consumed_amount), 100, 'nada foi gasto');
    // Sem teto de 120% nem exceção de piso: o pequeno do crítico continua passando bem acima de 100%.
    for (let i = 0; i < 3; i += 1) await tenta(tx, agentCode, 'SMALL_MODEL', { criticality: 'CRITICAL', pedido: '[[CUSTO:20]]' });
    assert.equal(Number((await lerOrcamento(b.id, tx)).consumed_amount), 160);
  });
});

test('m9d014_criticidade_vem_da_versao_ativa_do_agente', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const critico = await inserirAgente(tenantA, tx);
    await run("UPDATE ai.agents SET criticality = 'CRITICAL' WHERE id = :id", { id: critico.id }, tx);
    await levarPara(critico.id, 'ACTIVE', tx);
    const comum = await inserirAgente(tenantA, tx);
    await levarPara(comum.id, 'ACTIVE', tx);
    for (const a of [critico, comum]) {
      await criarOrcamento(tenantA, tx, { agentCode: a.code, limit: '10.00' });
      await budgets.spendWithBudget(tenantA, { agentCode: a.code, routingPath: 'SMALL_MODEL', estimate: '10.00', at: AGORA }, async () => ({ cost: '10.00' }), tx);
    }
    const pedido = (a) => budgets.reserve(tenantA, { agentCode: a.code, routingPath: 'SMALL_MODEL', estimate: '1.00', at: AGORA }, tx);
    assert.equal((await pedido(critico)).state, 'EXHAUSTED');
    await rejeita(pedido(comum), 429, 'AI_BUDGET_EXHAUSTED');
  });
});

test('m9d014_degradacao_independe_dos_alertas_e_paused_e_ignorado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await definirParametro(tenantA, 'ia.orcamento.limiares', '30,60,100', tx);
    const agentCode = agente();
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '100.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:91]]' });
    // Sem alerta de 90 (retirado dos limiares), a degradação continua em 90%: só o parâmetro limiar_degradacao a move.
    await rejeita(tenta(tx, agentCode, 'ADVANCED_MODEL'), 429, 'AI_BUDGET_EXHAUSTED');
    await definirParametro(tenantA, 'ia.orcamento.limiar_degradacao', 95, tx);
    assert.equal((await tenta(tx, agentCode, 'ADVANCED_MODEL')).reservation.state, 'NORMAL');
    await definirParametro(tenantA, 'ia.orcamento.limiar_degradacao', 90, tx);
    await rejeita(tenta(tx, agentCode, 'ADVANCED_MODEL'), 429, 'AI_BUDGET_EXHAUSTED');

    // PAUSED é ignorado: sozinho dá "sem orçamento", não recebe consumo nem alerta, e reativar retoma do consumo gravado.
    await budgets.updateBudget(tenantA, b.id, { status: 'PAUSED' }, tx);
    await rejeita(tenta(tx, agentCode, 'SMALL_MODEL'), 403, 'AI_BUDGET_NOT_CONFIGURED');
    const geral = await criarOrcamento(tenantA, tx, { agentCode: null, modelClass: 'SMALL', limit: '1000.00' });
    const r = await tenta(tx, agentCode, 'SMALL_MODEL');
    assert.deepEqual(r.reservation.budgetIds, [geral.id], 'só o ativo recebe a reserva');
    assert.equal(Number((await lerOrcamento(b.id, tx)).consumed_amount), 92, 'o pausado não recebe consumo');
    await budgets.updateBudget(tenantA, b.id, { status: 'ACTIVE' }, tx);
    await rejeita(tenta(tx, agentCode, 'ADVANCED_MODEL'), 429, 'AI_BUDGET_EXHAUSTED'); // retoma dos 91%
  });
});

test('m9d014_politica_pura_cobre_a_tabela_do_livro', () => {
  const casos = [
    [50, 'NON_CRITICAL', 'BLOCK', 'NORMAL', 5], [90, 'NON_CRITICAL', 'BLOCK', 'DEGRADED', 4], [99, 'CRITICAL', 'BLOCK', 'NORMAL', 5],
    [100, 'NON_CRITICAL', 'BLOCK', 'EXHAUSTED', 1], [100, 'NON_CRITICAL', 'DEGRADE', 'EXHAUSTED', 2], [100, 'CRITICAL', 'BLOCK', 'EXHAUSTED', 4],
  ];
  for (const [pct, criticality, actionAt100, estado, n] of casos) {
    const p = budgets.budgetPolicy({ reached: (x) => pct >= x, criticality, actionAt100, degradeFrom: 90 });
    assert.equal(p.state, estado, `${pct} ${criticality} ${actionAt100}`);
    assert.equal(p.allowedPaths.length, n, `${pct} ${criticality} ${actionAt100}`);
  }
});
