'use strict';

// M9-D023 — chunks: metadados obrigatórios (nenhum chunk sem eles é gravado), tamanho e sobreposição configuráveis, top_k e rerank
// determinísticos. Roda com nayara_runtime (RLS real), em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { rerank } = require('../../../src/features/ai/retrieval/rerank');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants, comPerm, servico, enviarPdf, ingerirArquivo, chunksDe, rag, rejeita } = require('../_helpers/ragEnv');
const { semear } = require('../_helpers/ragSeed');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const ator = (...perms) => comPerm(ctxDe(tenantA), ...perms);
const admin = () => ator('ai:use', 'ai:admin');
const palavras = (n, prefixo = 'palavra') => Array.from({ length: n }, (_, i) => `${prefixo}${i}`).join(' ');

test('m9d023_chunk_sem_metadados_nao_grava', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const f = await enviarPdf(tenantA, tx, { linhas: ['Contrato de locação do Edifício Aurora, cláusula primeira.'] });
    const ok = await ingerirArquivo(admin(), f.id, tx);
    assert.equal(ok.ingestion.status, 'INDEXED');
    // Todo chunk gravado tem os seis metadados do livro.
    const gravados = await chunksDe(f.id, tx);
    assert.ok(gravados.length >= 1);
    for (const c of gravados) {
      for (const campo of ['source_id', 'source_version', 'company_id', 'classification', 'effective_from', 'required_permission']) assert.ok(c[campo] !== null && c[campo] !== '', campo);
      assert.equal(c.company_id, tenantA.companyId); assert.equal(c.classification, 'INTERNAL'); assert.equal(c.source_version, 1);
    }
    // A gravação recusa o chunk sem cada um dos metadados e não deixa nada pela metade.
    const base = { id: ok.ingestion.id, sourceKind: 'FILE', sourceId: f.id, sourceVersion: 2, classification: 'INTERNAL' };
    const meta = { effectiveFrom: new Date(), effectiveUntil: null, requiredPermission: 'ai:use', ownerScope: 'COMPANY' };
    const pedacos = [{ index: 0, text: 'texto', tokens: 1 }]; const vetores = [{ embedding: [1, 0], norm: 1 }];
    const antes = (await q('SELECT count(*)::int AS n FROM ai.chunks', {}, tx))[0].n;
    const casos = [
      ['source_id', { ...base, sourceId: null }, meta], ['source_version', { ...base, sourceVersion: null }, meta], ['classification', { ...base, classification: null }, meta],
      ['classification', { ...base, classification: 'SECRETO' }, meta], ['effective_from', base, { ...meta, effectiveFrom: null }], ['effective_from', base, { ...meta, effectiveFrom: 'ontem' }],
      ['required_permission', base, { ...meta, requiredPermission: '' }],
    ];
    for (const [campo, ing, m] of casos) {
      const err = await rag.writeChunks(tenantA, ing, m, pedacos, vetores, 'm', tx).then(() => null, (e) => e);
      assert.ok(err && err.code === 'CHUNK_METADATA_MISSING' && err.field === campo, `${campo}: ${err && err.message}`);
    }
    assert.throws(() => rag.assertChunkMetadata({ sourceId: 'x', sourceVersion: 1, companyId: null, classification: 'INTERNAL', effectiveFrom: new Date(), requiredPermission: 'ai:use' }), { field: 'company_id' });
    assert.equal((await q('SELECT count(*)::int AS n FROM ai.chunks', {}, tx))[0].n, antes, 'nenhum chunk gravado pelas tentativas recusadas');
    // O banco também recusa (defesa em profundidade): sem classificação ou vigência a linha não entra.
    for (const coluna of ['classification', 'effective_from', 'required_permission', 'source_id']) {
      await tx.sequelize.query('SAVEPOINT s', { transaction: tx });
      const sql = `INSERT INTO ai.chunks (group_id, company_id, ingestion_id, source_id, source_type, source_version, chunk_index, content_redacted, content_hash, tokens_count, classification, effective_from, required_permission, embedding, embedding_norm, embedding_model)
        SELECT group_id, company_id, ingestion_id, ${coluna === 'source_id' ? 'NULL' : 'source_id'}, source_type, 9, 0, 'x', content_hash, 1, ${coluna === 'classification' ? 'NULL' : 'classification'}, ${coluna === 'effective_from' ? 'NULL' : 'effective_from'}, ${coluna === 'required_permission' ? 'NULL' : 'required_permission'}, embedding, embedding_norm, embedding_model FROM ai.chunks LIMIT 1`;
      await assert.rejects(tx.sequelize.query(sql, { transaction: tx }), /null value|violates/, coluna);
      await tx.sequelize.query('ROLLBACK TO SAVEPOINT s', { transaction: tx });
    }
    // Conteúdo imutável e nada se apaga.
    await assert.rejects(tx.sequelize.query("UPDATE ai.chunks SET content_redacted = 'outro' WHERE source_id = :id", { replacements: { id: f.id }, transaction: tx }), /AI_CHUNK_IMMUTABLE/);
  });
});

test('m9d023_chunking_respeita_tamanho_sobreposicao_e_titulos', async () => {
  const { chunkText } = rag;
  const texto = `# Cláusula primeira\n${palavras(250, 'a')}\n# Cláusula segunda\n${palavras(30, 'b')}`;
  const chunks = chunkText(texto, { chunkTokens: 100, chunkOverlap: 20 });
  const primeira = chunks.filter((c) => c.text.startsWith('Cláusula primeira'));
  const segunda = chunks.filter((c) => c.text.startsWith('Cláusula segunda'));
  assert.equal(segunda.length, 1, 'seção curta: um chunk, e ele não se mistura com a anterior');
  assert.ok(primeira.length >= 3, 'seção longa: vários chunks, cada um repetindo o título');
  assert.ok(chunks.every((c) => c.tokens <= 100), 'nenhum chunk passa de chunk_tokens');
  assert.ok(!segunda[0].text.includes('a10'), 'o bloco não atravessa o título');
  const corpo = (c) => c.text.split('\n')[1].split(' ');
  assert.deepEqual(corpo(primeira[0]).slice(-20), corpo(primeira[1]).slice(0, 20), 'sobreposição de 20 tokens entre vizinhos');
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
  // Parâmetros por empresa: chunk_tokens e chunk_overlap mudam o resultado do pipeline.
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const f = await enviarPdf(tenantA, tx, { linhas: Array.from({ length: 12 }, (_, i) => palavras(40, `p${i}x`)) });
    await upsertSetting('ia.rag.chunk_tokens', 120, admin(), admin().userId, tx);
    await upsertSetting('ia.rag.chunk_overlap', 10, admin(), admin().userId, tx);
    const out = await ingerirArquivo(admin(), f.id, tx);
    const tokens = (await chunksDe(f.id, tx)).map((c) => c.tokens_count);
    assert.ok(tokens.length >= 4 && tokens.every((n) => n <= 120), JSON.stringify(tokens));
    assert.equal(out.ingestion.chunksCount, tokens.length);
  });
});

test('m9d023_top_k_e_rerank_deterministicos', async () => {
  // Rerank puro: ordem total (relevância, versão mais nova, classe menos sensível, id), qualquer que seja a ordem de entrada.
  const c = (id, relevance, sourceVersion = 1, classification = 'INTERNAL') => ({ id, relevance, sourceVersion, classification });
  const entrada = [c('d', 0.5), c('c', 0.5, 2), c('b', 0.5, 2, 'PUBLIC'), c('a', 0.5, 2, 'PUBLIC'), c('e', 0.9), c('f', 0.500001)];
  const esperado = ['e', 'a', 'b', 'c', 'f', 'd'].filter((x) => x !== 'f'); // f (0.500001) empata com 0.5 após o arredondamento de 5 casas
  const ordem = (lista) => rerank(lista).map((x) => x.id);
  const base = ordem(entrada);
  assert.deepEqual(base.slice(0, 1), ['e']);
  assert.deepEqual(base.filter((x) => x !== 'f'), esperado);
  for (let i = 0; i < 20; i += 1) assert.deepEqual(ordem([...entrada].sort(() => Math.random() - 0.5)), base, 'a ordem de chegada não muda o resultado');
  // Ponta a ponta: top_k limita os candidatos, contexto_max_chunks limita a resposta, e a mesma consulta dá sempre a mesma lista.
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const todos = [];
    for (let i = 0; i < 8; i += 1) todos.push((await semear(tenantA, tx, { texto: `Cláusula de reajuste ${'anual '.repeat(i + 1)}do contrato Aurora`, chunkIndex: i })).id);
    await upsertSetting('ia.rag.top_k', 5, admin(), admin().userId, tx);
    await upsertSetting('ia.rag.contexto_max_chunks', 3, admin(), admin().userId, tx);
    const consulta = 'cláusula de reajuste anual contrato Aurora';
    const candidatos = await servico.candidates(ator('ai:use'), consulta, {}, await rag.readRagParams(ator('ai:use'), tx), tx);
    assert.equal(candidatos.length, 5, 'top_k');
    const a = await servico.search(ator('ai:use'), consulta, {}, tx);
    const b = await servico.search(ator('ai:use'), consulta, {}, tx);
    assert.equal(a.items.length, 3, 'contexto_max_chunks');
    assert.deepEqual(a, b, 'determinístico');
    assert.deepEqual(a.items.map((i) => i.chunkId), rerank(candidatos).slice(0, 3).map((x) => x.id));
    assert.ok(a.items.every((i, k, l) => k === 0 || l[k - 1].relevanceScore >= i.relevanceScore), 'da mais para a menos relevante');
    assert.ok(a.items.every((i) => i.relevanceScore >= 0 && i.relevanceScore <= 1 && i.untrusted === true && todos.includes(i.chunkId)));
    assert.equal((await servico.search(ator('ai:use'), consulta, { limit: 1 }, tx)).items.length, 1);
    await rejeita(servico.search(ator('ai:use'), '   ', {}, tx), 400, 'AI_RETRIEVAL_INVALID');
  });
});
