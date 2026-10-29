'use strict';

// M9-D032 — resultado de avaliação imutável depois de final (gatilho do banco), itens que só entram, homologação gravada uma vez
// e isolamento entre empresas (empresa B nunca enxerga a avaliação da A: 404).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const H = require('../_helpers/iaAvaliacao');

const svc = new AiEvaluationService();
let tenantA;
let tenantB;
let pessoas;
before(async () => {
  ({ tenantA, tenantB } = await H.prepararTenants());
  await H.carregarPessoas();
  pessoas = [H.ctxDe(tenantA), H.ctxDe(tenantA)].map((c) => c.userId);
});
after(async () => { await H.sequelize.close(); });

const como = (tenant, userId, ...permissions) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId, permissions });

test('m9d032_avaliacao_final_imutavel', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const [disparador, outra] = pessoas;
    const { code } = await H.criarAgente(tenantA, tx);
    const ev = await H.avaliar(svc, como(tenantA, disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'all' });
    assert.equal(ev.status, 'PASSED');
    assert.ok(ev.items.length > 0);
    const IMUTAVEL = /AI_EVALUATION_IMMUTABLE/;
    await H.expectDbError(tx, "UPDATE ai.evaluations SET status = 'FAILED' WHERE id = :id", { id: ev.id }, IMUTAVEL);
    await H.expectDbError(tx, "UPDATE ai.evaluations SET metrics = '{}'::jsonb WHERE id = :id", { id: ev.id }, IMUTAVEL);
    await H.expectDbError(tx, "UPDATE ai.evaluations SET totals = '{\"cases\":0}'::jsonb WHERE id = :id", { id: ev.id }, IMUTAVEL);
    await H.expectDbError(tx, 'UPDATE ai.evaluations SET agent_version = 9 WHERE id = :id', { id: ev.id }, IMUTAVEL);
    await H.expectDbError(tx, 'UPDATE ai.evaluation_items SET passed = false WHERE evaluation_id = :id', { id: ev.id }, /AI_EVALUATION_IMMUTABLE/);
    await H.expectDbError(tx, 'DELETE FROM ai.evaluation_items WHERE evaluation_id = :id', { id: ev.id }, /AI_EVALUATION_IMMUTABLE/);
    await H.expectDbError(
      tx, `INSERT INTO ai.evaluation_items (group_id, company_id, evaluation_id, case_id, category, input_hash, passed) VALUES (:g, :c, :id, 'extra', 'GROUNDING', :h, true)`,
      { g: tenantA.groupId, c: tenantA.companyId, id: ev.id, h: 'a'.repeat(64) }, IMUTAVEL
    );
    // a homologação é a única mudança permitida, uma vez
    await svc.homologate(como(tenantA, outra, 'ai:evaluate'), ev.id, { note: 'ok' }, tx);
    await H.expectDbError(tx, 'UPDATE ai.evaluations SET homologation_note = \'trocada\' WHERE id = :id', { id: ev.id }, IMUTAVEL);
    await H.expectDbError(tx, 'UPDATE ai.evaluations SET homologated_by = :u WHERE id = :id', { id: ev.id, u: disparador }, IMUTAVEL);
    // estado ERROR e FAILED também não mudam nem se homologam
    const erro = H.uid();
    await H.run("INSERT INTO ai.evaluations (id, group_id, company_id, agent_code, agent_version, suite, status, triggered_by) VALUES (:id, :g, :c, 'X_ERRO', 1, 'ALL', 'ERROR', :u)", { id: erro, g: tenantA.groupId, c: tenantA.companyId, u: disparador }, tx);
    await H.expectDbError(tx, "UPDATE ai.evaluations SET status = 'PASSED' WHERE id = :id", { id: erro }, IMUTAVEL);
    await H.expectDbError(tx, 'UPDATE ai.evaluations SET homologated_by = :u, homologated_at = now() WHERE id = :id', { id: erro, u: outra }, IMUTAVEL);
    // máquina de estados: não pula de QUEUED direto para PASSED
    const fila = H.uid();
    await H.run("INSERT INTO ai.evaluations (id, group_id, company_id, agent_code, agent_version, suite, triggered_by) VALUES (:id, :g, :c, 'X_FILA', 1, 'ALL', :u)", { id: fila, g: tenantA.groupId, c: tenantA.companyId, u: disparador }, tx);
    await H.expectDbError(tx, "UPDATE ai.evaluations SET status = 'PASSED' WHERE id = :id", { id: fila }, IMUTAVEL);
    await H.rejeita(svc.homologate(como(tenantA, outra, 'ai:evaluate'), fila, {}, tx), 409, 'AI_EVALUATION_NOT_PASSED');
  });
});

test('m9d032_empresa_b_nao_enxerga_avaliacao_da_a', async () => {
  const idA = await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { code } = await H.criarAgente(tenantA, tx);
    const ev = await H.avaliar(svc, como(tenantA, pessoas[0], 'ai:evaluate'), tx, { agentCode: code, suite: 'golden' });
    const lista = await svc.list(como(tenantA, pessoas[0], 'ai:evaluate'), { agentCode: code }, tx);
    assert.equal(lista.length, 1);
    // dentro da mesma transação, com o contexto da B, a RLS esconde tudo (o contexto da transação continua o da A: prova pelo serviço)
    await H.rejeita(svc.get(como(tenantB, pessoas[0], 'ai:evaluate'), ev.id, tx), 404, 'AI_EVALUATION_NOT_FOUND');
    await H.rejeita(svc.homologate(como(tenantB, pessoas[1], 'ai:evaluate'), ev.id, { note: 'x' }, tx), 404, 'AI_EVALUATION_NOT_FOUND');
    return ev.id;
  });
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    assert.equal((await H.q('SELECT count(*)::int AS n FROM ai.evaluations WHERE id = :id', { id: idA }, tx))[0].n, 0);
    await H.rejeita(svc.get(como(tenantB, pessoas[0], 'ai:evaluate'), idA, tx), 404, 'AI_EVALUATION_NOT_FOUND');
    await H.rejeita(svc.request(como(tenantB, pessoas[0], 'ai:evaluate'), { agentCode: 'NAY_COMERCIAL', agentVersion: 99, suite: 'golden' }, tx), 404, 'AI_AGENT_NOT_FOUND');
  });
});

test('m9d032_idempotencia_do_pedido_e_validacoes', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = como(tenantA, pessoas[0], 'ai:evaluate');
    const { code } = await H.criarAgente(tenantA, tx);
    const a = await svc.request(ctx, { agentCode: code, suite: 'golden', idempotencyKey: 'chave-m9d032-a' }, tx);
    const b = await svc.request(ctx, { agentCode: code, suite: 'golden', idempotencyKey: 'chave-m9d032-a' }, tx);
    assert.equal(a.replayed, false); assert.equal(b.replayed, true); assert.equal(a.evaluation.id, b.evaluation.id);
    await H.rejeita(svc.request(ctx, { agentCode: code, suite: 'all', idempotencyKey: 'chave-m9d032-a' }, tx), 400, 'AI_EVALUATION_INVALID');
    await H.rejeita(svc.request(ctx, { agentCode: code, suite: 'tudo' }, tx), 400, 'AI_EVALUATION_INVALID');
    await H.rejeita(svc.request(ctx, { agentCode: 'x y!', suite: 'all' }, tx), 400, 'AI_EVALUATION_INVALID');
    await H.rejeita(svc.request(ctx, { agentCode: 'NAO_EXISTE_XYZ', suite: 'all' }, tx), 404, 'AI_AGENT_NOT_FOUND');
    // executar duas vezes não duplica itens: a avaliação já final não é pega de novo
    await svc.processQueued(ctx, tx, { evaluationId: a.evaluation.id });
    const feitas = await svc.processQueued(ctx, tx, {});
    assert.equal(feitas.length, 0);
    const itens = (await svc.get(ctx, a.evaluation.id, tx)).items.length;
    assert.ok(itens > 0);
  });
});
