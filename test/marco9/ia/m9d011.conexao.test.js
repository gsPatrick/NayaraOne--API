'use strict';

// M9-D011 — config_json da conexão do provedor de IA: schema, ai:admin para o que o provedor aceita receber, retenção lida pela NAY.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { providerRetentionCaps } = require('../../../src/features/ai/retention');
const { sequelize, prepararTenants, q } = require('../../helpers/aiAgents');
const { modelo, paraConfig } = require('../_helpers/iaAdapterCtx');
const P = require('../_helpers/iaProviders');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); await P.prepararAmbiente(tenantA); });
after(async () => { await sequelize.close(); });

const criar = (tx, config, over = {}) => P.criarConexao(tenantA, tx, { providerCode: 'openai', config, ...over });

test('m9d011_data_retention_validado_por_schema_e_lido_pela_retencao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    for (const ruim of ['FOREVER', '30d', 30, true, null]) {
      await P.recusa(criar(tx, { data_retention: ruim }), 'INTEGRATION_CONFIG_INVALID', 422);
    }
    const c = await criar(tx, { data_retention: '30D', region: 'BR', contract_ref: 'CT-2026-7' });
    assert.equal(c.configJson.data_retention, '30D');
    // Alterar também passa pelo schema.
    await P.recusa(P.registry.updateConnection(c.id, { configJson: { ...c.configJson, data_retention: 'ETERNA' } }, P.comAdmin(tenantA), tx), 'INTEGRATION_CONFIG_INVALID', 422);
    // providerRetentionCaps (D028) lê exatamente este valor: 30D limita a 30 dias; NONE e PROVIDER_DEFAULT não limitam.
    assert.equal((await providerRetentionCaps(tx)).openai, 30);
    await P.registry.updateConnection(c.id, { configJson: { ...c.configJson, data_retention: 'NONE' } }, P.comAdmin(tenantA), tx);
    assert.equal((await providerRetentionCaps(tx)).openai, undefined);
    await P.registry.updateConnection(c.id, { configJson: { ...c.configJson, data_retention: 'PROVIDER_DEFAULT' } }, P.comAdmin(tenantA), tx);
    assert.equal((await providerRetentionCaps(tx)).openai, undefined);
    // Campo não previsto, tipo errado e modelo incompleto são recusados.
    await P.recusa(criar(tx, { extra: 1 }), 'INTEGRATION_CONFIG_INVALID', 422);
    await P.recusa(criar(tx, { lab_only: 'sim' }), 'INTEGRATION_CONFIG_INVALID', 422);
    await P.recusa(criar(tx, { baseUrl: 'ftp://x' }), 'INTEGRATION_CONFIG_INVALID', 422);
    await P.recusa(criar(tx, { models: [{ model: 'm' }] }), 'INTEGRATION_CONFIG_INVALID', 422);
    await P.recusa(criar(tx, { models: [paraConfig(modelo({ safetyTier: 4 }))] }), 'INTEGRATION_CONFIG_INVALID', 422);
    // O valor do segredo nunca entra na configuração (registro único: só a referência).
    await P.recusa(criar(tx, { apiKey: 'sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), 'INTEGRATION_SECRET_IN_CONFIG', 422);
  });
});

test('m9d011_allows_confidential_e_restricted_so_ai_admin_e_restricted_exige_retencao_none', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const base = { data_retention: 'NONE', contract_ref: 'CT-1' };
    // Padrão false; sem ai:admin não liga.
    const c = await criar(tx, base, { ctx: P.semAdmin(tenantA) });
    assert.notEqual(c.configJson.allowsConfidential, true);
    const e1 = await P.recusa(P.registry.updateConnection(c.id, { configJson: { ...base, allowsConfidential: true } }, P.semAdmin(tenantA), tx), 'AI_ADMIN_REQUIRED', 403);
    assert.equal(e1.message, 'Só quem administra a NAY altera o que o provedor aceita receber.');
    await P.recusa(criar(tx, { ...base, allowsRestricted: true }, { ctx: P.semAdmin(tenantA) }), 'AI_ADMIN_REQUIRED', 403);
    // Com ai:admin liga, e a auditoria guarda antes e depois.
    const ligada = await P.registry.updateConnection(c.id, { configJson: { ...base, allowsConfidential: true, allowsRestricted: true } }, P.comAdmin(tenantA), tx);
    assert.equal(ligada.configJson.allowsRestricted, true);
    const aud = await q("SELECT before_json, after_json FROM audit.audit_log WHERE entity_type = 'IntegrationConnection' AND entity_id = :id ORDER BY created_at DESC LIMIT 1", { id: c.id }, tx);
    assert.notEqual(aud[0].before_json.configJson.allowsRestricted, true);
    assert.equal(aud[0].after_json.configJson.allowsRestricted, true);
    // Outros campos da configuração seguem com quem tem integration:manage (não é ai:admin que muda a região).
    const regiao = await P.registry.updateConnection(c.id, { configJson: { ...ligada.configJson, region: 'BR' } }, P.semAdmin(tenantA), tx);
    assert.equal(regiao.configJson.region, 'BR');
    // Desligar também é mudança de quem aceita receber: exige ai:admin.
    await P.recusa(P.registry.updateConnection(c.id, { configJson: { ...regiao.configJson, allowsRestricted: false } }, P.semAdmin(tenantA), tx), 'AI_ADMIN_REQUIRED', 403);
    // allowsRestricted=true exige data_retention=NONE.
    for (const retencao of ['30D', 'PROVIDER_DEFAULT', undefined]) {
      const cfg = { allowsRestricted: true, ...(retencao ? { data_retention: retencao } : {}) };
      const err = await P.recusa(criar(tx, cfg), 'INTEGRATION_CONFIG_INVALID', 422);
      assert.match(err.message, /retenção NONE|data_retention/);
    }
    const ok = await criar(tx, { allowsRestricted: true, data_retention: 'NONE' });
    assert.equal(ok.configJson.allowsRestricted, true);
    await P.recusa(P.registry.updateConnection(ok.id, { configJson: { allowsRestricted: true, data_retention: '30D' } }, P.comAdmin(tenantA), tx), 'INTEGRATION_CONFIG_INVALID', 422);
  });
});
