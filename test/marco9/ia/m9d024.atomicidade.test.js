'use strict';

// M9-D024 — revogar a origem marca os chunks REVOKED na MESMA transação; busca concorrente vê o antes ou o depois, nunca meio a meio.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const knowledge = require('../../../src/features/ai/knowledge');
const { sequelize, uid, q, carregarPessoas, ctxDe, prepararTenants, comPerm, rag, servico } = require('../_helpers/ragEnv');
const { semear } = require('../_helpers/ragSeed');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const admin = () => comPerm(ctxDe(tenantA), 'ai:admin');
const estado = async (id, tx) => ({
  entrada: (await q('SELECT status, is_active FROM ai.knowledge_entries WHERE id = :id', { id }, tx))[0],
  chunks: (await q('SELECT status FROM ai.chunks WHERE source_id = :id ORDER BY chunk_index', { id }, tx)).map((c) => c.status),
});

async function homologada(tx) {
  const e = await knowledge.createEntry(admin(), { factKey: `politica.${uid().slice(0, 8)}`, subjectType: 'politica', title: 'Política de desconto', value: { regra: 'Desconto de até 5%' }, classification: 'INTERNAL' }, tx);
  await knowledge.homologate(comPerm(ctxDe(tenantA), 'ai:admin'), e.id, tx);
  await rag.processPending(comPerm(ctxDe(tenantA)), tx, { limit: 500 });
  return e;
}

test('m9d024_revogacao_marca_chunks_na_mesma_transacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const e = await homologada(tx);
    assert.ok((await estado(e.id, tx)).chunks.every((s) => s === 'ACTIVE') && (await estado(e.id, tx)).chunks.length >= 1);
    // Ponto de retorno: a revogação e a retirada dos chunks são uma unidade só; desfazer uma desfaz a outra.
    await q('SAVEPOINT antes_da_revogacao', {}, tx);
    await knowledge.revoke(comPerm(ctxDe(tenantA), 'ai:admin'), e.id, { reason: 'Política substituída pela diretoria.' }, tx);
    const revogada = await estado(e.id, tx);
    assert.equal(revogada.entrada.status, 'REVOKED');
    assert.ok(revogada.chunks.every((s) => s === 'REVOKED'), 'na mesma transação os chunks já saíram da busca');
    await q('ROLLBACK TO SAVEPOINT antes_da_revogacao', {}, tx);
    const desfeita = await estado(e.id, tx);
    assert.equal(desfeita.entrada.status, 'HOMOLOGATED');
    assert.ok(desfeita.chunks.every((s) => s === 'ACTIVE'), 'sem a revogação da origem, os chunks continuam ativos: nunca meio a meio');
    // Arquivo: a mesma garantia pela função de revogação da origem (`revokeSource`), também desfeita junto com a transação.
    const arquivo = await semear(tenantA, tx, { texto: 'Contrato Aurora: prazo de entrega de 90 dias.', sourceType: 'FILE' });
    await q('SAVEPOINT antes_do_arquivo', {}, tx);
    assert.equal(await rag.revokeSource(comPerm(ctxDe(tenantA)), 'FILE', arquivo.sourceId, tx), 1);
    assert.equal((await q('SELECT status FROM ai.chunks WHERE id = :id', { id: arquivo.id }, tx))[0].status, 'REVOKED');
    await q('ROLLBACK TO SAVEPOINT antes_do_arquivo', {}, tx);
    assert.equal((await q('SELECT status FROM ai.chunks WHERE id = :id', { id: arquivo.id }, tx))[0].status, 'ACTIVE');
  });
});

test('m9d024_revogar_origem_de_arquivo_ou_link_retira_os_chunks', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const arquivo = await semear(tenantA, tx, { texto: 'Contrato Aurora: prazo de entrega de 90 dias.', sourceType: 'FILE' });
    const outro = await semear(tenantA, tx, { texto: 'Contrato Aurora: prazo de entrega de 90 dias.', sourceType: 'URL' });
    assert.equal(await rag.revokeSource(comPerm(ctxDe(tenantA)), 'FILE', arquivo.sourceId, tx), 1);
    assert.equal(await rag.revokeSource(comPerm(ctxDe(tenantA)), 'FILE', arquivo.sourceId, tx), 0, 'repetir não muda nada');
    assert.deepEqual((await q('SELECT status FROM ai.chunks WHERE id = :id', { id: arquivo.id }, tx)).map((c) => c.status), ['REVOKED']);
    assert.deepEqual((await q('SELECT status FROM ai.chunks WHERE id = :id', { id: outro.id }, tx)).map((c) => c.status), ['ACTIVE'], 'outra origem não é tocada');
    await assert.rejects(rag.revokeSource(comPerm(ctxDe(tenantA)), 'QUALQUER', arquivo.sourceId, tx), { code: 'AI_RETRIEVAL_INVALID' });
    const busca = await servico.search({ ...ctxDe(tenantA), permissions: ['ai:use'] }, 'contrato Aurora prazo de entrega', {}, tx);
    assert.deepEqual(busca.items.map((i) => i.chunkId), [outro.id]);
  });
});
