'use strict';

// M9-D022 — conhecimento homologado (M9-D008) entra no índice de forma AUTOMÁTICA: a homologação cria a linha de ingestão na mesma
// transação, o job a leva a INDEXED e a revogação ou substituição retira os chunks.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const knowledge = require('../../../src/features/ai/knowledge');
const { runAiRagJob } = require('../../../src/engines/jobs/aiRagJob');
const { sequelize, uid, q, carregarPessoas, ctxDe, prepararTenants, comPerm, rag } = require('../_helpers/ragEnv');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const autor = () => comPerm(ctxDe(tenantA), 'ai:admin');
const homologador = () => comPerm(ctxDe(tenantA), 'ai:admin');
const novaEntrada = (ctx, tx, extra = {}) => knowledge.createEntry(ctx, {
  factKey: `politica.${uid().slice(0, 8)}`, subjectType: 'politica', title: 'Política de desconto', value: { regra: 'Desconto de até 5% na quitação antecipada', aprovador: 'diretoria' }, classification: 'INTERNAL', ...extra,
}, tx);
/** Roda a fila da empresa e devolve só o que é da entrada informada (a empresa pode ter ingestões pendentes de outros testes). */
const processarDe = async (id, tx) => (await rag.processPending(comPerm(ctxDe(tenantA)), tx, { limit: 500 })).filter((i) => i.sourceRef === id);
const linhas = (id, tx) => q("SELECT status, step, error_code, source_version, chunks_count FROM ai.ingestions WHERE source_kind = 'KNOWLEDGE_ENTRY' AND source_id = :id ORDER BY created_at", { id }, tx);
const chunks = (id, tx) => q('SELECT status, classification, required_permission, source_version FROM ai.chunks WHERE source_id = :id ORDER BY chunk_index', { id }, tx);

test('m9d022_knowledge_entry_homologada_gera_ingestao_automatica', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const entrada = await novaEntrada(autor(), tx);
    assert.deepEqual(await linhas(entrada.id, tx), [], 'rascunho não é ingerido');
    await knowledge.homologate(homologador(), entrada.id, tx);
    // Mesma transação, nenhum ato humano adicional: a linha PENDING já existe.
    const pendente = await linhas(entrada.id, tx);
    assert.equal(pendente.length, 1); assert.equal(pendente[0].status, 'PENDING'); assert.equal(pendente[0].source_version, entrada.version);
    assert.deepEqual(await chunks(entrada.id, tx), [], 'o job ainda não rodou');
    const feitos = await processarDe(entrada.id, tx);
    assert.equal(feitos.length, 1); assert.equal(feitos[0].status, 'INDEXED');
    const idx = await chunks(entrada.id, tx);
    assert.ok(idx.length >= 1 && idx.every((c) => c.status === 'ACTIVE' && c.classification === 'INTERNAL'));
    assert.equal((await processarDe(entrada.id, tx)).length, 0, 'repetir o job não duplica');
    // Revogar retira os chunks na mesma transação.
    await knowledge.revoke(homologador(), entrada.id, { reason: 'Política substituída pela diretoria.' }, tx);
    assert.ok((await chunks(entrada.id, tx)).every((c) => c.status === 'REVOKED'));
  });
});

test('m9d022_nova_versao_do_conhecimento_substitui_a_anterior_no_indice', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const v1 = await novaEntrada(autor(), tx);
    await knowledge.homologate(homologador(), v1.id, tx);
    await processarDe(v1.id, tx);
    const v2 = await knowledge.createEntry(autor(), { factKey: v1.factKey, subjectType: 'politica', title: 'Política de desconto', value: { regra: 'Desconto de até 3% na quitação antecipada' }, classification: 'INTERNAL' }, tx);
    await knowledge.homologate(homologador(), v2.id, tx);
    assert.ok((await chunks(v1.id, tx)).every((c) => c.status === 'SUPERSEDED'), 'a versão antiga sai da busca na própria homologação');
    await processarDe(v2.id, tx);
    assert.ok((await chunks(v2.id, tx)).every((c) => c.status === 'ACTIVE'));
  });
});

test('m9d022_job_do_rag_processa_a_fila_e_nao_derruba_empresa_com_conhecimento_revogado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const e = await novaEntrada(autor(), tx);
    await knowledge.homologate(homologador(), e.id, tx);
    await knowledge.revoke(homologador(), e.id, { reason: 'Revogada antes do job rodar.' }, tx);
    const [saida] = await processarDe(e.id, tx);
    assert.equal(saida.status, 'REJECTED', 'a entrada já não vale: a ingestão é encerrada sem indexar');
    assert.deepEqual(await chunks(e.id, tx), []);
  });
  assert.equal(typeof runAiRagJob, 'function');
});
