'use strict';

// M9-D040 — as quatro capacidades do livro (OCR, classificação, extração e checagem) pelo orquestrador, com o provider sandbox: texto com a
// fonte do arquivo verificado, tipo sugerido com confiança, campos com posição e confiança e divergências apontadas sem corrigir. Tudo
// é sugestão: nada é gravado no cadastro. Banco descartável, role nayara_runtime, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const H = require('../_helpers/iaDocumental');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const NF = { fields: { valor_total: 1250, fornecedor: 'Ferragens Aurora' }, positions: { valor_total: { page: 1 } }, fieldConfidence: { valor_total: 0.97 } };

test('m9d040_ocr_transcribe_devolve_texto_com_fonte_do_arquivo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const pdf = await H.arquivoPdf(tenantA, tx, { linhas: ['COMPROVANTE DE RENDA', 'Holerite de setembro', 'Salario bruto 4500,00'] });
    const antes = await H.contagens(tx);
    const res = await H.rodar(c, `Transcreva o documento ${H.chamar('documents.transcribe', { fileId: pdf.id })} [[RESPOSTA:O documento fala de comprovante de renda e holerite de setembro [1].]]`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED');
    const [linha] = await H.chamadas(res.runId, tx);
    assert.deepEqual([linha.tool_name, linha.status], ['documents.transcribe', 'SUCCEEDED']);
    const fonte = res.sources.find((s) => s.title === 'documents.transcribe');
    assert.ok(fonte, 'a fonte da resposta é o resultado da transcrição');
    assert.match(fonte.excerpt, new RegExp(pdf.id), 'com a referência ao arquivo verificado');
    assert.match(fonte.excerpt, /COMPROVANTE DE RENDA/);
    assert.match(fonte.excerpt, /"scanStatus":"CLEAN"/);
    assert.deepEqual(await H.contagens(tx), antes, 'a transcrição não grava nada (nem cadastro, nem índice, nem recomendação)');
    // imagem: capacidade vision do provedor (sandbox), pelo orçamento do agente
    const img = await H.arquivoOcr(tenantA, tx, { fields: { name: 'Ana' } });
    const viaImagem = await H.rodar(c, `Transcreva a imagem ${H.chamar('documents.transcribe', { fileId: img.id })} [[RESPOSTA:Transcrição feita [1].]]`);
    assert.equal(viaImagem.ok, true, JSON.stringify(viaImagem.error));
    const src = viaImagem.sources.find((s) => s.title === 'documents.transcribe');
    assert.match(src.excerpt, /"method":"VISION"/);
    assert.match(src.excerpt, /Imagem de teste/);
    const gasto = await H.q("SELECT consumed_amount::text AS c FROM ai.budgets WHERE agent_code = 'NAY_DOCUMENTAL'", {}, tx);
    assert.notEqual(gasto[0].c, '0.000000', 'a chamada ao provedor passou pelo orçamento do agente');
    // áudio: capacidade transcribe do provedor; vídeo não é lido
    const audio = await H.enviar(tenantA, tx, { nome: 'audio.mp3', mime: 'audio/mpeg', buffer: Buffer.from('audio de teste') });
    const viaAudio = await H.rodar(c, `Transcreva o áudio ${H.chamar('documents.transcribe', { fileId: audio.id })} [[RESPOSTA:Áudio transcrito [1].]]`, { idempotencyKey: 'audio' });
    assert.match(viaAudio.sources.find((s) => s.title === 'documents.transcribe').excerpt, /"method":"TRANSCRIBE"/);
    const video = await H.enviar(tenantA, tx, { nome: 'video.mp4', mime: 'video/mp4', buffer: Buffer.from('video de teste') });
    const viaVideo = await H.rodar(c, `Transcreva o vídeo ${H.chamar('documents.transcribe', { fileId: video.id })} [[RESPOSTA:x]]`, { idempotencyKey: 'video' });
    assert.equal((await H.chamadas(viaVideo.runId, tx))[0].result_summary.error, 'AI_DOCUMENT_UNSUPPORTED');
  });
});

test('m9d040_classify_suggest_devolve_sugestao_com_confianca_sem_gravar', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const pdf = await H.arquivoPdf(tenantA, tx, { linhas: ['COMPROVANTE DE RENDA', 'Holerite do mes de setembro', 'Contracheque'] });
    const antes = await H.contagens(tx);
    const res = await H.rodar(c, `Classifique o documento ${H.chamar('documents.classifySuggest', { fileId: pdf.id })} [[RESPOSTA:O documento parece um comprovante de renda [1].]]`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const fonte = res.sources.find((s) => s.title === 'documents.classifySuggest');
    const dados = JSON.parse(fonte.excerpt.replace(/\.\.\.$/, ''));
    assert.equal(dados.suggestedType, 'COMPROVANTE_RENDA');
    assert.ok(dados.confidence > 0.5 && dados.confidence <= 1, `confiança ${dados.confidence}`);
    assert.equal(dados.persisted, false);
    assert.equal(dados.requiresHumanConfirmation, true);
    const depois = await H.contagens(tx);
    assert.equal(depois.pessoaDocumentos, antes.pessoaDocumentos, 'a classificação não é gravada no cadastro');
    assert.equal(depois.casoDocumentos, antes.casoDocumentos);
    assert.equal(depois.recomendacoes, antes.recomendacoes + 1, 'a sugestão vira UMA recomendação PENDING');
    const [rec] = await H.recomendacoesDe(pdf.id, tx);
    assert.deepEqual([rec.recommendation_type, rec.status, rec.agent_code, rec.related_entity_type], ['DOCUMENT_CLASSIFICATION', 'PENDING', 'NAY_DOCUMENTAL', 'FILE']);
    // texto sem nenhum termo do vocabulário: OTHER, confiança 0, nenhuma recomendação
    const solto = await H.arquivoPdf(tenantA, tx, { linhas: ['Receita de bolo de cenoura'] });
    const sem = await H.rodar(c, `Classifique ${H.chamar('documents.classifySuggest', { fileId: solto.id })} [[RESPOSTA:Não consegui sugerir um tipo [1].]]`);
    assert.equal(sem.ok, true, JSON.stringify(sem.error));
    assert.match(sem.sources.find((s) => s.title === 'documents.classifySuggest').excerpt, /"suggestedType":"OTHER","confidence":0/);
    assert.equal((await H.recomendacoesDe(solto.id, tx)).length, 0);
  });
});

test('m9d040_extract_fields_devolve_campos_com_fonte_e_confianca', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const nf = await H.arquivoOcr(tenantA, tx, NF);
    const antes = await H.contagens(tx);
    const res = await H.rodar(c, `Extraia os campos da nota ${H.chamar('documents.extractFields', { fileId: nf.id, documentType: 'INVOICE_NF' })} [[RESPOSTA:O valor total da nota é 1250.00, na página 1 [1].]]`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED');
    const dados = JSON.parse(res.sources.find((s) => s.title === 'documents.extractFields').excerpt.replace(/\.\.\.$/, ''));
    assert.equal(dados.kind, 'ProposedExtraction');
    assert.equal(dados.status, 'PROPOSED');
    const total = dados.fields.find((f) => f.name === 'valor_total');
    assert.deepEqual([total.value, total.confidence, total.source.fileId, total.source.page], ['1250.00', 0.97, nf.id, 1], 'valor_total = 1250.00 com confiança e posição (página 1)');
    assert.equal(dados.requiresHumanConfirmation, true);
    assert.equal(dados.persisted, false);
    const depois = await H.contagens(tx);
    assert.deepEqual({ ...depois, recomendacoes: 0 }, { ...antes, recomendacoes: 0 }, 'nada é gravado até um humano confirmar');
    assert.equal(depois.recomendacoes, antes.recomendacoes + 1, 'a sugestão vira recomendação PENDING');
    const [rec] = await H.recomendacoesDe(nf.id, tx);
    assert.equal(rec.recommendation_type, 'DOCUMENT_EXTRACTION');
    assert.equal(rec.status, 'PENDING');
    assert.equal(rec.target_user_id, c.auth.userId, 'dirigida a quem perguntou');
    // repetir a mesma sugestão no mesmo dia não duplica a recomendação
    await H.rodar(c, `De novo ${H.chamar('documents.extractFields', { fileId: nf.id, documentType: 'INVOICE_NF' })} [[RESPOSTA:Mesmo resultado [1].]]`, { idempotencyKey: 'outra-chamada' });
    assert.equal((await H.recomendacoesDe(nf.id, tx)).length, 1);
  });
});

test('m9d040_documento_ilegivel_gera_pendencia_e_nao_dado_inventado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const borrado = await H.arquivoIlegivel(tenantA, tx);
    const res = await H.rodar(c, `Extraia ${H.chamar('documents.extractFields', { fileId: borrado.id })} [[RESPOSTA:Não foi possível ler o documento [1].]]`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const dados = JSON.parse(res.sources.find((s) => s.title === 'documents.extractFields').excerpt.replace(/\.\.\.$/, ''));
    assert.equal(dados.status, 'ILLEGIBLE');
    assert.deepEqual(dados.fields, [], 'nenhum campo inventado');
    assert.match(dados.pending, /ilegível/i);
    assert.equal((await H.recomendacoesDe(borrado.id, tx)).length, 0);
    // confiança abaixo do mínimo (parâmetro ia.documental.confianca_minima, padrão 0,7) fica marcada
    const fraco = await H.arquivoOcr(tenantA, tx, { fields: { name: 'Ana' }, confidence: 0.6 });
    const baixo = await H.rodar(c, `Extraia ${H.chamar('documents.extractFields', { fileId: fraco.id })} [[RESPOSTA:Leitura com pouca confiança [1].]]`);
    assert.equal(JSON.parse(baixo.sources.find((s) => s.title === 'documents.extractFields').excerpt.replace(/\.\.\.$/, '')).status, 'LOW_CONFIDENCE');
    await upsertSetting('ia.documental.confianca_minima', 0.5, c.ctx, c.ctx.userId, tx);
    const ok = await H.rodar(c, `Extraia ${H.chamar('documents.extractFields', { fileId: fraco.id })} [[RESPOSTA:Leitura feita [1].]]`, { idempotencyKey: 'com-limiar-menor' });
    assert.equal(JSON.parse(ok.sources.find((s) => s.title === 'documents.extractFields').excerpt.replace(/\.\.\.$/, '')).status, 'PROPOSED');
  });
});

test('m9d040_check_consistency_aponta_divergencias_sem_corrigir', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx);
    const cnh = await H.arquivoOcr(tenantA, tx, { fields: { name: 'Ana Souza', issuedAt: '2030-05-01', expiresAt: '2025-01-01', taxId: '111.111.111-11' } });
    const antes = await H.contagens(tx);
    const res = await H.rodar(c, `Cheque ${H.chamar('documents.checkConsistency', { fileId: cnh.id, documentType: 'CNH', expected: { name: 'Ana Souza Lima' } })} [[RESPOSTA:Foram encontradas divergências no documento [1].]]`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const dados = JSON.parse(res.sources.find((s) => s.title === 'documents.checkConsistency').excerpt.replace(/\.\.\.$/, ''));
    assert.equal(dados.ok, false);
    assert.equal(dados.corrected, false, 'aponta, nunca corrige');
    assert.equal(dados.persisted, false);
    const codigos = dados.findings.map((f) => f.code);
    for (const esperado of ['INVALID_TAX_ID', 'INCONSISTENT_DATES', 'EXPIRED_DOCUMENT', 'DIVERGENT_FIELD']) assert.ok(codigos.includes(esperado), `${esperado} em ${codigos}`);
    const div = dados.findings.find((f) => f.code === 'DIVERGENT_FIELD');
    assert.deepEqual([div.field, div.found, div.expected], ['name', 'Ana Souza', 'Ana Souza Lima']);
    assert.deepEqual(await H.contagens(tx), antes, 'a checagem não grava nada');
    // campo obrigatório ausente (parâmetro ia.documental.campos_obrigatorios)
    const rg = await H.arquivoOcr(tenantA, tx, { fields: { observacao: 'sem nome' } });
    const falta = await H.rodar(c, `Cheque ${H.chamar('documents.checkConsistency', { fileId: rg.id, documentType: 'RG' })} [[RESPOSTA:Falta o nome [1].]]`);
    const faltas = JSON.parse(falta.sources.find((s) => s.title === 'documents.checkConsistency').excerpt.replace(/\.\.\.$/, '')).findings;
    assert.deepEqual(faltas.filter((f) => f.code === 'MISSING_FIELD').map((f) => f.field), ['name']);
    // documento coerente: nada a apontar
    const bom = await H.arquivoOcr(tenantA, tx, { fields: { name: 'Ana Souza', issuedAt: '2020-01-10', expiresAt: '2040-01-10' } });
    const limpo = await H.rodar(c, `Cheque ${H.chamar('documents.checkConsistency', { fileId: bom.id, documentType: 'CNH', expected: { name: 'ANA SOUZA' } })} [[RESPOSTA:Nenhuma divergência [1].]]`);
    const dadosBom = JSON.parse(limpo.sources.find((s) => s.title === 'documents.checkConsistency').excerpt.replace(/\.\.\.$/, ''));
    assert.deepEqual([dadosBom.ok, dadosBom.findings.length], [true, 0]);
  });
});
