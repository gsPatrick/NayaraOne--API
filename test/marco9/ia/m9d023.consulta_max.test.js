'use strict';

// M9-D023 (reabertura, literal QUERY_MAX do achado L-4) — o tamanho máximo da pergunta do RAG é parâmetro da empresa
// (ia.rag.consulta_max_caracteres, padrão 2.000): o administrador muda e a busca obedece. Roda com nayara_runtime (RLS real), em transação
// com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { readRagParams } = require('../../../src/features/ai/retrieval/retrieval.params');
const { sequelize, carregarPessoas, ctxDe, prepararTenants, comPerm, servico, rejeita } = require('../_helpers/ragEnv');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await carregarPessoas(); });
after(async () => { await sequelize.close(); });

const ator = () => comPerm(ctxDe(tenantA), 'ai:use');
const admin = () => ({ ...ctxDe(tenantA), permissions: ['settings:update'] });

test('m9d023_tamanho_maximo_da_consulta_e_parametro_da_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const longa = 'contrato '.repeat(20).trim(); // 179 caracteres
    assert.equal((await readRagParams(tenantA, tx)).queryMax, 2000, 'padrão do livro-demanda');
    assert.ok(Array.isArray((await servico.search(ator(), longa, {}, tx)).items), 'com o padrão a consulta passa');
    await upsertSetting('ia.rag.consulta_max_caracteres', 100, admin(), admin().userId, tx);
    await rejeita(servico.search(ator(), longa, {}, tx), 400, 'AI_RETRIEVAL_INVALID');
    assert.ok(Array.isArray((await servico.search(ator(), 'contrato Aurora', {}, tx)).items), 'dentro do novo limite passa');
    await upsertSetting('ia.rag.consulta_max_caracteres', 300, admin(), admin().userId, tx);
    assert.ok(Array.isArray((await servico.search(ator(), longa, {}, tx)).items), 'o administrador ampliou o limite');
    await assert.rejects(() => upsertSetting('ia.rag.consulta_max_caracteres', 0, admin(), admin().userId, tx), /./, 'valor fora da faixa é recusado');
  });
});
