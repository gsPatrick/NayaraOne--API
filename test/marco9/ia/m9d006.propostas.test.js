'use strict';

// Marco 9, M9-D006 — chamada PROPOSED fecha pela decisão humana da recomendação (D019/D007), sem reexecutar e sem EXPIRED.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { settleProposedToolCall } = require('../../../src/features/ai/tools');
const { sequelize, q, run, uid, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('../../helpers/aiRuns');
const { abrirRun, ferramenta, rodar, linhas } = require('../_helpers/iaToolCalls');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

/** Recomendação mínima (a D007 é dona da tabela): só o que a FK precisa. */
async function recomendacao(ctx, tx, runId) {
  const id = uid();
  await run(
    `INSERT INTO ai.ai_recommendations (id, group_id, company_id, ai_run_id, related_entity_type, related_entity_id, recommendation_type, payload_json, risk_level, status)
     VALUES (:id, :g, :c, :runId, 'TESTE', :ent, 'TESTE', '{}'::jsonb, 'HIGH', 'PENDING')`, { id, g: ctx.groupId, c: ctx.companyId, runId, ent: uid() }, tx
  );
  return id;
}
const critica = () => ferramenta({ nome: 'fin.agendar_pagamento', over: { riskLevel: 'HIGH', requiresHumanApproval: true, domain: 'FINANCIAL' } });

async function propor(ctx, tx, runId, seq) {
  const { tool, execucoes } = critica();
  const proposalId = await recomendacao(ctx, tx, runId);
  const r = await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: `P${seq}` }, seq, proposeAction: async () => ({ id: proposalId }) });
  return { proposalId, r, execucoes };
}

test('m9d006_proposed_fecha_conforme_decisao_sem_expired', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = { ...ctxDe(tenantA), permissions: ['ai:use', 'ai:audit'] };
    const runId = await abrirRun(ctx, tx);
    const casos = [['EXECUTED', 'SUCCEEDED', null], ['EXECUTION_FAILED', 'FAILED', null], ['REJECTED', 'CANCELLED_BY_HUMAN', null], ['STALE', 'BLOCKED', 'STALE']];
    for (const [i, [decisao, esperado, motivo]] of casos.entries()) {
      const { proposalId, r, execucoes } = await propor(ctx, tx, runId, i + 1);
      assert.equal(r.status, 'PROPOSED');
      assert.equal(execucoes.length, 0, 'a tool crítica nunca executa direto');
      const [antes] = await linhas(runId, tx).then((l) => l.filter((x) => x.proposal_id === proposalId));
      assert.equal(antes.status, 'PROPOSED', 'fica PROPOSED até a decisão (sem expiração por tempo)');
      assert.equal(antes.finished_at, null);
      const fechada = await settleProposedToolCall(ctx, { proposalId, recommendationStatus: decisao }, tx);
      assert.equal(fechada.status, esperado, decisao);
      assert.equal(fechada.blockedReason, motivo);
      assert.ok(fechada.finishedAt);
      assert.equal(execucoes.length, 0, 'fechar não reexecuta a tool');
      // repetir a mesma decisão não muda nada
      assert.equal((await settleProposedToolCall(ctx, { proposalId, recommendationStatus: decisao }, tx)).status, esperado);
    }
    const [bloqueada] = (await linhas(runId, tx)).filter((l) => l.status === 'BLOCKED');
    const eventos = await q("SELECT count(*)::int AS n FROM integration.outbox_events WHERE event_type = 'ai.tool_call.blocked' AND aggregate_id = :id", { id: bloqueada.id }, tx);
    assert.equal(eventos[0].n, 1, 'STALE gera ai.tool_call.blocked');
    // decisão que não fecha chamada (EXPIRED, PENDING, inventada) é recusada; chamada inexistente, 404
    const { proposalId } = await propor(ctx, tx, runId, 9);
    for (const ruim of ['EXPIRED', 'PENDING', 'ACCEPTED', 'QUALQUER']) {
      const err = await settleProposedToolCall(ctx, { proposalId, recommendationStatus: ruim }, tx).then(() => null, (e) => e);
      assert.equal(err.code, 'AI_TOOL_CALL_INVALID', ruim);
    }
    assert.equal((await settleProposedToolCall(ctx, { proposalId: uid(), recommendationStatus: 'REJECTED' }, tx).then(() => null, (e) => e)).code, 'AI_TOOL_CALL_NOT_FOUND');
    // já decidida de um jeito, não vira de outro
    await settleProposedToolCall(ctx, { proposalId, recommendationStatus: 'REJECTED' }, tx);
    const volta = await settleProposedToolCall(ctx, { proposalId, recommendationStatus: 'EXECUTED' }, tx).then(() => null, (e) => e);
    assert.equal(volta.code, 'AI_TOOL_CALL_IMMUTABLE');
    // o CHECK de status do banco não aceita EXPIRED
    await expectDbError(tx, "UPDATE ai.tool_calls SET status = 'EXPIRED' WHERE proposal_id = :id", { id: proposalId }, /tool_calls_status_chk|AI_TOOL_CALL_IMMUTABLE/);
  });
});

test('m9d006_proposta_repetida_devolve_a_mesma_proposta', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = { ...ctxDe(tenantA), permissions: ['ai:use'] };
    const runId = await abrirRun(ctx, tx);
    const { proposalId } = await propor(ctx, tx, runId, 1);
    let novas = 0;
    const { tool } = critica();
    const outra = await rodar({ tenant: tenantA, ctx, tx, runId, tool, input: { ref: 'P1' }, seq: 1, proposeAction: async () => { novas += 1; return { id: uid() }; } });
    assert.equal(outra.status, 'PROPOSED');
    assert.equal(outra.replayed, true);
    assert.equal(outra.proposal.id, proposalId);
    assert.equal(novas, 0, 'não cria segunda proposta');
    assert.equal((await linhas(runId, tx)).length, 1);
  });
});
