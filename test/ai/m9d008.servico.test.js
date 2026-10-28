'use strict';

// M9-D008 — conhecimento homologado e versionado: cadastro, versões, homologação por outra pessoa, revogação, imutabilidade e
// recusa de credencial. Roda com nayara_runtime (RLS real) em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../testHelpers');
const knowledge = require('../../src/modules/ai/knowledge');
const { sequelize, uid, q, run, carregarPessoas, ctxDe, prepararTenants, expectDbError } = require('../helpers/aiRuns');

let tenantA;
let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

async function rejeita(promessa, status, code) {
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
  return err;
}
const chave = () => `politica.desconto.${uid().slice(0, 8)}`;
const corpo = (factKey, extra = {}) => ({
  factKey, subjectType: 'politica', title: 'Desconto máximo', value: { percentualMaximo: 5 }, classification: 'INTERNAL', ...extra,
});

test('m9d008_homologacao_por_outra_pessoa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const autor = ctxDe(tenantA); const outra = ctxDe(tenantA);
    assert.notEqual(autor.userId, outra.userId);
    const e = await knowledge.createEntry(autor, corpo(chave()), tx);
    assert.equal(e.status, 'DRAFT'); assert.equal(e.version, 1); assert.equal(e.createdBy, autor.userId); assert.match(e.contentHash, /^[0-9a-f]{64}$/);
    const err = await rejeita(knowledge.homologate(autor, e.id, tx), 403, 'AI_KNOWLEDGE_SELF_HOMOLOGATION');
    assert.match(err.message, /Quem escreveu não pode homologar/);
    assert.equal((await knowledge.getEntry(autor, e.id, tx)).status, 'DRAFT');
    const ok = await knowledge.homologate(outra, e.id, tx);
    assert.equal(ok.status, 'HOMOLOGATED'); assert.equal(ok.homologatedBy, outra.userId); assert.ok(ok.homologatedAt); assert.equal(ok.isActive, true);
    // Repetir a homologação pela mesma pessoa devolve o estado atual (idempotente).
    assert.equal((await knowledge.homologate(outra, e.id, tx)).status, 'HOMOLOGATED');
    // O banco também recusa o autor como homologador, mesmo por SQL direto.
    const e2 = await knowledge.createEntry(autor, corpo(chave()), tx);
    await expectDbError(tx, "UPDATE ai.knowledge_entries SET status = 'HOMOLOGATED', homologated_by = :u, homologated_at = now() WHERE id = :id",
      { id: e2.id, u: autor.userId }, /AI_KNOWLEDGE_SELF_HOMOLOGATION/);
  });
});

test('m9d008_nova_versao_supersede_anterior', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const autor = ctxDe(tenantA); const aprovador = ctxDe(tenantA);
    const fk = chave();
    const v1 = await knowledge.createEntry(autor, corpo(fk, { value: { descontoMaximoPercentual: 5 } }), tx);
    await knowledge.homologate(aprovador, v1.id, tx);
    const v2 = await knowledge.createEntry(autor, corpo(fk, { value: { descontoMaximoPercentual: 7 } }), tx);
    assert.equal(v2.version, 2); assert.equal(v2.status, 'DRAFT');
    assert.notEqual(v2.contentHash, v1.contentHash);
    const h2 = await knowledge.homologate(aprovador, v2.id, tx);
    assert.equal(h2.status, 'HOMOLOGATED');
    const hist = await knowledge.listEntries(autor, { factKey: fk }, tx);
    assert.deepEqual(hist.map((x) => [x.version, x.status]), [[2, 'HOMOLOGATED'], [1, 'SUPERSEDED']], 'ambas no histórico');
    assert.equal(hist[1].isActive, false);
    const [{ n }] = await q("SELECT count(*)::int AS n FROM ai.knowledge_entries WHERE fact_key = :fk AND status = 'HOMOLOGATED'", { fk }, tx);
    assert.equal(n, 1);
    // Homologar uma versão mais velha com outra mais nova já homologada é recusado.
    const v3 = await knowledge.createEntry(autor, corpo(fk), tx);
    const v4 = await knowledge.createEntry(autor, corpo(fk), tx);
    await knowledge.homologate(aprovador, v4.id, tx);
    await rejeita(knowledge.homologate(aprovador, v3.id, tx), 409, 'AI_KNOWLEDGE_STALE_VERSION');
  });
});

test('m9d008_editar_homologada_bloqueado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const autor = ctxDe(tenantA); const aprovador = ctxDe(tenantA);
    const e = await knowledge.createEntry(autor, corpo(chave()), tx);
    const editada = await knowledge.updateDraft(autor, e.id, { title: 'Desconto máximo revisado', value: { percentualMaximo: 6 } }, tx);
    assert.equal(editada.title, 'Desconto máximo revisado'); assert.notEqual(editada.contentHash, e.contentHash);
    await knowledge.homologate(aprovador, e.id, tx);
    const err = await rejeita(knowledge.updateDraft(autor, e.id, { title: 'Outra' }, tx), 409, 'AI_KNOWLEDGE_IMMUTABLE');
    assert.match(err.message, /crie uma nova versão/);
    // O gatilho vale mesmo por SQL direto: conteúdo, classificação e vigência de HOMOLOGATED não mudam.
    for (const set of ["title = 'x'", "fact_value_json = '{}'::jsonb", "classification = 'PUBLIC'", "valid_until = now() + interval '1 day'", "content_hash = repeat('a', 64)"]) {
      await expectDbError(tx, `UPDATE ai.knowledge_entries SET ${set} WHERE id = :id`, { id: e.id }, /AI_KNOWLEDGE_IMMUTABLE/);
    }
    await expectDbError(tx, 'DELETE FROM ai.knowledge_entries WHERE id = :id', { id: e.id }, /AI_KNOWLEDGE_IMMUTABLE/);
    await expectDbError(tx, "UPDATE ai.knowledge_entries SET status = 'DRAFT' WHERE id = :id", { id: e.id }, /AI_KNOWLEDGE_TRANSITION/);
  });
});

test('m9d008_revogada_nao_reativa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const autor = ctxDe(tenantA); const aprovador = ctxDe(tenantA); const admin = ctxDe(tenantA);
    const e = await knowledge.createEntry(autor, corpo(chave()), tx);
    await rejeita(knowledge.revoke(admin, e.id, { reason: 'ainda é rascunho' }, tx), 409, 'AI_KNOWLEDGE_TRANSITION');
    await knowledge.homologate(aprovador, e.id, tx);
    await rejeita(knowledge.revoke(admin, e.id, {}, tx), 400, 'AI_KNOWLEDGE_INVALID');
    await rejeita(knowledge.revoke(admin, e.id, { reason: '   ' }, tx), 400, 'AI_KNOWLEDGE_INVALID');
    const r = await knowledge.revoke(admin, e.id, { reason: 'norma mudou' }, tx);
    assert.equal(r.status, 'REVOKED'); assert.equal(r.revokeReason, 'norma mudou'); assert.equal(r.revokedBy, admin.userId); assert.ok(r.revokedAt); assert.equal(r.isActive, false);
    await rejeita(knowledge.revoke(admin, e.id, { reason: 'de novo' }, tx), 409, 'AI_KNOWLEDGE_TRANSITION');
    await rejeita(knowledge.homologate(aprovador, e.id, tx), 409, 'AI_KNOWLEDGE_TRANSITION');
    await expectDbError(tx, "UPDATE ai.knowledge_entries SET status = 'HOMOLOGATED' WHERE id = :id", { id: e.id }, /AI_KNOWLEDGE_TRANSITION/);
    await expectDbError(tx, "UPDATE ai.knowledge_entries SET status = 'DRAFT' WHERE id = :id", { id: e.id }, /AI_KNOWLEDGE_TRANSITION/);
    await expectDbError(tx, "UPDATE ai.knowledge_entries SET title = 'x' WHERE id = :id", { id: e.id }, /AI_KNOWLEDGE_IMMUTABLE/);
    // Nova versão da revogada nasce em DRAFT e segue o ciclo normal.
    const v2 = await knowledge.createEntry(autor, corpo(e.factKey), tx);
    assert.equal(v2.version, 2); assert.equal(v2.status, 'DRAFT');
  });
});

test('m9d008_secret_detectado_recusado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const autor = ctxDe(tenantA);
    const segredos = [
      { value: { chave: 'AKIAIOSFODNN7EXAMPLE' } },
      { title: 'Procedimento com Bearer abcdefghijklmnopqrstuvwxyz0123456789' },
      { value: 'senha: SuperSecreta123' },
      { bodyStructured: { passos: ['use api_key=abcd1234efgh5678'] } },
      { value: '-----BEGIN PRIVATE KEY----- MIIE' },
    ];
    for (const extra of segredos) {
      const err = await rejeita(knowledge.createEntry(autor, corpo(chave(), extra), tx), 400, 'AI_KNOWLEDGE_SECRET_DETECTED');
      assert.match(err.message, /parece conter uma credencial/);
    }
    const ok = await knowledge.createEntry(autor, corpo(chave(), { value: { texto: 'Política de senha: trocar a cada 90 dias.' } }), tx);
    const err = await rejeita(knowledge.updateDraft(autor, ok.id, { value: { token: 'abcdef0123456789abcd' } }, tx), 400, 'AI_KNOWLEDGE_SECRET_DETECTED');
    assert.ok(err);
    const [{ n }] = await q("SELECT count(*)::int AS n FROM ai.knowledge_entries WHERE title LIKE 'Procedimento com Bearer%'", {}, tx);
    assert.equal(n, 0, 'nada ficou gravado');
  });
});

test('m9d008_empresa_b_nao_ve', async () => {
  let idA; const fk = chave();
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const e = await knowledge.createEntry(ctxDe(tenantA), corpo(fk), tx);
    idA = e.id;
    assert.equal((await knowledge.listEntries(ctxDe(tenantA), {}, tx)).some((x) => x.id === idA), true);
  });
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const b = ctxDe(tenantB);
    assert.deepEqual(await knowledge.listEntries(b, { factKey: fk }, tx), []);
    await rejeita(knowledge.getEntry(b, idA, tx), 404, 'AI_KNOWLEDGE_NOT_FOUND');
    await rejeita(knowledge.homologate(b, idA, tx), 404, 'AI_KNOWLEDGE_NOT_FOUND');
    await rejeita(knowledge.revoke(b, idA, { reason: 'x' }, tx), 404, 'AI_KNOWLEDGE_NOT_FOUND');
    // A mesma chave na empresa B é um fato independente, versão 1.
    assert.equal((await knowledge.createEntry(b, corpo(fk), tx)).version, 1);
  });
});

test('m9d008_validacoes_classificacao_obrigatoria_e_auditoria', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const autor = ctxDe(tenantA); const aprovador = ctxDe(tenantA);
    await rejeita(knowledge.createEntry(autor, { ...corpo(chave()), classification: undefined }, tx), 400, 'AI_KNOWLEDGE_INVALID');
    await rejeita(knowledge.createEntry(autor, corpo(chave(), { classification: 'SECRETO' }), tx), 400, 'AI_KNOWLEDGE_INVALID');
    await rejeita(knowledge.createEntry(autor, corpo('X'), tx), 400, 'AI_KNOWLEDGE_INVALID');
    await rejeita(knowledge.createEntry(autor, corpo(chave(), { validFrom: '2026-12-01', validUntil: '2026-11-01' }), tx), 400, 'AI_KNOWLEDGE_INVALID');
    await rejeita(knowledge.listEntries(autor, { status: 'QUALQUER' }, tx), 400, 'AI_KNOWLEDGE_INVALID');
    const e = await knowledge.createEntry(autor, corpo(chave(), { validFrom: '2026-01-01', validUntil: '2027-01-01', origin: 'manual' }), tx);
    await knowledge.homologate(aprovador, e.id, tx);
    await knowledge.revoke(ctxDe(tenantA), e.id, { reason: 'norma mudou' }, tx);
    const trilha = await q("SELECT action FROM audit.audit_log WHERE entity_type = 'AiKnowledgeEntry' AND entity_id = :id ORDER BY occurred_at, id", { id: e.id }, tx);
    assert.deepEqual(trilha.map((t) => t.action).sort(), ['ai.knowledge.created', 'ai.knowledge.homologated', 'ai.knowledge.revoked']);
    await run('SELECT 1', {}, tx);
  });
});
