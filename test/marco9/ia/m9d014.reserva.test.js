'use strict';

// M9-D014 — reserva atômica antes de gastar: o limite vale, a concorrência não ultrapassa, a falha devolve a reserva e
// a empresa sem orçamento não executa modelo pago (AI-013).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, carregarPessoas } = require('../../helpers/aiRuns');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const budgets = require('../../../src/features/ai/budgets');
const {
  AGORA, agente, criarOrcamento, gastar, lerOrcamento, comoTenant, rejeita,
} = require('../_helpers/iaOrcamento');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

test('m9d014_budget_limit_funciona', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '50.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:30]]' });
    // 30 + 25 passaria do limite de 50: a estimativa é recusada antes da chamada e nada é reservado.
    const err = await rejeita(gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:25]]' }), 429, 'AI_BUDGET_EXHAUSTED');
    assert.equal(err.message, 'O orçamento de IA deste período acabou.');
    const linha = await lerOrcamento(b.id, tx);
    assert.equal(Number(linha.consumed_amount), 30);
    assert.equal(Number(linha.reserved_amount), 0);
    // Cabendo, passa; o consumo pode chegar exatamente ao limite (<=), nunca além.
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:20]]' });
    assert.equal(Number((await lerOrcamento(b.id, tx)).consumed_amount), 50);
    await rejeita(gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:0.01]]' }), 429, 'AI_BUDGET_EXHAUSTED');
  });
});

test('m9d014_sem_orcamento_falha_fechada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const err = await rejeita(gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:1]]' }), 403, 'AI_BUDGET_NOT_CONFIGURED');
    assert.equal(err.message, 'Configure o orçamento de IA da empresa antes de usar a NAY.');
    // Embedding e modelo avançado também; o caminho RULE (custo zero) e o agente CRITICAL seguem a mesma regra: RULE passa, modelo não.
    await rejeita(gastar(tenantA, tx, { agentCode, routingPath: 'ADVANCED_MODEL' }), 403, 'AI_BUDGET_NOT_CONFIGURED');
    await rejeita(gastar(tenantA, tx, { agentCode, criticality: 'CRITICAL' }), 403, 'AI_BUDGET_NOT_CONFIGURED');
    await rejeita(gastar(tenantA, tx, { agentCode, routingPath: 'CACHE' }), 403, 'AI_BUDGET_NOT_CONFIGURED');
    const rule = await gastar(tenantA, tx, { agentCode, routingPath: 'RULE', pedido: '[[CUSTO:0]]' });
    assert.equal(rule.reservation.free, true);
  });
});

test('m9d014_falha_libera_reserva', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '100.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:20]]' });
    await assert.rejects(gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:60]]', falhar: true }), /falha do provider/);
    const linha = await lerOrcamento(b.id, tx);
    assert.equal(Number(linha.reserved_amount), 0, 'a reserva volta');
    assert.equal(Number(linha.consumed_amount), 20, 'e nada foi consumido');
    // A reserva liberada deixa de ocupar o limite: cabem mais 80.
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:80]]' });
    // Reserva em aberto (sem settle) ocupa o limite; release a devolve.
    const c = await criarOrcamento(tenantA, tx, { agentCode: agente(), limit: '10.00' });
    const reserva = await budgets.reserve(tenantA, { agentCode: c.agentCode, criticality: 'NON_CRITICAL', routingPath: 'SMALL_MODEL', estimate: '8.00', at: AGORA }, tx);
    assert.equal(Number((await lerOrcamento(c.id, tx)).reserved_amount), 8);
    await rejeita(budgets.reserve(tenantA, { agentCode: c.agentCode, routingPath: 'SMALL_MODEL', estimate: '3.00', at: AGORA }, tx), 429, 'AI_BUDGET_EXHAUSTED');
    await budgets.release(tenantA, reserva, tx);
    assert.equal(Number((await lerOrcamento(c.id, tx)).reserved_amount), 0);
  });
});

test('m9d014_reserva_troca_estimativa_pelo_custo_real_e_conta_em_todos_os_que_contem', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const empresa = await criarOrcamento(tenantA, tx, { agentCode: null, modelClass: 'SMALL', limit: '1000.00' });
    const doAgente = await criarOrcamento(tenantA, tx, { agentCode, limit: '100.00' });
    const r = await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:12.345678]]', estimate: '40.00' });
    assert.equal(r.reservation.budgetIds.length, 2);
    for (const id of [empresa.id, doAgente.id]) {
      const linha = await lerOrcamento(id, tx);
      assert.equal(linha.consumed_amount, '12.345678');
      assert.equal(Number(linha.reserved_amount), 0);
    }
    // O mais específico governa a política; o gasto continua somando no geral (modelo avançado não está no escopo SMALL do geral).
    const avancado = await gastar(tenantA, tx, { agentCode, routingPath: 'ADVANCED_MODEL', pedido: '[[CUSTO:5]]' });
    assert.equal(avancado.reservation.budgetIds.length, 1);
  });
});

test('m9d014_reserva_impede_ultrapassar_limite_concorrente', { skip: SKIP }, async () => {
  assert.ok(DISPOSABLE);
  const agentCode = agente();
  const b = await comoTenant(tenantA, (tx) => criarOrcamento(tenantA, tx, { agentCode, limit: '100.00' }));
  // Cinco chamadas simultâneas de R$ 30 em conexões diferentes: só 3 cabem em R$ 100; as outras 2 são recusadas.
  const resultados = await Promise.allSettled(Array.from({ length: 5 }, () => comoTenant(tenantA, (tx) => gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:30]]' }))));
  const ok = resultados.filter((r) => r.status === 'fulfilled').length;
  const recusadas = resultados.filter((r) => r.status === 'rejected' && r.reason.code === 'AI_BUDGET_EXHAUSTED').length;
  assert.equal(ok, 3);
  assert.equal(recusadas, 2);
  const linha = await comoTenant(tenantA, (tx) => lerOrcamento(b.id, tx));
  assert.equal(Number(linha.consumed_amount), 90);
  assert.equal(Number(linha.reserved_amount), 0);
  assert.ok(Number(linha.consumed_amount) + Number(linha.reserved_amount) <= Number(linha.limit_amount));
});

test('m9d014_reserva_simultanea_so_com_estimativa_em_aberto_nao_passa_do_limite', { skip: SKIP }, async () => {
  assert.ok(DISPOSABLE);
  const agentCode = agente();
  const b = await comoTenant(tenantA, (tx) => criarOrcamento(tenantA, tx, { agentCode, limit: '100.00' }));
  // A reserva é feita sob FOR UPDATE e a chamada demora: a segunda conexão espera e já enxerga a reserva da primeira.
  const lenta = comoTenant(tenantA, (tx) => budgets.spendWithBudget(tenantA, { agentCode, criticality: 'NON_CRITICAL', routingPath: 'SMALL_MODEL', estimate: '70.00', at: AGORA }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { cost: '10.00' };
  }, tx));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rapida = comoTenant(tenantA, (tx) => gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:50]]' }));
  await lenta;
  // Quando a lenta termina, só R$ 10 foram consumidos: a segunda (R$ 50) cabe, porque a reserva de 70 já foi trocada pelo real.
  await rapida;
  const linha = await comoTenant(tenantA, (tx) => lerOrcamento(b.id, tx));
  assert.equal(Number(linha.consumed_amount), 60);
  assert.equal(Number(linha.reserved_amount), 0);
});
