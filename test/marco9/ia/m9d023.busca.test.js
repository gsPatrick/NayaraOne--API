'use strict';

// M9-D023 — a busca do RAG: empresa e permissão filtradas ANTES do conteúdo, RESTRICTED só com permissão e finalidade, nada vaza por
// pontuação ou contagem. Nayara One roda com nayara_runtime (RLS real), em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const chunksRepo = require('../../../src/features/ai/retrieval/chunks.repository');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants, comPerm, servico, rejeita } = require('../_helpers/ragEnv');
const { semear, comoEmpresa } = require('../_helpers/ragSeed');

let tenantA; let tenantB;
before(async () => { ({ tenantA, tenantB } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const ator = (...perms) => comPerm(ctxDe(tenantA), ...perms);
const CONSULTA = 'contrato Aurora cláusula de reajuste';
const TEXTO = 'Contrato Aurora: a cláusula de reajuste anual segue o índice do contrato.';
const ids = (r) => r.items.map((i) => i.chunkId);

test('m9d023_retrieval_cross_company_bloqueado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const a = await semear(tenantA, tx, { texto: TEXTO });
    const b = await comoEmpresa(tenantB, tx, () => semear(tenantB, tx, { texto: TEXTO })); // o mesmo texto, no mesmo índice, na empresa B
    const r = await servico.search(ator('ai:use'), CONSULTA, {}, tx);
    assert.deepEqual(ids(r), [a.id], 'só a empresa A responde; o chunk da B nem é candidato');
    const candidatos = await servico.candidates(ator('ai:use'), CONSULTA, {}, { topK: 50 }, tx);
    assert.ok(!candidatos.some((c) => c.id === b.id));
    assert.equal((await q('SELECT count(*)::int AS n FROM ai.chunks WHERE id = :id', { id: b.id }, tx))[0].n, 0, 'RLS: a linha da B é invisível');
    // Filtro apontando para outra empresa: 404 sem revelar existência.
    const err = await rejeita(servico.search(ator('ai:use'), CONSULTA, { companyId: tenantB.companyId }, tx), 404, 'AI_CROSS_COMPANY_BLOCKED');
    assert.equal(err.message, 'Dado não encontrado.');
    // E da B só se enxerga a B.
    await comoEmpresa(tenantB, tx, async () => {
      const daB = ids(await servico.search({ ...ctxDe(tenantB), permissions: ['ai:use'] }, CONSULTA, {}, tx));
      assert.ok(daB.includes(b.id) && !daB.includes(a.id), 'da empresa B só se enxerga a B');
    });
  });
});

test('m9d023_filtro_de_permissao_antes_do_conteudo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const livre = await semear(tenantA, tx, { texto: 'Contrato Aurora: política geral de atendimento ao locatário.', requiredPermission: 'ai:use' });
    const juridico = await semear(tenantA, tx, { texto: 'Contrato Aurora: cláusulas de rescisão e multa contratual.', requiredPermission: 'legal:read' });
    const financeiro = await semear(tenantA, tx, { texto: 'Contrato Aurora: valores de repasse e comissão.', requiredPermission: 'finance:read' });
    const lidos = [];
    const original = chunksRepo.findByIds;
    chunksRepo.findByIds = (ctx, idsLidos, t) => { lidos.push(...idsLidos); return original(ctx, idsLidos, t); };
    try {
      const sem = await servico.search(ator('ai:use'), 'contrato Aurora', {}, tx);
      assert.deepEqual(ids(sem), [livre.id], 'sem legal:read os trechos de contrato são filtrados');
      assert.deepEqual(lidos, [livre.id], 'o conteúdo dos filtrados nunca foi lido do banco');
      assert.ok(!JSON.stringify(sem).includes('rescisão') && !JSON.stringify(sem).includes('comissão'));
      lidos.length = 0;
      const com = await servico.search(ator('ai:use', 'legal:read'), 'contrato Aurora', {}, tx);
      assert.deepEqual(new Set(ids(com)), new Set([livre.id, juridico.id]));
      assert.ok(!lidos.includes(financeiro.id));
    } finally { chunksRepo.findByIds = original; }
    // Sem permissão em nenhuma fonte: 200 de insuficiência, texto do livro.
    const nada = await servico.search(ator('crm:read'), 'contrato Aurora', {}, tx);
    assert.deepEqual(nada, { items: [], insufficient: true, message: 'Não encontrei fontes que você possa consultar para responder.' });
    // Evidência do plano (EXPLAIN): empresa, estado ACTIVE (índice parcial), permissão e classificação são a condição do índice; a similaridade vem depois.
    const plano = (await servico.explain(ator('ai:use'), 'contrato Aurora', {}, tx)).join('\n');
    for (const trecho of ['ai_chunks_active_idx', 'company_id =', 'required_permission', 'classification', 'effective_from']) assert.ok(plano.includes(trecho), `o plano filtra por ${trecho}:\n${plano}`);
    assert.ok(plano.indexOf('Index Cond') < plano.indexOf('SubPlan 3'), 'empresa, estado (índice parcial ACTIVE), permissão e classe são a condição do índice; a similaridade só roda sobre o que passou');
  });
});

test('m9d023_restricted_exige_permissao_e_finalidade', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const restrito = await semear(tenantA, tx, { texto: 'Contrato Aurora: comprovante de renda e extrato do locatário.', classification: 'RESTRICTED' });
    const confidencial = await semear(tenantA, tx, { texto: 'Contrato Aurora: dados de negociação do locatário.', classification: 'CONFIDENTIAL' });
    const busca = (ctx, opts) => servico.search(ctx, 'contrato Aurora locatário', opts, tx).then((r) => new Set(ids(r)));
    assert.deepEqual(await busca(ator('ai:use'), {}), new Set([confidencial.id]), 'CONFIDENTIAL depende só da permissão do chunk; RESTRICTED não vem sem ai:restricted');
    assert.deepEqual(await busca(ator('ai:use', 'ai:restricted'), {}), new Set([confidencial.id]), 'ai:restricted sem finalidade não basta');
    assert.deepEqual(await busca(ator('ai:use', 'ai:restricted'), { purpose: '  ' }), new Set([confidencial.id]), 'finalidade em branco não vale');
    assert.deepEqual(await busca(ator('ai:use'), { purpose: 'análise de crédito' }), new Set([confidencial.id]), 'finalidade sem permissão não basta');
    assert.deepEqual(await busca(ator('ai:use', 'ai:restricted'), { purpose: 'análise de crédito' }), new Set([confidencial.id, restrito.id]));
    // Teto do agente/execução: o provider escolhido precisa aceitar a classe, e o data_scopes limita os tipos de fonte.
    const exec = (o) => ({ purpose: 'análise de crédito', execution: o });
    const dono = ator('ai:use', 'ai:restricted');
    assert.deepEqual(await busca(dono, exec({ allowsConfidential: true, allowsRestricted: false })), new Set([confidencial.id]));
    assert.deepEqual(await busca(dono, exec({ allowsConfidential: false, allowsRestricted: false })), new Set());
    assert.deepEqual(await busca(dono, exec({ allowsConfidential: true, allowsRestricted: true })), new Set([confidencial.id, restrito.id]));
    assert.deepEqual(await busca(dono, exec({ allowsConfidential: true, allowsRestricted: true, sourceTypes: ['FILE'] })), new Set());
  });
});

test('m9d023_sem_vazamento_por_contagem_de_candidatos', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await upsertSetting('ia.rag.top_k', 1, ator('ai:admin'), ctxDe(tenantA).userId, tx); // um só candidato: o proibido não pode "tomar" o lugar do permitido
    const visivel = await semear(tenantA, tx, { texto: 'Contrato Aurora: regras gerais de atendimento.' });
    const consulta = 'contrato Aurora cláusula sigilosa de rescisão';
    const antes = await servico.search(ator('ai:use'), consulta, {}, tx);
    for (let i = 0; i < 5; i += 1) await semear(tenantA, tx, { texto: `Contrato Aurora: cláusula sigilosa de rescisão número ${i}.`, requiredPermission: 'legal:read', classification: 'CONFIDENTIAL' });
    await semear(tenantA, tx, { texto: 'Contrato Aurora: cláusula sigilosa de rescisão da carteira.', classification: 'RESTRICTED' });
    const depois = await servico.search(ator('ai:use'), consulta, {}, tx);
    assert.deepEqual(depois, antes, 'seis trechos proibidos, muito mais parecidos com a pergunta, não mudam NADA na resposta');
    assert.deepEqual(ids(depois), [visivel.id]);
    assert.deepEqual(Object.keys(depois).sort(), ['insufficient', 'items'], 'a resposta não traz contagem, total nem pontuação dos proibidos');
    // Só proibidos: a resposta é a mesma de quando não existe nada.
    const soProibidos = await servico.search(ator('crm:read'), consulta, {}, tx);
    assert.deepEqual(soProibidos, { items: [], insufficient: true, message: 'Não encontrei fontes que você possa consultar para responder.' }, 'igual a quando não existe nada');
  });
});
