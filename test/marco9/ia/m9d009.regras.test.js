'use strict';

// M9-D009 — quem grava o quê (a NAY só propõe), origem decidida por pessoa, procedimento de outra pessoa, RESTRICTED, idempotência
// e as travas do banco (nada se apaga, conteúdo imutável, expires_at obrigatório).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { sequelize, uid, q, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('../../helpers/aiRuns');
const { memoria, comPerm, NAY, dados, origemRun, origemRecomendacao, origemConhecimento, valorProcedimento, rejeita } = require('../_helpers/iaMemoria');
const { eventosDe } = require('../_helpers/iaRecomendacao');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const ana = () => comPerm(ctxDe(tenantA), 'ai:use');
const admin = () => comPerm(ctxDe(tenantA), 'ai:use', 'ai:admin');

test('m9d009_nay_so_propoe_e_grava_so_de_decisao_humana', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const nay = NAY(ctxDe(tenantA), 'ai:use');
    // Preferência e procedimento: a NAY não grava.
    await rejeita(memoria.save(nay, dados(run, { type: 'COMPANY_PREFERENCE', value: { preference: 'WhatsApp à tarde' } }), tx), 403, 'AI_MEMORY_HUMAN_REQUIRED');
    // Decisão e resultado: só a partir de recomendação que uma pessoa decidiu.
    await rejeita(memoria.save(nay, dados(run), tx), 403, 'AI_MEMORY_SOURCE_NOT_DECIDED');
    const decidida = await origemRecomendacao(tenantA, tx, ctxDe(tenantA));
    const d = await memoria.save(nay, dados(decidida, { sourceType: 'RECOMMENDATION' }), tx);
    assert.equal(d.memory.status, 'ACTIVE'); assert.equal(d.memory.createdBy, null);
    const r = await memoria.save(nay, dados(decidida, { type: 'RECOMMENDATION_OUTCOME', sourceType: 'RECOMMENDATION', value: { recommendation_id: decidida, outcome: 'ACCEPTED' } }), tx);
    assert.equal(r.memory.memoryType, 'RECOMMENDATION_OUTCOME');
    // Recomendação ainda pendente não vale como decisão humana.
    const rec = require('../../../src/features/ai/recommendations');
    const { dadosRec } = require('../_helpers/iaRecomendacao');
    const pendente = (await rec.createRecommendation(comPerm(ctxDe(tenantA), 'ai:use'), dadosRec(), tx)).recommendation.id;
    await rejeita(memoria.save(nay, dados(pendente, { sourceType: 'RECOMMENDATION' }), tx), 403, 'AI_MEMORY_SOURCE_NOT_DECIDED');
    // A NAY não invalida nem corrige: quem decide é gente.
    await rejeita(memoria.invalidate(nay, d.memory.id, { reason: 'a NAY não decide' }, tx), 403, 'AI_MEMORY_HUMAN_REQUIRED');
    // A proposta da NAY vira recomendação MEMORY_PROPOSAL (sem gravar nada em ai.memories) e se repete sem duplicar.
    const proposta = { agentCode: 'NAY_COMERCIAL', memory: { type: 'COMPANY_PREFERENCE', scope: 'COMPANY', value: { preference: 'Contato por WhatsApp à tarde' } } };
    const p1 = await memoria.propose(nay, proposta, tx);
    const p2 = await memoria.propose(nay, proposta, tx);
    assert.equal(p1.recommendation.recommendationType, 'MEMORY_PROPOSAL'); assert.equal(p1.recommendation.status, 'PENDING');
    assert.equal(p2.replayed, true); assert.equal(p2.recommendation.id, p1.recommendation.id);
    assert.equal((await eventosDe('ai.recommendation.created', p1.recommendation.id, tx)).length, 1);
    const [{ n }] = await q("SELECT count(*)::int AS n FROM ai.memories WHERE memory_type = 'COMPANY_PREFERENCE'", {}, tx);
    assert.equal(n, 0);
    // A pessoa com ai:admin grava citando a proposta como origem.
    const g = await memoria.save(admin(), dados(p1.recommendation.id, { type: 'COMPANY_PREFERENCE', sourceType: 'RECOMMENDATION', value: p1.recommendation.payload.memory.value }), tx);
    assert.equal(g.memory.value.preference, 'Contato por WhatsApp à tarde');
  });
});

test('m9d009_permissao_por_tipo_e_classificacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const sem = comPerm(ctxDe(tenantA), 'ai:read');
    await rejeita(memoria.save(sem, dados(run), tx), 403, 'PERMISSION_DENIED');
    await rejeita(memoria.save(ana(), dados(run, { type: 'COMPANY_PREFERENCE', value: { preference: 'x' } }), tx), 403, 'PERMISSION_DENIED');
    await rejeita(memoria.save(ana(), dados(run, { classification: 'RESTRICTED' }), tx), 403, 'PERMISSION_DENIED');
    await rejeita(memoria.save(ana(), dados(run, { classification: 'SECRETO' }), tx), 400, 'AI_MEMORY_INVALID');
    const r = (await memoria.save(admin(), dados(run, { classification: 'RESTRICTED', subjectId: 'rest' }), tx)).memory;
    // RESTRICTED só entra no contexto de quem tem ai:restricted.
    const alvo = { subject: { type: 'Property', id: 'rest' } };
    assert.equal((await memoria.recall(admin(), alvo, tx)).length, 0);
    assert.equal((await memoria.recall(comPerm(ctxDe(tenantA), 'ai:use', 'ai:restricted'), alvo, tx)).length, 1);
    await rejeita(memoria.get(ana(), r.id, tx), 404, 'AI_MEMORY_NOT_FOUND');
    // Quem grava decisão pode corrigi-la; preferência da empresa só o administrador.
    const dono = ana();
    const m = (await memoria.save(dono, dados(run), tx)).memory;
    await rejeita(memoria.invalidate(ana(), m.id, { reason: 'não é minha' }, tx), 403, 'PERMISSION_DENIED');
    const pref = (await memoria.save(admin(), dados(run, { type: 'COMPANY_PREFERENCE', value: { preference: 'x' } }), tx)).memory;
    await rejeita(memoria.invalidate(dono, pref.id, { reason: 'não posso' }, tx), 403, 'PERMISSION_DENIED');
    assert.equal((await memoria.invalidate(admin(), pref.id, { reason: 'o administrador pode' }, tx)).memory.status, 'INVALIDATED');
  });
});

test('m9d009_procedimento_homologado_por_outra_pessoa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const autor = admin(); const homologador = admin(); const outro = admin();
    const run = await origemRun(tenantA, tx);
    const proc = (origem, extra = {}) => dados(origem, { type: 'APPROVED_PROCEDURE', sourceType: 'KNOWLEDGE_ENTRY', value: valorProcedimento, ...extra });
    const conhecimento = await origemConhecimento(autor, homologador, tx);
    // Origem que não é conhecimento homologado.
    await rejeita(memoria.save(outro, proc(run, { sourceType: 'RUN' }), tx), 422, 'AI_MEMORY_SOURCE_NOT_HOMOLOGATED');
    // Quem escreveu o procedimento não o ativa como memória (aprovador distinto, parâmetro ligado por padrão).
    await rejeita(memoria.save(autor, proc(conhecimento), tx), 403, 'AI_MEMORY_SELF_ACTIVATION');
    const ok = await memoria.save(outro, proc(conhecimento), tx);
    assert.equal(ok.memory.value.steps.length, 2);
    // Desligado o parâmetro, o autor pode (a regra é da empresa).
    await upsertSetting('ia.aprovacao.aprovador_distinto', false, tenantA, autor.userId, tx);
    assert.equal((await memoria.save(autor, proc(conhecimento, { subjectId: 'outro' }), tx)).memory.status, 'ACTIVE');
    await rejeita(memoria.save(outro, proc(conhecimento, { value: { title: 't', steps: [] } }), tx), 400, 'AI_MEMORY_VALUE_INVALID');
  });
});

test('m9d009_idempotencia_nao_duplica', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const dono = ana();
    const chave = `k-${uid()}`;
    const a = await memoria.save(dono, dados(run, { idempotencyKey: chave }), tx);
    const b = await memoria.save(dono, dados(run, { idempotencyKey: chave, value: { decision: 'outro texto' } }), tx);
    assert.equal(a.replayed, false); assert.equal(b.replayed, true); assert.equal(b.memory.id, a.memory.id);
    const [{ n }] = await q('SELECT count(*)::int AS n FROM ai.memories WHERE idempotency_key = :k', { k: chave }, tx);
    assert.equal(n, 1);
    assert.equal((await q("SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_type = 'AiMemory' AND entity_id = :id", { id: a.memory.id }, tx))[0].n, 1);
  });
});

const insert = (extra = '', valores = '') => `INSERT INTO ai.memories (group_id, company_id, memory_type, scope, value, source_type, source_id${extra})
  VALUES (:g, :c, 'DECISION', 'COMPANY', '{"decision":"x"}', 'RUN', gen_random_uuid()${valores})`;

test('m9d009_expires_at_obrigatorio_no_banco', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const r = { g: tenantA.groupId, c: tenantA.companyId };
    await expectDbError(tx, insert(), r, /expires_at/);
    await expectDbError(tx, insert(', expires_at', ', NULL'), r, /expires_at/);
    await expectDbError(tx, insert(', expires_at, valid_from', ", now() - interval '1 day', now()"), r, /memories_validity_chk/);
    await expectDbError(tx, insert(', expires_at', ", now() + interval '1 day'").replace("'DECISION'", "'CHAT_HISTORY'"), r, /memories_type_chk/);
    await expectDbError(tx, insert(', expires_at', ", now() + interval '1 day'").replace("'COMPANY'", "'USER'"), r, /memories_owner_chk/);
    await sequelize.query(insert(', expires_at', ", now() + interval '1 day'"), { replacements: r, transaction: tx });
  });
});

test('m9d009_delete_bloqueado_por_trigger', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const run = await origemRun(tenantA, tx);
    const dono = ana();
    const m = (await memoria.save(dono, dados(run), tx)).memory;
    const err = await expectDbError(tx, 'DELETE FROM ai.memories WHERE id = :id', { id: m.id }, /AI_MEMORY_DELETE_FORBIDDEN/);
    assert.equal(err.parent.code, 'AI052');
    await expectDbError(tx, 'TRUNCATE ai.memories', {}, /AI_MEMORY_DELETE_FORBIDDEN|permission denied|must be owner/);
    // Conteúdo imutável; só o estado e a invalidação mudam.
    await expectDbError(tx, "UPDATE ai.memories SET value = '{\"decision\":\"trocado\"}' WHERE id = :id", { id: m.id }, /AI_MEMORY_IMMUTABLE/);
    await expectDbError(tx, "UPDATE ai.memories SET expires_at = expires_at + interval '1 day' WHERE id = :id", { id: m.id }, /AI_MEMORY_IMMUTABLE/);
    await expectDbError(tx, "UPDATE ai.memories SET status = 'INVALIDATED' WHERE id = :id", { id: m.id }, /memories_invalidation_chk/);
    assert.equal((await memoria.invalidate(dono, m.id, { reason: 'registro de teste' }, tx)).memory.status, 'INVALIDATED');
    const [{ n }] = await q('SELECT count(*)::int AS n FROM ai.memories WHERE id = :id', { id: m.id }, tx);
    assert.equal(n, 1);
  });
});
