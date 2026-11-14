'use strict';

// Fábricas dos testes dos providers de IA com banco (M9-D011): conexões do registro de integrações, parâmetros e cofre temporário.
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { getSecretStore } = require('../../../src/features/integrations/secrets');
const { modelo, MODELO_EMBED, paraConfig } = require('./iaAdapterCtx');
const { sequelize } = require('../../helpers/aiAgents');
const { gravarParametroSensivel } = require('../../helpers/mfaRecente');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');

const suf = () => Math.random().toString(16).slice(2, 10);
const comAdmin = (tenant) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId, permissions: ['ai:admin'] });
const semAdmin = (tenant) => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId, permissions: [] });
const refDe = (tenant, nome) => `company/${tenant.companyId}/ai/${nome}-${suf()}`;

/** Desliga o MFA de produção para estas provas (não são sobre MFA). */
async function prepararAmbiente(tenant) {
  await sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    await gravarParametroSensivel('integration.admin.mfa_on_prod_connection_change', false, tenant, t); // sensível: operador com MFA recente real
  });
}

/** Cria a conexão de IA (rascunho). `config` completa o config_json; `segredo` grava o valor no cofre temporário. */
async function criarConexao(tenant, tx, { providerCode = 'openai', config = {}, secretRef, ctx = comAdmin(tenant), segredo } = {}) {
  // Em LAB o provedor real só roda em empresa marcada como laboratório (M9-D046): quem cria uma conexão real nos testes marca a empresa.
  await upsertSetting('ia.empresa.lab', true, tenant, tenant.userId, tx);
  const ref = secretRef === undefined ? refDe(tenant, providerCode) : secretRef;
  if (segredo && ref) await getSecretStore().put(ref, segredo, {});
  return registry.createConnection({
    providerCode, environment: registry.getServerEnvironment(), label: `QA-M9 ${suf()}`, secretRef: ref, configJson: { models: [modelo(), MODELO_EMBED()].map(paraConfig), ...config },
  }, ctx, tx);
}

async function ativarConexao(tenant, tx, opts) {
  const c = await criarConexao(tenant, tx, opts);
  await registry.transitionConnection(c.id, 'ACTIVE', opts && opts.ctx ? opts.ctx : comAdmin(tenant), tx);
  return c;
}

// Parâmetro sensível (requiresMfa, ex.: ia.fallback.max_saltos) é gravado por um operador com MFA recente real; os demais, pelo usuário do seed.
const ajustar = (tenant, chave, valor, tx) => (SETTINGS_SCHEMA[chave] && SETTINGS_SCHEMA[chave].requiresMfa ? gravarParametroSensivel(chave, valor, tenant, tx) : upsertSetting(chave, valor, tenant, tenant.userId, tx));

async function recusa(promessa, code, status) {
  const assert = require('node:assert/strict');
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  if (status) assert.equal(err.statusCode, status);
  return err;
}

module.exports = { comAdmin, semAdmin, refDe, prepararAmbiente, criarConexao, ativarConexao, ajustar, recusa, suf, registry };
