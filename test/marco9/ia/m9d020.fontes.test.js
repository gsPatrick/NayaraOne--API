'use strict';

// M9-D020 passo 4 — o orquestrador e a tool `knowledge.search` buscam no índice do RAG por `RetrievalService.search` (M9-D023) com o
// contexto do ator, o runId e o teto do agente; trechos entram como blocos untrusted; falta de fonte vira insuficiência.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { semear } = require('../_helpers/ragSeed');
const { espiaRegistry } = require('../_helpers/iaEspia');
const H = require('../_helpers/iaOrquestrador');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const CONSULTA = 'contrato Aurora cláusula de reajuste anual';
const TEXTO = 'Contrato Aurora: a cláusula de reajuste anual segue o índice do contrato.';
const RAG = { dataScopes: ['knowledge.politicas', 'files.contratos', 'urls.publicas'] };
const resposta = '[[RESPOSTA:O reajuste anual segue o índice do contrato [1].]]';

test('m9d020_passo4_busca_no_indice_com_runid_e_blocos_untrusted', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { registry, pedidos } = espiaRegistry();
    const c = await H.cenario(tenantA, tx, { agentOver: RAG, deps: { registry } });
    const chunk = await semear(tenantA, tx, { texto: TEXTO, requiredPermission: 'ai:use' });
    const res = await H.rodar(c, `${CONSULTA} ${resposta}`);
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.equal(res.groundingStatus, 'GROUNDED');
    assert.equal(res.sources.length, 1);
    const fontes = await H.fontes(res.runId, tx);
    assert.equal(fontes.length, 1, 'a busca grava a fonte uma vez só (ai.ai_sources)');
    assert.equal(fontes[0].source_ref, chunk.sourceId);
    assert.equal(fontes[0].source_type, 'DOCUMENT_CHUNK');
    const bloco = pedidos[0].messages.find((m) => m.content.includes('origin="rag"'));
    assert.ok(bloco && bloco.content.includes('Contrato Aurora'), 'o trecho vai ao modelo como bloco untrusted do RAG');
    assert.doesNotMatch(pedidos[0].system, /Contrato Aurora/, 'nunca no system');
  });
});

test('m9d020_passo4_permissao_do_ator_e_teto_do_agente', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { agentOver: RAG });
    await semear(tenantA, tx, { texto: 'Contrato Aurora: cláusulas de rescisão e multa contratual do reajuste anual.', requiredPermission: 'legal:read' });
    // Ator sem legal:read: o trecho jurídico nem é candidato; sem fonte, o fato vira insuficiência (200).
    const sem = await H.rodar(c, `${CONSULTA} ${resposta}`);
    assert.equal(sem.groundingStatus, 'INSUFFICIENT_SOURCES');
    assert.equal((await H.fontes(sem.runId, tx)).length, 0);
    // Outro ator, com legal:read, enxerga o mesmo trecho.
    const com = await H.rodar(c, `${CONSULTA} ${resposta}`, { auth: { ...c.auth, permissions: [...H.PERMS, 'legal:read'] } });
    assert.equal(com.groundingStatus, 'GROUNDED');
    assert.equal((await H.fontes(com.runId, tx)).length, 1);
    // Teto do agente: sem áreas de dados que liberem tipos do índice, o agente não busca nele, mesmo que o ator possa ver tudo.
    const fechado = await H.cenario(tenantA, tx, { agentOver: { dataScopes: ['crm.opportunities'] }, perms: [...H.PERMS, 'legal:read'] });
    const nada = await H.rodar(fechado, `${CONSULTA} ${resposta}`);
    assert.equal(nada.groundingStatus, 'INSUFFICIENT_SOURCES');
    assert.equal((await H.fontes(nada.runId, tx)).length, 0);
    // CONFIDENTIAL e RESTRICTED não vão ao provedor de teste (não aceita nenhum dos dois).
    await semear(tenantA, tx, { texto: 'Contrato Aurora confidencial: reajuste anual com desconto especial.', classification: 'CONFIDENTIAL' });
    await semear(tenantA, tx, { texto: 'Contrato Aurora restrito: reajuste anual com cláusula secreta.', classification: 'RESTRICTED' });
    const livre = await H.rodar(c, `${CONSULTA} ${resposta}`, { auth: { ...c.auth, permissions: [...H.PERMS, 'legal:read', 'ai:restricted'] } });
    const tipos = (await H.fontes(livre.runId, tx)).map((f) => f.classification);
    assert.ok(tipos.every((t) => ['PUBLIC', 'INTERNAL'].includes(t)), `só classes livres: ${tipos}`);
  });
});

test('m9d020_tool_knowledge_search_busca_no_indice_com_o_ator', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.cenario(tenantA, tx, { tools: ['knowledge.search'], agentOver: RAG, perms: ['ai:use'] });
    await semear(tenantA, tx, { texto: TEXTO, requiredPermission: 'ai:use' });
    await semear(tenantA, tx, { texto: 'Contrato Aurora: rescisão e multa do reajuste anual.', requiredPermission: 'legal:read' });
    const pedido = `Veja [[TOOL:knowledge.search:{"query":"${CONSULTA}"}]] [[RESPOSTA:Há uma regra de reajuste [2].]]`;
    const res = await H.rodar(c, pedido, { taskType: 'conversa' });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const linhas = await H.chamadas(res.runId, tx);
    assert.deepEqual(linhas.map((l) => [l.tool_name, l.status]), [['knowledge.search', 'SUCCEEDED']]);
    const resultado = JSON.stringify(linhas[0].result_summary);
    assert.ok(resultado.includes('reajuste'), 'o resumo do resultado traz o trecho do ator');
    assert.ok(!resultado.includes('rescisão'), 'sem legal:read o trecho jurídico não aparece');
  });
});
