'use strict';

// M9-D007 — estados da recomendação da NAY: decisão única, replay do mesmo decisor, STALE, CRITICAL e as travas do banco.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const rec = require('../../../src/features/ai/recommendations');
const { sequelize, run, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('../../helpers/aiRuns');
const { dadosRec, dadosComAcao, eventosDe, lerRec, comPerm } = require('../_helpers/iaRecomendacao');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

async function rejeita(promessa, status, code) {
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
  return err;
}

test('m9d007_decisao_unica', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const ana = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
    const beto = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
    const { recommendation } = await rec.createRecommendation(nay, dadosComAcao(), tx);
    assert.equal(recommendation.status, 'PENDING'); assert.equal(recommendation.decision, null);
    const a = await rec.acceptRecommendation(ana, recommendation.id, { reason: 'faz sentido' }, tx);
    assert.equal(a.replayed, false); assert.equal(a.recommendation.status, 'ACCEPTED'); assert.equal(a.recommendation.decision, 'ACCEPTED');
    assert.equal(a.recommendation.decidedByUserId, ana.userId); assert.ok(a.recommendation.decidedAt);
    // O mesmo decisor repetindo o accept: replay idempotente, sem novo evento.
    const b = await rec.acceptRecommendation(ana, recommendation.id, {}, tx);
    assert.equal(b.replayed, true); assert.equal(b.recommendation.id, recommendation.id);
    assert.equal((await eventosDe('ai.recommendation.accepted', recommendation.id, tx)).length, 1);
    // Outro usuário, em qualquer sentido, recebe 409; o resultado gravado não muda.
    await rejeita(rec.acceptRecommendation(beto, recommendation.id, {}, tx), 409, 'AI_RECOMMENDATION_STATE');
    await rejeita(rec.rejectRecommendation(beto, recommendation.id, { reason: 'não' }, tx), 409, 'AI_RECOMMENDATION_STATE');
    await rejeita(rec.rejectRecommendation(ana, recommendation.id, { reason: 'mudei de ideia' }, tx), 409, 'AI_RECOMMENDATION_STATE');
    const linha = await lerRec(recommendation.id, tx);
    assert.equal(linha.decision, 'ACCEPTED'); assert.equal(linha.decided_by_user_id, ana.userId);
    // O banco também recusa mudar a decisão tomada, a data e o decisor.
    await expectDbError(tx, "UPDATE ai.ai_recommendations SET decision = 'REJECTED', status = 'REJECTED' WHERE id = :id", { id: recommendation.id }, /AI_RECOMMENDATION_STATE/);
    await expectDbError(tx, 'UPDATE ai.ai_recommendations SET decided_by_user_id = :u WHERE id = :id', { id: recommendation.id, u: beto.userId }, /AI_RECOMMENDATION_STATE/);

    // Rejeitar: precisa de motivo (parâmetro ligado por padrão); estado final REJECTED não aceita mais nada.
    const outra = (await rec.createRecommendation(nay, dadosComAcao(), tx)).recommendation;
    await rejeita(rec.rejectRecommendation(ana, outra.id, {}, tx), 400, 'AI_RECOMMENDATION_INVALID');
    const r = await rec.rejectRecommendation(ana, outra.id, { reason: 'não é prioridade' }, tx);
    assert.equal(r.recommendation.status, 'REJECTED'); assert.equal(r.recommendation.decisionReason, 'não é prioridade');
    assert.equal((await rec.rejectRecommendation(ana, outra.id, { reason: 'não é prioridade' }, tx)).replayed, true);
    await rejeita(rec.acceptRecommendation(ana, outra.id, {}, tx), 409, 'AI_RECOMMENDATION_STATE');
    await expectDbError(tx, "UPDATE ai.ai_recommendations SET status = 'ACCEPTED' WHERE id = :id", { id: outra.id }, /AI_RECOMMENDATION_STATE/);
    assert.equal((await eventosDe('ai.recommendation.rejected', outra.id, tx)).length, 1);
    assert.equal((await eventosDe('ai.recommendation.created', outra.id, tx)).length, 1);
  });
});

test('m9d007_snapshot_desatualizado_vira_stale', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const ana = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
    const { recommendation } = await rec.createRecommendation(nay, dadosComAcao(), tx);
    // Quem confere o snapshot é a D019; aqui um verificador de teste devolve um hash diferente do gravado na proposta.
    rec.registerSnapshotChecker(async () => 'b'.repeat(64));
    try {
      const r = await rec.acceptRecommendation(ana, recommendation.id, {}, tx);
      assert.equal(r.stale, true); assert.equal(r.recommendation.status, 'STALE'); assert.equal(r.recommendation.decision, null);
      assert.equal((await lerRec(recommendation.id, tx)).status, 'STALE');
      assert.equal((await eventosDe('ai.recommendation.accepted', recommendation.id, tx)).length, 0, 'proposta velha não vira aceita');
      const erro = rec.staleError();
      assert.equal(erro.statusCode, 409); assert.equal(erro.code, 'AI_PROPOSAL_STALE');
      await rejeita(rec.acceptRecommendation(ana, recommendation.id, {}, tx), 409, 'AI_RECOMMENDATION_STATE');
      await rejeita(rec.rejectRecommendation(ana, recommendation.id, { reason: 'x' }, tx), 409, 'AI_RECOMMENDATION_STATE');
      await expectDbError(tx, "UPDATE ai.ai_recommendations SET status = 'PENDING' WHERE id = :id", { id: recommendation.id }, /AI_RECOMMENDATION_STATE/);
    } finally {
      rec.registerSnapshotChecker(null);
    }
    // Snapshot igual: aceita normalmente; marcar STALE à mão só vale a partir de PENDING.
    rec.registerSnapshotChecker(async () => 'a'.repeat(64));
    try {
      const ok = (await rec.createRecommendation(nay, dadosComAcao(), tx)).recommendation;
      assert.equal((await rec.acceptRecommendation(ana, ok.id, {}, tx)).recommendation.status, 'ACCEPTED');
      await rejeita(rec.markStale(nay, ok.id, { reason: 'x' }, tx), 409, 'AI_RECOMMENDATION_STATE');
    } finally {
      rec.registerSnapshotChecker(null);
    }
  });
});

test('m9d007_risk_critical_aceito', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    for (const nivel of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']) {
      const { recommendation } = await rec.createRecommendation(nay, dadosRec({ riskLevel: nivel }), tx);
      assert.equal(recommendation.riskLevel, nivel);
    }
    await rejeita(rec.createRecommendation(nay, dadosRec({ riskLevel: 'EXTREME' }), tx), 400, 'AI_RECOMMENDATION_INVALID');
    // O CHECK do banco foi ampliado: CRITICAL passa por SQL direto; valor fora da lista não.
    await run(`INSERT INTO ai.ai_recommendations (id, group_id, company_id, related_entity_type, related_entity_id, recommendation_type, risk_level)
      VALUES (gen_random_uuid(), :g, :c, 'X', gen_random_uuid(), 'T', 'CRITICAL')`, { g: tenantA.groupId, c: tenantA.companyId }, tx);
    await expectDbError(tx, `INSERT INTO ai.ai_recommendations (id, group_id, company_id, related_entity_type, related_entity_id, recommendation_type, risk_level)
      VALUES (gen_random_uuid(), :g, :c, 'X', gen_random_uuid(), 'T', 'EXTREME')`, { g: tenantA.groupId, c: tenantA.companyId }, /ai_recommendations_risk_chk/);
    await expectDbError(tx, `INSERT INTO ai.ai_recommendations (id, group_id, company_id, related_entity_type, related_entity_id, recommendation_type, status)
      VALUES (gen_random_uuid(), :g, :c, 'X', gen_random_uuid(), 'T', 'ACEITA')`, { g: tenantA.groupId, c: tenantA.companyId }, /ai_recommendations_status_chk/);
  });
});

test('m9d007_resultado_da_execucao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const ana = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
    const a = (await rec.createRecommendation(nay, dadosComAcao(), tx)).recommendation;
    // Sem aceite não há resultado.
    await rejeita(rec.recordOutcome(nay, a.id, { outcome: 'EXECUTED' }, tx), 409, 'AI_RECOMMENDATION_STATE');
    await rec.acceptRecommendation(ana, a.id, {}, tx);
    const ok = await rec.recordOutcome(nay, a.id, { outcome: 'EXECUTED', detail: 'requisição 123 aberta' }, tx);
    assert.equal(ok.status, 'EXECUTED'); assert.equal(ok.outcome, 'EXECUTED'); assert.ok(ok.outcomeAt); assert.equal(ok.decision, 'ACCEPTED');
    await rejeita(rec.recordOutcome(nay, a.id, { outcome: 'EXECUTION_FAILED' }, tx), 409, 'AI_RECOMMENDATION_STATE');
    await expectDbError(tx, "UPDATE ai.ai_recommendations SET status = 'ACCEPTED', outcome = NULL WHERE id = :id", { id: a.id }, /AI_RECOMMENDATION_STATE/);
    const b = (await rec.createRecommendation(nay, dadosComAcao(), tx)).recommendation;
    await rec.acceptRecommendation(ana, b.id, {}, tx);
    const falha = await rec.recordOutcome(nay, b.id, { outcome: 'EXECUTION_FAILED', detail: 'estoque indisponível' }, tx);
    assert.equal(falha.status, 'EXECUTION_FAILED'); assert.equal(falha.outcomeDetail, 'estoque indisponível');
    await rejeita(rec.recordOutcome(nay, b.id, { outcome: 'TALVEZ' }, tx), 400, 'AI_RECOMMENDATION_INVALID');
  });
});
