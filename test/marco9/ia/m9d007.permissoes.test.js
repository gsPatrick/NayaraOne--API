'use strict';

// M9-D007 — quem decide: só humano, com a permissão certa; recomendação informativa pelo próprio destinatário; empresa B vê 404.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const rec = require('../../../src/features/ai/recommendations');
const runs = require('../../../src/features/ai/orchestrator/runs');
const { sequelize, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('../../helpers/aiRuns');
const { dadosRec, dadosComAcao, lerRec, comPerm, vincular } = require('../_helpers/iaRecomendacao');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const nega = async (promessa, status, code) => {
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria negar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
};

test('m9d007_nay_nao_decide', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const base = ctxDe(tenantA);
    const { recommendation: r } = await rec.createRecommendation(comPerm(base, 'ai:use'), dadosComAcao(), tx);
    // Identidade de serviço (a NAY), mesmo com todas as permissões, nunca decide; sem usuário também não.
    const nay = { groupId: base.groupId, companyId: base.companyId, serviceIdentity: true, userId: base.userId, permissions: ['ai:approve', 'ai:read', 'ai:use'] };
    const semUsuario = { groupId: base.groupId, companyId: base.companyId, permissions: ['ai:approve', 'ai:read'] };
    for (const ctx of [nay, semUsuario]) {
      await nega(rec.acceptRecommendation(ctx, r.id, {}, tx), 403, 'AI_RECOMMENDATION_HUMAN_ONLY');
      await nega(rec.rejectRecommendation(ctx, r.id, { reason: 'x' }, tx), 403, 'AI_RECOMMENDATION_HUMAN_ONLY');
    }
    const linha = await lerRec(r.id, tx);
    assert.equal(linha.status, 'PENDING'); assert.equal(linha.decision, null); assert.equal(linha.decided_by_user_id, null);
    // O banco recusa decisão sem uma pessoa registrada como decisora.
    await expectDbError(tx, "UPDATE ai.ai_recommendations SET decision = 'ACCEPTED', status = 'ACCEPTED' WHERE id = :id", { id: r.id }, /ai_recommendations_decision_human_chk/);
  });
});

test('m9d007_informativa_aceita_por_target_com_ai_read', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const corretor = comPerm(ctxDe(tenantA), 'ai:read');
    const outro = comPerm(ctxDe(tenantA), 'ai:read');
    const gestor = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
    await vincular(tenantA, tx, corretor.userId);
    const info = (await rec.createRecommendation(nay, dadosRec({ targetUserId: corretor.userId }), tx)).recommendation;
    // Outro usuário sem ai:approve: 403. O destinatário sem ai:read também.
    await nega(rec.acceptRecommendation(outro, info.id, {}, tx), 403, 'PERMISSION_DENIED');
    await nega(rec.acceptRecommendation(comPerm(corretor, 'ai:use'), info.id, {}, tx), 403, 'PERMISSION_DENIED');
    const ok = await rec.acceptRecommendation(corretor, info.id, {}, tx);
    assert.equal(ok.recommendation.status, 'ACCEPTED'); assert.equal(ok.recommendation.outcome, 'NOT_APPLICABLE'); assert.ok(ok.recommendation.outcomeAt);
    assert.equal((await rec.acceptRecommendation(corretor, info.id, {}, tx)).replayed, true);
    // Rejeitar uma informativa também é do destinatário com ai:read (o motivo é exigido pelo parâmetro).
    const info2 = (await rec.createRecommendation(nay, dadosRec({ targetUserId: corretor.userId }), tx)).recommendation;
    assert.equal((await rec.rejectRecommendation(corretor, info2.id, { reason: 'já resolvi' }, tx)).recommendation.status, 'REJECTED');
    // Quem tem ai:approve decide qualquer informativa da empresa.
    const info3 = (await rec.createRecommendation(nay, dadosRec({ targetUserId: corretor.userId }), tx)).recommendation;
    assert.equal((await rec.acceptRecommendation(gestor, info3.id, {}, tx)).recommendation.status, 'ACCEPTED');
    // Com proposed_action, o destinatário só com ai:read NÃO decide: exige ai:approve (e nunca executa por conta própria).
    const comAcao = (await rec.createRecommendation(nay, dadosComAcao({ targetUserId: corretor.userId }), tx)).recommendation;
    await nega(rec.acceptRecommendation(corretor, comAcao.id, {}, tx), 403, 'PERMISSION_DENIED');
    await nega(rec.rejectRecommendation(corretor, comAcao.id, { reason: 'x' }, tx), 403, 'PERMISSION_DENIED');
    const decidida = await rec.acceptRecommendation(gestor, comAcao.id, {}, tx);
    assert.equal(decidida.recommendation.outcome, null, 'o resultado só existe depois da execução (D019)');
  });
});

test('m9d007_empresa_b_404', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const { recommendation: r } = await rec.createRecommendation(nay, dadosComAcao(), tx);
    const deB = comPerm(ctxDe(tenantB), 'ai:read', 'ai:approve', 'ai:audit');
    // A sessão da empresa B (RLS) nunca encontra a linha da A; o serviço ainda filtra por empresa.
    await nega(rec.acceptRecommendation(deB, r.id, {}, tx), 404, 'AI_RECOMMENDATION_NOT_FOUND');
    await nega(rec.rejectRecommendation(deB, r.id, { reason: 'x' }, tx), 404, 'AI_RECOMMENDATION_NOT_FOUND');
    await nega(rec.getRecommendation(deB, r.id, tx), 404, 'AI_RECOMMENDATION_NOT_FOUND');
    await nega(rec.acceptRecommendation(comPerm(ctxDe(tenantA), 'ai:approve'), '00000000-0000-4000-8000-000000000000', {}, tx), 404, 'AI_RECOMMENDATION_NOT_FOUND');
    assert.equal((await lerRec(r.id, tx)).status, 'PENDING');
  });
  await withRollbackTenantTransaction(tenantB, async (txB) => {
    const deB = comPerm(ctxDe(tenantB), 'ai:read', 'ai:audit');
    assert.deepEqual((await rec.listRecommendations(deB, { status: 'PENDING' }, txB)).filter((x) => x.agentCode === 'NAY_ISOLAMENTO_A'), []);
  });
});

test('m9d007_aprovador_distinto_de_quem_solicitou_o_run', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const solicitante = comPerm(ctxDe(tenantA), 'ai:use', 'ai:read', 'ai:approve');
    const outro = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
    const { run } = await runs.startRun(solicitante, { agentName: 'NAY_TESTE', purpose: 't', inputSummary: 'pedido' }, tx);
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const alto = (await rec.createRecommendation(nay, dadosComAcao({ aiRunId: run.id, riskLevel: 'HIGH' }), tx)).recommendation;
    const baixo = (await rec.createRecommendation(nay, dadosComAcao({ aiRunId: run.id, riskLevel: 'LOW' }), tx)).recommendation;
    await nega(rec.acceptRecommendation(solicitante, alto.id, {}, tx), 403, 'AI_RECOMMENDATION_SAME_REQUESTER');
    assert.equal((await rec.acceptRecommendation(solicitante, baixo.id, {}, tx)).recommendation.status, 'ACCEPTED', 'risco baixo não exige distinto');
    // Desligado o parâmetro da D019, o mesmo usuário pode decidir.
    await upsertSetting('ia.aprovacao.aprovador_distinto', false, solicitante, solicitante.userId, tx);
    assert.equal((await rec.acceptRecommendation(solicitante, alto.id, {}, tx)).recommendation.status, 'ACCEPTED');
    const critico = (await rec.createRecommendation(nay, dadosComAcao({ aiRunId: run.id, riskLevel: 'CRITICAL' }), tx)).recommendation;
    await upsertSetting('ia.aprovacao.aprovador_distinto', true, solicitante, solicitante.userId, tx);
    await nega(rec.rejectRecommendation(solicitante, critico.id, { reason: 'x' }, tx), 403, 'AI_RECOMMENDATION_SAME_REQUESTER');
    assert.equal((await rec.acceptRecommendation(outro, critico.id, {}, tx)).recommendation.status, 'ACCEPTED');
  });
});
