'use strict';

// M9-D022 — pipeline seguro de ingestão para o RAG: malware, classificação, RESTRICTED, segredos, idempotência por hash e conteúdo ativo.
// Tudo roda com nayara_runtime (RLS real) em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { File } = require('../../../src/models');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants, comPerm, enviarPdf, ingerirArquivo, chunksDe, rag, DOCX } = require('../_helpers/ragEnv');
const { montarPdf, montarDocx, segredos } = require('../_helpers/ragDocs');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const admin = () => comPerm(ctxDe(tenantA), 'ai:use', 'ai:admin');
const linhaDe = (id, tx) => q('SELECT * FROM ai.ingestions WHERE id = :id', { id }, tx).then((r) => r[0]);

test('m9d022_arquivo_infectado_rejeitado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const infectado = await enviarPdf(tenantA, tx);
    await File.update({ scanStatus: 'INFECTED' }, { where: { id: infectado.id }, transaction: tx });
    const naoVerificado = await enviarPdf(tenantA, tx);
    await File.update({ scanStatus: null }, { where: { id: naoVerificado.id }, transaction: tx });
    for (const f of [infectado, naoVerificado]) {
      const out = await ingerirArquivo(admin(), f.id, tx);
      assert.equal(out.ingestion.status, 'REJECTED'); assert.equal(out.ingestion.errorCode, 'AI_INGEST_MALWARE'); assert.equal(out.ingestion.step, 'SCAN');
      assert.equal((await linhaDe(out.ingestion.id, tx)).status, 'REJECTED', 'a recusa fica gravada');
      assert.equal((await chunksDe(f.id, tx)).length, 0, 'nada indexado');
    }
    const err = rag.rejectionError('AI_INGEST_MALWARE', 'x');
    assert.equal(err.statusCode, 422); assert.equal(err.message, 'O arquivo foi rejeitado pela verificação de segurança.');
  });
});

test('m9d022_sem_classificacao_recusado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // M9-D920: a classe do arquivo é obrigatória (padrão HIGH, conservador): o arquivo enviado sem classe expressa NASCE classificado e entra no índice com a classe HIGH
    // (CONFIDENTIAL na visão antiga da NAY); quem tem governance:classification:manage ajusta e a reindexação leva a nova classe (nova versão).
    const f = await enviarPdf(tenantA, tx, { classificacao: null, linhas: ['Contrato de locação do Edifício Aurora.'] });
    const first = await ingerirArquivo(admin(), f.id, tx);
    assert.equal(first.ingestion.status, 'INDEXED'); assert.equal(first.ingestion.classification, 'CONFIDENTIAL', 'HIGH, a classe que o upload deu');
    // Fonte sem classe nenhuma (URL sem classificação) continua recusada: a NAY não adivinha.
    assert.equal(rag.rejectionError('AI_INGEST_UNCLASSIFIED', 'x').message, 'Classifique o documento antes de indexá-lo.');
    // Mudar a classe é registrar a nova (a reconciliação da M9-D023 leva a classe aos trechos já indexados; o conteúdo igual não gera outra versão).
    const novo = await rag.classifyFile(admin(), f.id, { classification: 'INTERNAL' }, tx);
    assert.equal(novo.classification, 'INTERNAL');
    const again = await ingerirArquivo(admin(), f.id, tx);
    assert.equal(again.ingestion.status, 'INDEXED'); assert.equal(again.ingestion.sourceVersion, 1, 'mesmo conteúdo: a mesma versão');
  });
});

test('m9d022_restricted_nao_indexa_por_padrao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const f = await enviarPdf(tenantA, tx, { classificacao: 'RESTRICTED', linhas: ['Prontuário de renda do cliente.'] });
    const out = await ingerirArquivo(admin(), f.id, tx);
    assert.equal(out.ingestion.status, 'REJECTED'); assert.equal(out.ingestion.errorCode, 'AI_INGEST_RESTRICTED_BLOCKED');
    assert.equal((await chunksDe(f.id, tx)).length, 0, 'AI-011: RESTRICTED fora do índice por padrão');
    await upsertSetting('ia.rag.indexar_restricted', true, admin(), admin().userId, tx);
    const ligado = await ingerirArquivo(admin(), f.id, tx);
    assert.equal(ligado.ingestion.status, 'INDEXED');
    assert.ok((await chunksDe(f.id, tx)).every((c) => c.classification === 'RESTRICTED'));
  });
});

test('m9d022_segredo_no_documento_nao_e_indexado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const normal = ['Procedimento de fechamento do mês da imobiliária.', 'Conciliar o banco antes de conferir as baixas de cada contrato.', 'O responsável financeiro revisa os lançamentos pendentes.', 'Os repasses aos proprietários saem depois da conferência.'];
    const linhas = [...normal, ...segredos.chavePrivada().split('\n'), 'Conferir as baixas e fechar o caixa.'];
    const f = await enviarPdf(tenantA, tx, { linhas });
    const out = await ingerirArquivo(admin(), f.id, tx);
    assert.equal(out.ingestion.status, 'INDEXED'); assert.equal(out.ingestion.secretsRemoved, 1, 'a chave privada conta uma remoção');
    const texto = (await chunksDe(f.id, tx)).map((c) => c.content_redacted).join('\n');
    assert.ok(/fechamento do m/.test(texto) && /fechar o caixa/.test(texto), 'o resto do documento é indexado');
    assert.ok(!/PRIVATE KEY|fakefake|MIIEow/.test(texto), 'a chave privada não está em nenhum chunk');
    const outros = await enviarPdf(tenantA, tx, { linhas: [...normal, 'Notas da migração dos sistemas antigos para o novo ERP.', segredos.chaveAws(), segredos.conexao(), segredos.senha(), 'Fim.'] });
    const o2 = await ingerirArquivo(admin(), outros.id, tx);
    assert.equal(o2.ingestion.status, 'INDEXED'); assert.equal(o2.ingestion.secretsRemoved, 3);
    const t2 = (await chunksDe(outros.id, tx)).map((c) => c.content_redacted).join('\n');
    assert.ok(!/AKIA|app_user|Troque-Me/.test(t2));
    // Documento majoritariamente de segredos é rejeitado.
    const quase = await enviarPdf(tenantA, tx, { linhas: [segredos.chaveAws(), segredos.conexao(), segredos.senha(), 'ok'] });
    const o3 = await ingerirArquivo(admin(), quase.id, tx);
    assert.equal(o3.ingestion.status, 'REJECTED'); assert.equal(o3.ingestion.errorCode, 'AI_INGEST_SECRETS');
    assert.equal((await chunksDe(quase.id, tx)).length, 0);
  });
});

test('m9d022_mesmo_hash_nao_reindexa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const f = await enviarPdf(tenantA, tx, { linhas: ['Regulamento interno do condomínio.', 'Silêncio após as 22 horas.'] });
    const a = await ingerirArquivo(admin(), f.id, tx);
    const b = await ingerirArquivo(admin(), f.id, tx);
    assert.equal(a.replayed, false); assert.equal(b.replayed, true); assert.equal(b.ingestion.id, a.ingestion.id);
    assert.equal((await q("SELECT count(*)::int AS n FROM ai.ingestions WHERE source_id = :id", { id: f.id }, tx))[0].n, 1, 'reenvio igual não cria linha');
    const antes = await chunksDe(f.id, tx);
    assert.equal(antes.length, a.ingestion.chunksCount);
    // Reindexação pedida: nova versão, a anterior vira SUPERSEDED na mesma transação e a busca vê uma versão ACTIVE só.
    const c = await ingerirArquivo(admin(), f.id, tx, { reindex: true });
    assert.equal(c.replayed, false); assert.equal(c.ingestion.sourceVersion, 2);
    assert.deepEqual([...new Set((await chunksDe(f.id, tx)).map((x) => x.source_version))], [2]);
    assert.equal((await chunksDe(f.id, tx, 'SUPERSEDED')).length, antes.length);
    assert.equal(c.ingestion.contentHash, a.ingestion.contentHash);
  });
});

test('m9d022_conteudo_ativo_descartado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const pdf = await enviarPdf(tenantA, tx, { buffer: montarPdf(['Manual de procedimentos da portaria.'], { js: true, flate: true }) });
    const p = await ingerirArquivo(admin(), pdf.id, tx);
    assert.equal(p.ingestion.status, 'INDEXED'); assert.ok(p.ingestion.activeContentDiscarded >= 1, 'JavaScript e abertura automática contados');
    const docx = await enviarPdf(tenantA, tx, { buffer: montarDocx([{ titulo: 'Rotina da obra' }, 'Registrar o diário todos os dias.'], { macro: true, objeto: true }), mime: DOCX, nome: 'rotina.docx' });
    const d = await ingerirArquivo(admin(), docx.id, tx);
    assert.equal(d.ingestion.status, 'INDEXED'); assert.ok(d.ingestion.activeContentDiscarded >= 2, 'macro e objeto incorporado contados');
    for (const id of [pdf.id, docx.id]) {
      const texto = (await chunksDe(id, tx)).map((c) => c.content_redacted).join('\n');
      assert.ok(!/EXECUTAR_|app\.alert|AutoOpen|OBJETO_INCORPORADO/.test(texto), 'nada do conteúdo ativo vai ao índice');
    }
    assert.match((await chunksDe(pdf.id, tx))[0].content_redacted, /portaria/);
    assert.match((await chunksDe(docx.id, tx))[0].content_redacted, /^Rotina da obra\n/, 'o título abre o chunk');
  });
});
