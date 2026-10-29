'use strict';

// M9-D019 — a tool de escrita crítica só cria a proposta: recomendação PENDING com snapshot e hash, tool_call PROPOSED, run
// AWAITING_APPROVAL, nada executado (AI-007: financeira, jurídica, bancária, permissão e publicação crítica).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const { sequelize, cenario, pedir, argsPagamento, argsTarefa, lerRec, lerRunDb, lerChamada, contar, setParam, abrirRun, uid } = require('../_helpers/iaAprovacao');
const { toolSensivel, pedirSintetica } = require('../_helpers/iaAprovacaoDefs');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const PAGAR_LIGADO = 'ia.financeira.permitir_proposta_pagamento';
const intents = (entryId, tx) => contar('finance.payment_intents', 'financial_entry_id = :e', { e: entryId }, tx);

test('m9d019_write_critical_vira_proposal', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await setParam(tenantA, tx, PAGAR_LIGADO, true);
    const c = await cenario(tenantA, tx);
    const { res, err } = await pedir(tenantA, tx, c, { tool: 'finance.proposePayment', args: argsPagamento(c) });
    assert.equal(err, null, err && err.message);
    assert.equal(res.status, 'PROPOSED');
    assert.ok(res.proposal.id);
    const rec = await lerRec(res.proposal.id, tx);
    assert.equal(rec.status, 'PENDING');
    assert.equal(rec.risk_level, 'CRITICAL');
    assert.equal(await intents(c.entry.id, tx), 0, 'nenhuma intenção de pagamento foi criada pela tool');
  });
});

test('m9d019_proposta_cria_recomendacao_e_nao_executa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await setParam(tenantA, tx, PAGAR_LIGADO, true);
    const c = await cenario(tenantA, tx);
    const { res } = await pedir(tenantA, tx, c, { tool: 'finance.proposePayment', args: argsPagamento(c) });
    const rec = await lerRec(res.proposal.id, tx);
    const acao = rec.proposed_action;
    assert.equal(acao.tool, 'finance.proposePayment');
    assert.equal(acao.toolVersion, 1);
    assert.deepEqual(acao.args, { financialEntryId: c.entry.id });
    assert.match(acao.argsHash, /^[0-9a-f]{64}$/);
    assert.match(acao.snapshotHash, /^[0-9a-f]{64}$/);
    assert.equal(acao.snapshot_hash, acao.snapshotHash);
    assert.equal(acao.snapshot.refs[0].entity, 'financialEntry');
    assert.equal(acao.snapshot.refs[0].state.status, 'PENDING');
    assert.equal(rec.ai_run_id, c.runId);
    const chamada = await lerChamada(rec.id, tx);
    assert.equal(chamada.status, 'PROPOSED');
    assert.equal((await lerRunDb(c.runId, tx)).status, 'AWAITING_APPROVAL');
    // O orquestrador PARA: nenhuma outra proposta nem escrita naquele run.
    const outra = await pedir(tenantA, tx, c, { tool: 'crm.createFollowUpTask', args: argsTarefa(c) });
    assert.equal(outra.err.statusCode, 409);
    assert.equal(outra.err.code, 'AI_RUN_AWAITING_APPROVAL');
    assert.equal(await contar('core.tasks', "related_entity_id = :o", { o: c.opp.id }, tx), 0);
    assert.equal(await contar('ai.ai_recommendations', 'ai_run_id = :r', { r: c.runId }, tx), 1);
  });
});

test('m9d019_pagar_boleto_padrao_recusa_sem_criar_nada_e_ligado_cria_so_proposta', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await cenario(tenantA, tx);
    const entradas = () => contar('finance.financial_entries', 'company_id = :c', { c: tenantA.companyId }, tx);
    const antes = await entradas();
    // Padrão (Desligado): recusa com a orientação da rota humana e nada é criado.
    const off = await pedir(tenantA, tx, c, { tool: 'finance.proposePayment', args: argsPagamento(c) });
    assert.equal(off.err.statusCode, 403);
    assert.equal(off.err.code, 'AI_PAYMENT_PROPOSAL_DISABLED');
    assert.match(off.err.message, /rota de pagamentos do Financeiro/);
    assert.equal(await contar('ai.ai_recommendations', 'ai_run_id = :r', { r: c.runId }, tx), 0);
    assert.equal((await lerRunDb(c.runId, tx)).status, 'RUNNING');
    assert.equal(await contar('ai.tool_calls', "run_id = :r AND status = 'BLOCKED'", { r: c.runId }, tx), 1);
    // Ligado: no máximo uma proposta PENDING.
    await setParam(tenantA, tx, PAGAR_LIGADO, true);
    const on = await pedir(tenantA, tx, c, { tool: 'finance.proposePayment', args: argsPagamento(c) });
    assert.equal(on.res.status, 'PROPOSED');
    assert.equal(await contar('ai.ai_recommendations', "ai_run_id = :r AND status = 'PENDING'", { r: c.runId }, tx), 1);
    // Nos dois casos, nenhum lançamento novo e nenhuma intenção de pagamento.
    assert.equal(await entradas(), antes);
    assert.equal(await intents(c.entry.id, tx), 0);
  });
});

test('adv_nay_tenta_pagar_ou_alterar_banco_vira_proposta_ou_nega', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await cenario(tenantA, tx);
    const { executeTool } = require('../../../src/features/ai/tools/toolExecutor');
    const { partes } = require('../_helpers/iaToolCalls');
    const { gravador } = require('../_helpers/aiToolsEnv');
    // "Pague o boleto": padrão recusa.
    const pagar = await pedir(tenantA, tx, c, { tool: 'finance.proposePayment', args: argsPagamento(c) });
    assert.equal(pagar.err.code, 'AI_PAYMENT_PROPOSAL_DISABLED');
    // "Altere a conta bancária do fornecedor": não existe tool de escrita bancária, o executor nega.
    const mapa = c.registry.executorMap();
    assert.equal(Object.keys(mapa).some((n) => /bank|banc/i.test(n)), false, 'nenhuma tool bancária registrada');
    const rec = gravador();
    const banco = await executeTool({ registry: mapa, toolName: 'finance.updateSupplierBankAccount', input: { contaId: uid() }, contextParts: partes(tenantA), recorder: rec, argsLimits: { stringMax: 500, arrayMax: 50 }, transaction: tx }).then(() => null, (e) => e);
    assert.equal(banco.statusCode, 403);
    assert.equal(banco.code, 'AI_CAPABILITY_FORBIDDEN');
    assert.equal(rec.linhas[0].status, 'BLOCKED');
    // Pelo pipeline completo a tool inexistente também é negada e nada é criado.
    const viaPipeline = await pedir(tenantA, tx, c, { tool: 'finance.updateSupplierBankAccount', args: { contaId: uid() } });
    assert.equal(viaPipeline.err.statusCode, 403);
    assert.equal(await contar('ai.ai_recommendations', 'ai_run_id = :r', { r: c.runId }, tx), 0);
  });
});

test('m9d019_alterar_conta_bancaria_sem_tool_de_escrita_403', async () => {
  const { buildDefaultRegistry } = require('../../../src/features/ai/tools');
  const registry = await buildDefaultRegistry(['crm:opportunities:read', 'people:read', 'radar:read', 'finance:read', 'construction:read', 'legal:read', 'correspondent:read', 'ai:use', 'crm:tasks:create', 'finance:create', 'legal:create']);
  const escritas = registry.list().filter((d) => d.category === 'WRITE');
  assert.deepEqual(escritas.map((d) => d.name).sort(), ['crm.createFollowUpTask', 'finance.proposePayment', 'legal.draftContract']);
  assert.equal(escritas.some((d) => d.domain === 'BANKING'), false);
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { executeTool } = require('../../../src/features/ai/tools/toolExecutor');
    const { partes } = require('../_helpers/iaToolCalls');
    const { gravador } = require('../_helpers/aiToolsEnv');
    for (const nome of ['bank.updateAccount', 'finance.changeBankAccount', 'finance.updateSupplierBankAccount']) {
      const erro = await executeTool({ registry: registry.executorMap(), toolName: nome, input: {}, contextParts: partes(tenantA), recorder: gravador(), argsLimits: { stringMax: 500, arrayMax: 50 }, transaction: tx }).then(() => null, (e) => e);
      assert.equal(erro.statusCode, 403, nome);
      assert.equal(erro.code, 'AI_CAPABILITY_FORBIDDEN', nome);
    }
  });
});

const CATEGORIAS = [
  ['m9d019_alterar_permissao_nunca_executa_por_tool', { name: 'permissions.grantRole', domain: 'PERMISSION' }],
  ['m9d019_assinar_ou_enviar_contrato_nunca_executa_por_tool', { name: 'legal.sendContractForSignature', domain: 'LEGAL' }],
  ['m9d019_publicar_peca_critica_nunca_executa_por_tool', { name: 'marketing.publishCriticalPiece', domain: 'PUBLICATION', permissionCode: 'legal:create' }],
];
for (const [nome, definicao] of CATEGORIAS) {
  test(nome, async () => {
    await withRollbackTenantTransaction(tenantA, async (tx) => {
      const c = await cenario(tenantA, tx);
      const { def, execucoes } = toolSensivel(definicao);
      const { res, err } = await pedirSintetica(tenantA, tx, { def, runId: c.runId, userId: c.solicitante });
      assert.equal(err, null, err && err.message);
      assert.equal(res.status, 'PROPOSED');
      assert.equal(execucoes.length, 0, 'a tool não executou');
      const rec = await lerRec(res.proposal.id, tx);
      assert.equal(rec.status, 'PENDING');
      assert.equal(rec.proposed_action.tool, definicao.name);
      assert.equal((await lerRunDb(c.runId, tx)).status, 'AWAITING_APPROVAL');
    });
  });
}

test('m9d019_tool_low_ou_medium_com_domain_sensivel_vira_proposta', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await cenario(tenantA, tx);
    for (const domain of ['FINANCIAL', 'LEGAL', 'BANKING', 'PERMISSION', 'PUBLICATION']) {
      for (const riskLevel of ['LOW', 'MEDIUM']) {
        const runId = await abrirRun(tenantA, tx, c.solicitante);
        const { def, execucoes } = toolSensivel({ name: `teste.${domain.toLowerCase()}${riskLevel}`, domain, riskLevel, requiresHumanApproval: false });
        const { res, err } = await pedirSintetica(tenantA, tx, { def, runId, userId: c.solicitante });
        assert.equal(err, null, `${domain}/${riskLevel}: ${err && err.message}`);
        assert.equal(res.status, 'PROPOSED', `${domain}/${riskLevel}`);
        assert.equal(execucoes.length, 0, `${domain}/${riskLevel} não executou`);
        assert.equal((await lerRec(res.proposal.id, tx)).risk_level, 'HIGH', 'domínio sensível conta como risco alto para o aprovador distinto');
      }
    }
  });
});
