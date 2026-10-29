'use strict';

// M9-D007 — criação da recomendação da NAY: dedup da pendente, texto sem segredo, eventos e listagem por destinatário.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const rec = require('../../../src/features/ai/recommendations');
const { sequelize, uid, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('../../helpers/aiRuns');
const { dadosRec, dadosComAcao, eventosDe, lerRec, comPerm, vincular } = require('../_helpers/iaRecomendacao');

const CANARIO = 'SECRET-CANARY-7f3a';
let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const invalida = async (promessa) => {
  const err = await promessa.then(() => null, (e) => e);
  assert.equal(err && err.code, 'AI_RECOMMENDATION_INVALID', err && err.message);
  assert.equal(err.statusCode, 400);
};

test('m9d007_dedup_nao_duplica_pendente', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const ana = comPerm(ctxDe(tenantA), 'ai:read', 'ai:approve');
    const dados = dadosRec();
    const a = await rec.createRecommendation(nay, dados, tx);
    const b = await rec.createRecommendation(nay, { ...dados, title: 'outro título', confidence: 0.5 }, tx);
    assert.equal(a.replayed, false); assert.equal(b.replayed, true); assert.equal(a.recommendation.id, b.recommendation.id);
    assert.match(a.recommendation.dedupKey, /^[0-9a-f]{64}$/);
    assert.equal((await eventosDe('ai.recommendation.created', a.recommendation.id, tx)).length, 1);
    // Outra entidade, outro agente ou outro tipo são sugestões diferentes.
    for (const diff of [{ relatedEntityId: uid() }, { agentCode: 'NAY_OUTRA' }, { recommendationType: 'NEXT_STEP' }]) {
      const c = await rec.createRecommendation(nay, { ...dados, ...diff }, tx);
      assert.equal(c.replayed, false); assert.notEqual(c.recommendation.id, a.recommendation.id);
    }
    // O banco garante: duas pendentes com a mesma chave não coexistem.
    await expectDbError(tx, `INSERT INTO ai.ai_recommendations (id, group_id, company_id, related_entity_type, related_entity_id, recommendation_type, dedup_key)
      VALUES (gen_random_uuid(), :g, :c, 'X', gen_random_uuid(), 'T', :k)`, { g: tenantA.groupId, c: tenantA.companyId, k: a.recommendation.dedupKey }, /ai_recommendations_dedup_uq/);
    // Decidida a primeira, a mesma sugestão no mesmo dia pode ser feita de novo (a trava é só para a pendente).
    await rec.rejectRecommendation(ana, a.recommendation.id, { reason: 'agora não' }, tx);
    const d = await rec.createRecommendation(nay, dados, tx);
    assert.equal(d.replayed, false); assert.notEqual(d.recommendation.id, a.recommendation.id); assert.equal(d.recommendation.status, 'PENDING');
  });
});

test('m9d007_criacao_valida_e_guarda_so_texto_sanitizado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const { recommendation: r } = await rec.createRecommendation(nay, dadosComAcao({
      rationale: `Veja o contrato. Authorization: Bearer ${CANARIO}0123456789`,
      proposedAction: { tool: 'procurement.criar', args: { apiKey: CANARIO, quantidade: 2, prompt: 'PROMPT-BRUTO' }, snapshot: { saldo: 1 }, snapshot_hash: 'c'.repeat(64) },
      payload: { nota: `password=${CANARIO}` },
    }), tx);
    const texto = JSON.stringify(await lerRec(r.id, tx));
    assert.ok(!texto.includes(CANARIO) && !texto.includes('PROMPT-BRUTO'), 'sem segredo nem prompt bruto');
    assert.equal(r.proposedAction.tool, 'procurement.criar'); assert.equal(r.proposedAction.args.quantidade, 2);
    // Justificativa é texto curto: o limite é parâmetro da empresa.
    const longa = await rec.createRecommendation(nay, dadosRec({ rationale: 'x'.repeat(5000) }), tx);
    assert.equal(longa.recommendation.rationale.length, 1000);
    const ctx = ctxDe(tenantA);
    await upsertSetting('ia.recomendacao.justificativa_max_caracteres', 200, ctx, ctx.userId, tx);
    assert.equal((await rec.createRecommendation(nay, dadosRec({ rationale: 'y'.repeat(5000) }), tx)).recommendation.rationale.length, 200);
    // Entradas inválidas.
    await invalida(rec.createRecommendation(nay, dadosRec({ title: '' }), tx));
    await invalida(rec.createRecommendation(nay, dadosRec({ agentCode: undefined }), tx));
    await invalida(rec.createRecommendation(nay, dadosRec({ confidence: 1.5 }), tx));
    await invalida(rec.createRecommendation(nay, dadosRec({ relatedEntityId: 'nao-e-uuid' }), tx));
    await invalida(rec.createRecommendation(nay, dadosRec({ proposedAction: { args: {} } }), tx));
    await invalida(rec.createRecommendation(nay, dadosRec({ aiRunId: uid() }), tx));
    await invalida(rec.createRecommendation(nay, dadosRec({ targetUserId: uid() }), tx));
  });
});

test('m9d007_listagem_por_destinatario', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const nay = comPerm(ctxDe(tenantA), 'ai:use');
    const ana = comPerm(ctxDe(tenantA), 'ai:read');
    const beto = comPerm(ctxDe(tenantA), 'ai:read');
    const auditor = comPerm(ctxDe(tenantA), 'ai:audit');
    await vincular(tenantA, tx, ana.userId, beto.userId);
    const daAna = (await rec.createRecommendation(nay, dadosRec({ targetUserId: ana.userId }), tx)).recommendation;
    const doBeto = (await rec.createRecommendation(nay, dadosRec({ targetUserId: beto.userId }), tx)).recommendation;
    const idsAna = (await rec.listRecommendations(ana, {}, tx)).map((x) => x.id);
    assert.ok(idsAna.includes(daAna.id) && !idsAna.includes(doBeto.id), 'ai:read lista só as dirigidas à pessoa');
    const idsAuditor = (await rec.listRecommendations(auditor, {}, tx)).map((x) => x.id);
    assert.ok(idsAuditor.includes(daAna.id) && idsAuditor.includes(doBeto.id), 'ai:audit enxerga a empresa');
    assert.equal((await rec.listRecommendations(ana, { status: 'REJECTED' }, tx)).length, 0);
    assert.equal((await rec.getRecommendation(ana, daAna.id, tx)).id, daAna.id);
    await assert.rejects(rec.getRecommendation(ana, doBeto.id, tx), { code: 'AI_RECOMMENDATION_NOT_FOUND', statusCode: 404 });
    await assert.rejects(rec.listRecommendations(comPerm(ctxDe(tenantA), 'ai:use'), {}, tx), { code: 'PERMISSION_DENIED', statusCode: 403 });
    // O limite da lista é parâmetro da empresa.
    const ctx = ctxDe(tenantA);
    await upsertSetting('ia.recomendacao.lista_max_itens', 1, ctx, ctx.userId, tx);
    assert.equal((await rec.listRecommendations(auditor, {}, tx)).length, 1);
  });
});
