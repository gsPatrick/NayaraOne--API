'use strict';

// M9-D022 — duas conexões: a mesma ingestão pedida ao mesmo tempo resulta em UM índice só (trava por fonte + idempotência por hash e
// versão). Commita dados: só roda no cluster descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withTenantTransaction } = require('../../testHelpers');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants, comPerm, enviarPdf, ingerirArquivo, chunksDe } = require('../_helpers/ragEnv');

const SKIP = process.env.DISPOSABLE_DB === '1' ? false : 'precisa do cluster descartável (nunca commitar no banco do .env)';
// Os testes que COMMITAM usam a empresa B do seed: os de rollback (empresa A) nunca enxergam o que fica gravado aqui.
let tenantA;
before(async () => { ({ tenantB: tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const admin = () => comPerm(ctxDe(tenantA), 'ai:use', 'ai:admin');

test('m9d022_ingestao_concorrente_um_indice', { skip: SKIP }, async () => {
  const f = await withTenantTransaction(tenantA, (tx) => enviarPdf(tenantA, tx, { linhas: ['Política de reajuste anual dos aluguéis.', 'O índice contratual é aplicado no aniversário do contrato.'] }));
  const pedir = () => withTenantTransaction(tenantA, (tx) => ingerirArquivo(admin(), f.id, tx));
  const resultados = await Promise.all([pedir(), pedir(), pedir()]);
  assert.equal(new Set(resultados.map((r) => r.ingestion.id)).size, 1, 'as três ingestões são a mesma linha');
  assert.deepEqual(resultados.map((r) => r.replayed).sort(), [false, true, true]);
  const { linhas, chunks, ativos } = await withTenantTransaction(tenantA, async (tx) => ({
    linhas: await q("SELECT status, source_version FROM ai.ingestions WHERE source_id = :id", { id: f.id }, tx),
    chunks: await q('SELECT chunk_index, source_version FROM ai.chunks WHERE source_id = :id ORDER BY chunk_index', { id: f.id }, tx),
    ativos: await chunksDe(f.id, tx),
  }));
  assert.deepEqual(linhas.map((l) => [l.status, l.source_version]), [['INDEXED', 1]]);
  assert.equal(chunks.length, resultados[0].ingestion.chunksCount, 'um conjunto de chunks só');
  assert.equal(ativos.length, chunks.length);
});

test('m9d022_reindexacao_concorrente_cria_uma_versao_so', { skip: SKIP }, async () => {
  const f = await withTenantTransaction(tenantA, (tx) => enviarPdf(tenantA, tx, { linhas: ['Cláusula de multa por rescisão antecipada.', 'A multa é proporcional ao prazo restante do contrato.'] }));
  await withTenantTransaction(tenantA, (tx) => ingerirArquivo(admin(), f.id, tx));
  const reindexar = () => withTenantTransaction(tenantA, (tx) => ingerirArquivo(admin(), f.id, tx, { reindex: true }));
  const [a, b] = await Promise.all([reindexar(), reindexar()]);
  assert.deepEqual([a.ingestion.sourceVersion, b.ingestion.sourceVersion].sort(), [2, 3], 'cada pedido de reindexação explícito vira uma versão, sem colisão');
  const estados = await withTenantTransaction(tenantA, (tx) => q('SELECT source_version, status, count(*)::int AS n FROM ai.chunks WHERE source_id = :id GROUP BY 1, 2 ORDER BY 1', { id: f.id }, tx));
  assert.deepEqual(estados.map((e) => [e.source_version, e.status]), [[1, 'SUPERSEDED'], [2, 'SUPERSEDED'], [3, 'ACTIVE']], 'só a última versão fica ACTIVE');
});
