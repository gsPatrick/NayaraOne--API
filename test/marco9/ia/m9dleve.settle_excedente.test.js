'use strict';

// DI-IA-LEVE-3 — settle troca a reserva pelo custo real e REVERIFICA o limite sob lock: custo real acima do limite vira excedente registrado (auditoria + retorno).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants, q } = require('../../helpers/aiRuns');
const budgets = require('../../../src/features/ai/budgets');
const { agente, criarOrcamento, gastar, lerOrcamento } = require('../_helpers/iaOrcamento');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

test('m9dleve3_custo_real_acima_do_limite_registra_excedente', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente('LEVE3');
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '50.00' });
    await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:30]]' });
    // Estimou 15 (cabe: 30+15 <= 50) mas o custo real foi 30: consumido 60 > 50.
    const reserva = await budgets.reserve(tenantA, { agentCode, criticality: 'NON_CRITICAL', routingPath: 'SMALL_MODEL', estimate: '15', at: new Date('2026-10-15T15:00:00Z') }, tx);
    const r = await budgets.settle(tenantA, reserva, '30', tx);
    assert.equal(Number((await lerOrcamento(b.id, tx)).consumed_amount), 60, 'o custo real é sempre contabilizado');
    assert.deepEqual(r.overrun.map((o) => [o.budgetId, o.excess]), [[b.id, '10.000000']]);
    const trilha = await q("SELECT after_json FROM audit.audit_log WHERE action = 'AI_BUDGET_OVERRUN' AND entity_id = :id", { id: b.id }, tx);
    assert.equal(trilha.length, 1);
    assert.equal(Number(trilha[0].after_json.excess), 10);
  });
});

test('m9dleve3_dentro_do_limite_nao_registra_excedente', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const agentCode = agente('LEVE3');
    const b = await criarOrcamento(tenantA, tx, { agentCode, limit: '50.00' });
    const r = await gastar(tenantA, tx, { agentCode, pedido: '[[CUSTO:50]]' });
    assert.deepEqual(r.overrun, []);
    const trilha = await q("SELECT 1 FROM audit.audit_log WHERE action = 'AI_BUDGET_OVERRUN' AND entity_id = :id", { id: b.id }, tx);
    assert.equal(trilha.length, 0);
  });
});
