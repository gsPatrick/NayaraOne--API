'use strict';

// M9-D019 — política de escrita: com ia.escrita_direta_baixo_risco Desligado (padrão) tudo vira proposta; Ligado, só a escrita LOW/MEDIUM
// de domínio OTHER, idempotente e sem aprovação exigida executa direto, por uma pessoa e com o run livre. HIGH/CRITICAL nunca.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { eligibleForDirectWrite } = require('../../../src/features/ai/approval');
const { SETTINGS_SCHEMA, getSetting } = require('../../../src/features/settings/settings.service');
const { sequelize, cenario, pedir, argsTarefa, argsPagamento, lerRunDb, contar, setParam } = require('../_helpers/iaAprovacao');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const DIRETA = 'ia.escrita_direta_baixo_risco';
const tarefas = (c, tx) => contar('core.tasks', 'related_entity_id = :o', { o: c.opp.id }, tx);

test('m9d019_parametros_declarados_com_padrao_conservador', async () => {
  for (const chave of [DIRETA, 'ia.financeira.permitir_proposta_pagamento']) {
    assert.deepEqual(SETTINGS_SCHEMA[chave], { type: 'boolean' }, chave);
  }
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    assert.equal(await getSetting(DIRETA, tenantA, tx, null), null, 'sem valor gravado: o código usa o padrão Desligado');
  });
});

test('m9d019_escrita_direta_desligada_tudo_vira_proposta', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await cenario(tenantA, tx);
    const { res, err } = await pedir(tenantA, tx, c, { tool: 'crm.createFollowUpTask', args: argsTarefa(c) });
    assert.equal(err, null, err && err.message);
    assert.equal(res.status, 'PROPOSED');
    assert.equal(await tarefas(c, tx), 0, 'a tarefa só nasce depois do aceite');
    assert.equal((await lerRunDb(c.runId, tx)).status, 'AWAITING_APPROVAL');
  });
});

test('m9d019_escrita_direta_ligada_so_para_baixo_risco_idempotente', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await setParam(tenantA, tx, DIRETA, true);
    await setParam(tenantA, tx, 'ia.financeira.permitir_proposta_pagamento', true);
    const c = await cenario(tenantA, tx);
    // LOW, domínio OTHER, idempotente: executa direto e o run segue livre.
    const direto = await pedir(tenantA, tx, c, { tool: 'crm.createFollowUpTask', args: argsTarefa(c) });
    assert.equal(direto.err, null, direto.err && direto.err.message);
    assert.equal(direto.res.status, 'SUCCEEDED');
    assert.equal(await tarefas(c, tx), 1);
    assert.equal((await lerRunDb(c.runId, tx)).status, 'RUNNING');
    // CRITICAL/FINANCIAL nunca executa direto, mesmo com o parâmetro Ligado.
    const pagar = await pedir(tenantA, tx, c, { tool: 'finance.proposePayment', args: argsPagamento(c) });
    assert.equal(pagar.res.status, 'PROPOSED');
    assert.equal(await contar('finance.payment_intents', 'financial_entry_id = :e', { e: c.entry.id }, tx), 0);
    // Depois da proposta o run PARA: nem a escrita direta executa mais.
    const depois = await pedir(tenantA, tx, c, { tool: 'crm.createFollowUpTask', args: argsTarefa(c, { title: 'Outra tarefa' }) });
    assert.equal(depois.err.code, 'AI_RUN_AWAITING_APPROVAL');
    assert.equal(await tarefas(c, tx), 1);
  });
});

test('m9d019_elegibilidade_da_escrita_direta', () => {
  const base = { category: 'WRITE', domain: 'OTHER', riskLevel: 'LOW', requiresHumanApproval: false, idempotent: true };
  assert.equal(eligibleForDirectWrite(base), true);
  assert.equal(eligibleForDirectWrite({ ...base, riskLevel: 'MEDIUM' }), true);
  for (const variacao of [{ riskLevel: 'HIGH' }, { riskLevel: 'CRITICAL' }, { domain: 'FINANCIAL' }, { domain: 'LEGAL' }, { domain: 'BANKING' }, { domain: 'PERMISSION' },
    { domain: 'PUBLICATION' }, { requiresHumanApproval: true }, { idempotent: false }, { category: 'READ' }]) {
    assert.equal(eligibleForDirectWrite({ ...base, ...variacao }), false, JSON.stringify(variacao));
  }
});
