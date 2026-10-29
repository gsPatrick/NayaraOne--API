'use strict';

// M9-D046 — em LAB (padrão) o provedor real só roda em empresa marcada como laboratório (`ia.empresa.lab`); em PRODUCAO vale o portão.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { providerRegistry } = require('../../../src/features/ai/providers');
const { registerAiAdapters } = require('../../../src/features/ai/providers/builtIn');
const { readProviderParams } = require('../../../src/features/ai/providers/providers.params');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const P = require('../_helpers/iaProviders');
const { liberarProducao } = require('../_helpers/iaLiberacao');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await P.prepararAmbiente(tenantA); registerAiAdapters(); });
after(async () => { await sequelize.close(); });

const codigos = async (tx) => (await providerRegistry.entries(tenantA, tx)).map((e) => e.providerCode);

test('m9d046_lab_bloqueia_provider_real_em_empresa_nao_lab', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await P.ativarConexao(tenantA, tx, { providerCode: 'openai' });
    await P.ajustar(tenantA, 'ia.empresa.lab', false, tx); // a empresa NÃO é laboratório
    assert.deepEqual(await readProviderParams(tenantA, tx), { defaultProvider: 'ai-sandbox', criticalMinSafetyTier: 2, production: false, companyLab: false });
    // O sandbox atende; o real é recusado (409) e some da lista de candidatos.
    assert.equal((await providerRegistry.instance('ai-sandbox', tenantA, tx)).providerCode(), 'ai-sandbox');
    const err = await P.recusa(providerRegistry.instance('openai', tenantA, tx), 'AI_PROVIDER_REAL_NOT_ALLOWED_IN_LAB', 409);
    assert.equal(err.message, 'Em ambiente de laboratório o provedor real só pode ser usado por empresa marcada como laboratório.');
    assert.deepEqual([...new Set(await codigos(tx))], ['ai-sandbox']);
    assert.deepEqual((await providerRegistry.candidates({ capability: 'generate' }, tenantA, tx)).map((c) => c.providerCode).filter((c) => c !== 'ai-sandbox'), []);
    // Empresa marcada como laboratório: o real atende.
    await P.ajustar(tenantA, 'ia.empresa.lab', true, tx);
    assert.equal((await providerRegistry.instance('openai', tenantA, tx)).providerCode(), 'openai');
    assert.ok((await codigos(tx)).includes('openai'));
    // PRODUCAO com o portão completo: o real não depende da marca de laboratório.
    await P.ajustar(tenantA, 'ia.empresa.lab', false, tx);
    await liberarProducao(tenantA, tx);
    await P.ajustar(tenantA, 'ia.ambiente', 'PRODUCAO', tx);
    assert.equal((await providerRegistry.instance('openai', tenantA, tx)).providerCode(), 'openai');
    await P.recusa(providerRegistry.instance('ai-sandbox', tenantA, tx), 'AI_SANDBOX_NOT_ALLOWED_IN_PRODUCTION', 409);
  });
});

test('m9d046_ambiente_lab_por_padrao_e_marca_de_laboratorio_validada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const p = await readProviderParams(tenantA, tx);
    assert.equal(p.production, false, 'ia.ambiente = LAB por padrão');
    assert.equal(p.companyLab, false, 'a empresa não é laboratório por padrão');
    await P.recusa(P.ajustar(tenantA, 'ia.empresa.lab', 'sim', tx), 'SETTING_INVALID_VALUE');
    await P.recusa(P.ajustar(tenantA, 'ia.ambiente', 'HOMOLOG', tx), 'SETTING_INVALID_VALUE');
  });
});
