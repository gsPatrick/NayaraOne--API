'use strict';

// M9-D014 — alertas 50/75/90/100% do orçamento da NAY: uma vez por limiar e período, configuráveis, idempotentes em concorrência.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, carregarPessoas, q } = require('../../helpers/aiRuns');
const { DISPOSABLE, SKIP } = require('../_helpers/aiHttpEnv');
const repo = require('../../../src/features/ai/readmodels/budgetSupport.readmodel');
const {
  agente, criarOrcamento, gastar, alertasDe, eventosLimiar, definirParametro, comoTenant,
} = require('../_helpers/iaOrcamento');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

test('m9d014_alerta_50_75_90_100_uma_vez_cada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '200.00' });
    const sequencia = [['[[CUSTO:100]]', [50]], ['[[CUSTO:50]]', [50, 75]], ['[[CUSTO:30]]', [50, 75, 90]], ['[[CUSTO:20]]', [50, 75, 90, 100]]];
    for (const [pedido, esperado] of sequencia) {
      await gastar(tenantA, tx, { agentCode, pedido });
      assert.deepEqual(await alertasDe(b.id, tx), esperado, pedido);
    }
    const eventos = await eventosLimiar(b.id, tx);
    assert.deepEqual(eventos.map((e) => e.payload_json.threshold).sort((x, y) => x - y), [50, 75, 90, 100]);
    assert.equal(eventos[0].aggregate_type, 'AiBudget');
    assert.equal(eventos[0].payload_json.budgetId, b.id);
    assert.equal(eventos[0].payload_json.periodStart, new Date(b.periodStart).toISOString());
    // Passar de novo pela faixa (consumo extra de crítico) não repete alerta nem evento.
    await gastar(tenantA, tx, { agentCode, criticality: 'CRITICAL', pedido: '[[CUSTO:1]]' });
    assert.equal((await eventosLimiar(b.id, tx)).length, 4);
    assert.deepEqual(await alertasDe(b.id, tx), [50, 75, 90, 100]);
  });
});

test('m9d014_alerta_com_mensagem_e_aviso_a_quem_tem_ai_budget', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente();
    const [{ role_id: roleId }] = await q("SELECT role_id FROM core.user_memberships WHERE company_id = :c AND status = 'ACTIVE' AND deleted_at IS NULL AND role_id IS NOT NULL LIMIT 1", { c: tenantA.companyId }, tx);
    const [{ id: permId }] = await q("SELECT id FROM core.permissions WHERE code = 'ai:budget'", {}, tx);
    await q('INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at) SELECT gen_random_uuid(), :r, :p, now(), now() WHERE NOT EXISTS (SELECT 1 FROM core.role_permissions WHERE role_id = :r AND permission_id = :p)', { r: roleId, p: permId }, tx);
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '200.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:100]]' });
    const avisos = await q("SELECT body, title FROM core.notifications WHERE company_id = :c AND title = 'Orçamento de IA em 50%' AND body LIKE :like", { c: tenantA.companyId, like: `%do agente ${agentCode}%` }, tx);
    assert.ok(avisos.length >= 1, 'quem tem ai:budget foi avisado');
    assert.equal(avisos[0].body, `O orçamento de IA do agente ${agentCode} chegou a 50%: R$ 100,00 de R$ 200,00.`);
    assert.deepEqual(await alertasDe(b.id, tx), [50]);
  });
});

test('m9d014_limiares_configuraveis_alertam_nos_novos_pontos', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await definirParametro(tenantA, 'ia.orcamento.limiares', '30,60,100', tx);
    const agentCode = agente();
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '100.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:30]]' });
    assert.deepEqual(await alertasDe(b.id, tx), [30]);
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:30]]' });
    assert.deepEqual(await alertasDe(b.id, tx), [30, 60]);
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:10]]' }); // 70%: nenhum alerta de 75
    assert.deepEqual(await alertasDe(b.id, tx), [30, 60]);
    await gastar(tenantA, tx, { agentCode, criticality: 'CRITICAL', pedido: '[[CUSTO:30]]' });
    assert.deepEqual(await alertasDe(b.id, tx), [30, 60, 100]);
    assert.ok(!(await alertasDe(b.id, tx)).some((t) => [50, 75, 90].includes(t)));
    // Linhas com limiares próprios ignoram o parâmetro.
    const c = await criarOrcamento(tenantA, tx, { agentCode: agente(), limit: '100.00', thresholds: [10] });
    await gastar(tenantA, tx, { agentCode: c.agentCode, pedido: '[[CUSTO:10]]' });
    assert.deepEqual(await alertasDe(c.id, tx), [10]);
  });
});

test('m9d014_alerta_idempotente_duas_conexoes', { skip: SKIP }, async () => {
  assert.ok(DISPOSABLE);
  const agentCode = agente();
  const b = await comoTenant(tenantA, (tx) => criarOrcamento(tenantA, tx, { agentCode, limit: '200.00' }));
  // Duas conexões gastam ao mesmo tempo e cruzam juntas o limiar de 50%: a segunda espera a trava da primeira; sai um alerta só.
  const [r1, r2] = await Promise.all([
    comoTenant(tenantA, (tx) => gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:60]]' })),
    comoTenant(tenantA, (tx) => gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:60]]' })),
  ]);
  assert.equal(r1.alertsRaised.length + r2.alertsRaised.length, 1);
  await comoTenant(tenantA, async (tx) => {
    assert.deepEqual(await alertasDe(b.id, tx), [50]);
    assert.equal((await eventosLimiar(b.id, tx)).length, 1, 'um evento só');
  });
  // E, sem a trava da linha, o UNIQUE (budget_id, limiar, período) sozinho impede o segundo alerta do mesmo limiar.
  const linha = await comoTenant(tenantA, (tx) => repo.findById(tenantA, b.id, tx));
  const [a, c] = await Promise.all([
    comoTenant(tenantA, (tx) => repo.insertAlert(linha, 75, '75.00', tx)),
    comoTenant(tenantA, (tx) => repo.insertAlert(linha, 75, '75.00', tx)),
  ]);
  assert.deepEqual([a, c].sort(), [false, true]);
});
