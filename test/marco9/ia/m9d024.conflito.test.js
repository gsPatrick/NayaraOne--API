'use strict';

// M9-D024 — conflito entre fontes vigentes: só se compara o que tem chave de assunto; a resposta traz o bloco de divergência e não escolhe uma.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const knowledge = require('../../../src/features/ai/knowledge');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { detectConflicts } = require('../../../src/features/ai/retrieval');
const { normalizeValue, declaredFacts } = require('../../../src/features/ai/retrieval/facts');
const { RAG, resposta, trecho, registro, H } = require('../_helpers/iaVigencia');
const { servico, ctxDe, comPerm, carregarPessoas, uid } = require('../_helpers/ragEnv');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const PERGUNTA = 'qual o prazo de entrega do contrato Aurora?';
const A = 'Contrato Aurora versão A: prazo de entrega informado.\nFato: prazo_entrega_dias = 60';
const B = 'Contrato Aurora versão B: prazo de entrega informado.\nFato: prazo_entrega_dias = 90';

test('m9d024_conflito_e_explicitado_sem_escolher', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: RAG });
    const a = await trecho(tenantA, tx, A);
    const b = await trecho(tenantA, tx, B, { version: 3 });
    const res = await H.rodar(c, `${PERGUNTA} ${resposta('O prazo de entrega é de 60 dias [1]. O contrato Aurora tem prazo de entrega informado [2].')}`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'CONFLICTING_SOURCES');
    assert.match(res.answer, /Atenção: as fontes consultadas divergem\./);
    assert.match(res.answer, /prazo_entrega_dias/);
    for (const [fonte, valor, versao] of [[a, '60', '1'], [b, '90', '3']]) {
      const ref = res.sources.findIndex((s) => s.version === versao) + 1;
      assert.ok(ref >= 1 && fonte.sourceId, 'a fonte está entre as citadas');
      assert.match(res.answer, new RegExp(`versão ${versao}[^\\n]*: ${valor} \\[${ref}\\]`), `${valor} listado com versão, vigência e marcador`);
    }
    assert.match(res.answer, /vigente desde/);
    // A resposta não escolhe um lado: a frase que afirmava só o 60 saiu do texto; sobra o bloco com as duas fontes.
    assert.doesNotMatch(res.answer.split('Atenção')[0], /60 dias/);
    assert.deepEqual((await registro(res.runId, tx)).map((l) => [l.usada, l.estado]), [[true, 'VIGENTE'], [true, 'VIGENTE']]);
  });
});

test('m9d024_conhecimento_homologado_contra_documento_com_o_mesmo_fato', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: RAG });
    const chave = `politica.${uid().slice(0, 8)}`;
    const entrada = await knowledge.createEntry(comPerm(ctxDe(tenantA), 'ai:admin'), { factKey: chave, subjectType: 'politica', title: 'Política de desconto', value: { valor: '7%' }, classification: 'INTERNAL' }, tx);
    await knowledge.homologate(comPerm(ctxDe(tenantA), 'ai:admin'), entrada.id, tx);
    await require('../../../src/features/ai/retrieval').processPending(comPerm(ctxDe(tenantA)), tx, { limit: 500 });
    await trecho(tenantA, tx, `Política de desconto antiga em planilha: o desconto máximo foi informado.\nFato: ${chave} = 10%`);
    const achados = await servico.search({ ...ctxDe(tenantA), permissions: ['ai:use'] }, 'política de desconto desconto máximo', {}, tx);
    assert.equal(achados.conflicts.length, 1);
    assert.equal((await servico.search({ ...ctxDe(tenantA), permissions: ['ai:use'] }, 'política de desconto desconto máximo', { limit: 1 }, tx)).conflicts.length, 1, 'as fontes em divergência entram mesmo acima do limite de trechos');
    assert.deepEqual(achados.conflicts[0].versions.map((v) => v.value).sort(), ['10%', '7%']);
    assert.equal(achados.conflicts[0].label, chave);
    const res = await H.rodar(c, `política de desconto desconto máximo ${resposta('Há uma política de desconto [1].')}`);
    assert.equal(res.groundingStatus, 'CONFLICTING_SOURCES');
    assert.match(res.answer, /Política de desconto, versão 1[^\n]*: 7%/);
  });
});

test('m9d024_sem_chave_de_assunto_nao_ha_conflito', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: RAG });
    await trecho(tenantA, tx, 'Contrato Aurora versão A: o prazo de entrega é de 60 dias.');
    await trecho(tenantA, tx, 'Contrato Aurora versão B: o prazo de entrega é de 90 dias.');
    const res = await H.rodar(c, `${PERGUNTA} ${resposta('O contrato Aurora tem prazo de entrega [1].')}`);
    assert.equal(res.groundingStatus, 'GROUNDED', 'números sem chave de assunto não são comparados');
    assert.doesNotMatch(res.answer, /divergem/);
    // Mesmo valor escrito de outro jeito, ou fatos de chaves diferentes: também não diverge.
    await trecho(tenantA, tx, 'Contrato Beta: prazo de entrega informado.\nFato: prazo_entrega_dias = 60,0');
    await trecho(tenantA, tx, 'Contrato Beta, aditivo: prazo de entrega informado.\nFato: prazo_entrega_dias = 60.');
    await trecho(tenantA, tx, 'Contrato Beta, anexo: prazo de entrega informado.\nFato: prazo_garantia_dias = 90');
    const beta = await H.rodar(c, `prazo de entrega do contrato Beta ${resposta('O contrato Beta tem prazo de entrega [1].')}`);
    assert.equal(beta.groundingStatus, 'GROUNDED');
  });
});

test('m9d024_lista_do_rag_alimenta_o_validate_grounding', async () => {
  const { validateGrounding } = require('../../../src/features/ai/orchestrator/groundingValidator');
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const a = await trecho(tenantA, tx, A);
    const b = await trecho(tenantA, tx, B, { version: 3 });
    const achados = await servico.search({ ...ctxDe(tenantA), permissions: ['ai:use'] }, PERGUNTA, {}, tx);
    assert.equal(achados.conflicts.length, 1);
    const [conflito] = achados.conflicts;
    assert.deepEqual(conflito.versions.map((v) => [v.sourceRef, v.version, v.value]).sort(), [[a.sourceId, 1, '60'], [b.sourceId, 3, '90']].sort());
    assert.ok(conflito.versions.every((v) => v.effectiveFrom && v.title), 'cada versão traz título e vigência');
    // A lista produzida pela busca é a que o validador (D025) recebe, sem nenhuma conversão.
    const fontes = achados.items.map((i, n) => ({ sourceType: 'DOCUMENT_CHUNK', sourceRef: i.sourceId, title: `Contrato ${n + 1}`, version: i.sourceVersion, excerpt: i.content, relevanceScore: 0.9, effectiveFrom: i.effectiveFrom, classification: i.classification }));
    const saida = validateGrounding({ answerText: 'O contrato Aurora informa o prazo de entrega [1].', taskType: 'consulta', sources: fontes, conflicts: achados.conflicts }, {});
    assert.equal(saida.groundingStatus, 'CONFLICTING_SOURCES');
    assert.match(saida.answer, /Atenção: as fontes consultadas divergem\./);
    assert.match(saida.answer, /versão 1[^\n]*: 60/);
    assert.match(saida.answer, /versão 3[^\n]*: 90/);
  });
});

test('m9d024_detector_unidade_valores_e_marcador', () => {
  assert.equal(normalizeValue('7,0 %'), normalizeValue('7%'));
  assert.equal(normalizeValue(' Sessenta Dias. '), 'sessenta dias');
  assert.notEqual(normalizeValue('60'), normalizeValue('600'));
  assert.deepEqual(declaredFacts('Fato: a_b_c = 1\nfato: a_b_c = 2', 'Fato').map((f) => f.value), ['1', '2']);
  assert.deepEqual(declaredFacts('Regra: a_b_c = 1', 'Fato'), []);
  assert.deepEqual(declaredFacts('Regra: a_b_c = 1', 'Regra').map((f) => f.key), ['a_b_c']);
  const fonte = (id, valor, over = {}) => ({ sourceType: 'URL', sourceRef: id, title: id, sourceVersion: 1, facts: [{ key: 'k_k_k', raw: valor, value: normalizeValue(valor) }], ...over });
  assert.equal(detectConflicts([fonte('x', '1'), fonte('y', '1')]).length, 0);
  assert.equal(detectConflicts([fonte('x', '1'), fonte('x', '2')]).length, 0, 'mesma origem não diverge de si mesma');
  const [um] = detectConflicts([fonte('x', '1'), fonte('y', '2')]);
  assert.deepEqual(um.versions.map((v) => [v.ref, v.value]), [[1, '1'], [2, '2']]);
});
