'use strict';

// M9-D014 — período mensal (America/Sao_Paulo), virada de mês que rearma, validações do PUT e escrita auditada.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, carregarPessoas, q } = require('../../helpers/aiRuns');
const budgets = require('../../../src/features/ai/budgets');
const { monthPeriodOf } = require('../../../src/features/ai/budgets/budgets.period');
const { AGORA, MES_QUE_VEM, agente, criarOrcamento, gastar, alertasDe, rejeita } = require('../_helpers/iaOrcamento');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

test('m9d014_periodo_comeca_dia_1_as_00h_de_sao_paulo', () => {
  const p = monthPeriodOf(new Date('2026-10-15T15:00:00Z'));
  assert.equal(p.start.toISOString(), '2026-10-01T03:00:00.000Z');
  assert.equal(p.end.toISOString(), '2026-11-01T03:00:00.000Z');
  // 31/10 às 23:30 em São Paulo (02:30Z do dia 1) ainda é outubro; 00:00 de 01/11 já é novembro.
  assert.equal(monthPeriodOf(new Date('2026-11-01T02:59:59Z')).start.toISOString(), '2026-10-01T03:00:00.000Z');
  assert.equal(monthPeriodOf(new Date('2026-11-01T03:00:00Z')).start.toISOString(), '2026-11-01T03:00:00.000Z');
  assert.equal(monthPeriodOf(new Date('2026-12-20T12:00:00Z')).end.toISOString(), '2027-01-01T03:00:00.000Z');
});

test('m9d014_virada_de_mes_reseta_e_rearma', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const velho = await criarOrcamento(tenantA, tx, { agentCode, limit: '200.00', thresholds: [50, 100], actionAt100: 'DEGRADE' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:120]]' });
    assert.deepEqual(await alertasDe(velho.id, tx), [50]);
    // A virada abre a linha de novembro copiando limite, limiares e ação; o consumo recomeça em 0.
    const r = await budgets.rolloverCompany(tenantA, tx, { now: MES_QUE_VEM });
    assert.ok(r.created >= 1);
    const [novo] = await q('SELECT * FROM ai.budgets WHERE company_id = :c AND agent_code = :a AND period_start > :s', { c: tenantA.companyId, a: agentCode, s: velho.periodStart }, tx);
    assert.equal(new Date(novo.period_start).toISOString(), '2026-11-01T03:00:00.000Z');
    assert.equal(Number(novo.limit_amount), 200);
    assert.equal(Number(novo.consumed_amount), 0);
    assert.deepEqual(novo.thresholds, [50, 100]);
    assert.equal(novo.action_at_100, 'DEGRADE');
    // Repetir a virada não duplica.
    assert.equal((await budgets.rolloverCompany(tenantA, tx, { now: MES_QUE_VEM })).created, 0);
    // Os alertas rearmam: cruzar 50% em novembro gera outro alerta, de outra linha e de outro período.
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:120]]', at: MES_QUE_VEM });
    assert.deepEqual(await alertasDe(novo.id, tx), [50]);
    assert.deepEqual(await alertasDe(velho.id, tx), [50], 'o mês antigo não muda');
    // A virada só copia linhas existentes: escopo que nunca teve orçamento continua sem.
    await rejeita(gastar(tenantA, tx, { agentCode: agente(), at: MES_QUE_VEM }), 403, 'AI_BUDGET_NOT_CONFIGURED');
  });
});

test('m9d014_job_de_virada_abre_o_mes_de_todas_as_empresas', async () => {
  const { runAiBudgetPeriodJob } = require('../../../src/engines/jobs/aiBudgetPeriodJob');
  const r = await runAiBudgetPeriodJob({ now: AGORA, force: true });
  assert.equal(r.errors, 0);
  assert.ok(r.companies >= 1);
  assert.equal((await runAiBudgetPeriodJob({ now: AGORA })).companies, 0, 'cada empresa é feita uma vez por mês');
});

test('m9d014_limite_abaixo_do_consumido_400', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '200.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:80]]' });
    const err = await rejeita(budgets.updateBudget(tenantA, b.id, { limitAmount: '79.99' }, tx), 400, 'AI_BUDGET_BELOW_CONSUMED');
    assert.equal(err.message, 'O limite não pode ser menor que o valor já consumido.');
    const igual = await budgets.updateBudget(tenantA, b.id, { limitAmount: '80.00' }, tx);
    assert.equal(igual.limitAmount, '80.00');
    assert.equal(igual.consumedPct, '100.00');
    await rejeita(budgets.updateBudget(tenantA, b.id, { limitAmount: '0' }, tx), 400, 'AI_BUDGET_INVALID');
    await rejeita(budgets.updateBudget(tenantA, b.id, {}, tx), 400, 'AI_BUDGET_INVALID');
    await rejeita(budgets.updateBudget(tenantA, b.id, { thresholds: [90, 50] }, tx), 400, 'AI_BUDGET_INVALID');
    await rejeita(budgets.updateBudget(tenantA, b.id, { actionAt100: 'EXPLODE' }, tx), 400, 'AI_BUDGET_INVALID');
    await rejeita(budgets.updateBudget(tenantA, '00000000-0000-4000-8000-000000000000', { limitAmount: '10' }, tx), 404, 'AI_BUDGET_NOT_FOUND');
  });
});

test('m9d014_edicao_e_criacao_gravam_auditoria_antes_e_depois', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const criado = await budgets.createBudget(tenantA, { agentCode: 'NAY_FINANCEIRA', limitAmount: '300.00' }, tx, { at: AGORA });
    assert.equal(criado.limitAmount, '300.00');
    assert.equal(criado.effectiveThresholds.join(','), '50,75,90,100');
    await rejeita(budgets.createBudget(tenantA, { agentCode: 'NAY_FINANCEIRA', limitAmount: '10.00' }, tx, { at: AGORA }), 409, 'AI_BUDGET_EXISTS');
    await rejeita(budgets.createBudget(tenantA, { agentCode: 'NAO_EXISTE_ESSE', limitAmount: '10.00' }, tx, { at: AGORA }), 400, 'AI_BUDGET_INVALID');
    const editado = await budgets.updateBudget(tenantA, criado.id, { limitAmount: '450.50', actionAt100: 'DEGRADE', thresholds: [40, 80] }, tx);
    assert.equal(editado.actionAt100, 'DEGRADE');
    const trilha = await q("SELECT action, before_json, after_json FROM audit.audit_log WHERE entity_type = 'AiBudget' AND entity_id = :id ORDER BY created_at", { id: criado.id }, tx);
    assert.deepEqual(trilha.map((t) => t.action), ['ai.budget.created', 'ai.budget.updated']);
    assert.equal(trilha[1].before_json.limitAmount, '300.00');
    assert.equal(trilha[1].after_json.limitAmount, '450.50');
    assert.deepEqual(trilha[1].after_json.thresholds, [40, 80]);
  });
});

test('m9d014_listagem_traz_consumo_percentual_e_alertas', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    await criarOrcamento(tenantA, tx, { agentCode, limit: '200.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:151]]' });
    const lista = await budgets.listBudgets(tenantA, tx, { at: AGORA });
    const item = lista.find((b) => b.agentCode === agentCode);
    assert.equal(item.consumedAmount, '151.000000');
    assert.equal(item.consumedPct, '75.50');
    assert.deepEqual(item.alerts.map((a) => a.threshold), [50, 75]);
    assert.equal(item.effectiveActionAt100, 'BLOCK');
  });
});

test('m9d014_rls_empresa_b_nao_ve_nem_altera_orcamento_da_empresa_a', async () => {
  const { tenantB } = await prepararTenants();
  const agentCode = agente();
  let id;
  await withRollbackTenantTransaction(tenantA, async (tx) => { id = (await criarOrcamento(tenantA, tx, { agentCode })).id; });
  // O rollback desfez a linha; refaz dentro de uma transação onde as duas empresas são consultadas em sequência.
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    id = (await criarOrcamento(tenantA, tx, { agentCode })).id;
    await q('SELECT set_config(\'app.group_id\', :g, true), set_config(\'app.company_id\', :c, true)', { g: tenantB.groupId, c: tenantB.companyId }, tx);
    assert.equal((await q('SELECT 1 FROM ai.budgets WHERE id = :id', { id }, tx)).length, 0);
    await rejeita(budgets.updateBudget(tenantB, id, { limitAmount: '1.00' }, tx), 404, 'AI_BUDGET_NOT_FOUND');
  });
});
