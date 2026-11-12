'use strict';

// Marco 9, M9-D239 — o sandbox social (rede simulada) de ponta a ponta, com falha injetada na connection, e a arquitetura do módulo.
// Roda em banco descartável (os testes COMMITAM).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  sequelize, carregarTenants, ctxDe, conexaoAtiva, limparTudo, restaurar, ler, dispatch, criarConteudo, limparConteudos, dispatchesDe, publicar, sql,
} = require('../_helpers/m9d239Env');
const { resetSocialSandbox } = require('../../../src/features/integrations/providers/social/sandbox/social-sandbox.adapter');
const { PORTS } = require('../../../src/features/integrations/providers/ports');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { SOCIAL_SETTINGS_SCHEMA } = require('../../../src/features/integrations/social/social.settings');
const { clearCircuitCache } = require('../../../src/features/integrations/health');

let tenant;
let rede;
const ctx = () => ctxDe(tenant);
const rodar = () => dispatch.runDispatchCycle(ctx(), { now: new Date() });

before(async () => { ({ tenant } = await carregarTenants()); });
beforeEach(async () => {
  restaurar();
  resetSocialSandbox();
  require('../../../src/features/integrations/social');
  clearCircuitCache();
  rede = await conexaoAtiva(tenant, 'SOCIAL');
  await limparTudo(tenant);
  await sql(tenant, "UPDATE integration.connections SET config_json = '{}'::jsonb WHERE id = :id", { id: rede.id });
});
after(async () => { await limparConteudos(); await sequelize.close(); });

const falha = (tipo) => sql(tenant, 'UPDATE integration.connections SET config_json = CAST(:c AS jsonb) WHERE id = :id', { id: rede.id, c: JSON.stringify({ sandbox_fault: tipo }) });

test('sandbox_social_publica_confirma_e_nao_duplica', async () => {
  const c = await criarConteudo(tenant, {});
  const a = await publicar(tenant, { contentItemId: c.itemId, connectionIds: [rede.id] });
  assert.equal(a.results[0].ok, true);
  await rodar();
  const [l] = await dispatchesDe(tenant, c.itemId);
  assert.equal(l.status, 'CONFIRMED', 'a rede sem consulta de status confirma pelo id do post na resposta');
  assert.ok(l.external_resource_id.startsWith('sbx-post-'));
  assert.equal(l.confirmation_mode, 'ON_STATUS');
  // Mesmo pedido: mesmo envio; nada novo para enviar.
  const b = await publicar(tenant, { contentItemId: c.itemId, connectionIds: [rede.id] });
  assert.equal(b.results[0].created, false);
  assert.equal((await rodar()).claimed, 0);
});

test('sandbox_social_timeout_depois_do_envio_reconcilia_pela_chave', async () => {
  await falha('TIMEOUT_AFTER_SEND');
  const c = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: c.itemId, connectionIds: [rede.id] });
  await rodar();
  const [u] = await dispatchesDe(tenant, c.itemId);
  assert.equal(u.status, 'UNKNOWN');
  const rec = await dispatch.reconcileDispatch(ctx(), u.id, { now: new Date(Date.now() + 40000) });
  assert.deepEqual([rec.status, rec.verdict], ['CONFIRMED', 'FOUND']);
  assert.equal((await ler(tenant, u.id)).external_resource_id.startsWith('sbx-post-'), true);
});

test('sandbox_social_credencial_recusada_pausa_a_conexao', async () => {
  await falha('HTTP_401');
  const c = await criarConteudo(tenant, {});
  await publicar(tenant, { contentItemId: c.itemId, connectionIds: [rede.id] });
  await rodar();
  const [l] = await dispatchesDe(tenant, c.itemId);
  assert.equal(l.status, 'FAILED');
  assert.equal(l.last_error_class, 'AUTH');
  assert.equal((await sql(tenant, 'SELECT status FROM integration.connections WHERE id = :id', { id: rede.id }))[0].status, 'AUTH_FAILED');
});

test('social_arquitetura_porta_politica_e_parametros', () => {
  const publish = PORTS.SOCIAL.operations.publishPost;
  assert.deepEqual([publish.opClass, publish.confirmation], ['DANGEROUS', 'ON_STATUS']);
  const apagar = PORTS.SOCIAL.operations.deletePost;
  assert.deepEqual([apagar.opClass, apagar.confirmation], ['DANGEROUS', 'ON_STATUS'], 'exclusão é perigosa e com confirmação');
  assert.equal(PORTS.SOCIAL.operations.findPostByKey.opClass, 'SAFE');
  assert.deepEqual(Object.keys(SOCIAL_SETTINGS_SCHEMA).sort(), ['integration.social.auto_publish_enabled', 'integration.social.post_dedup_window_days']);
  Object.keys(SOCIAL_SETTINGS_SCHEMA).forEach((k) => assert.ok(SETTINGS_SCHEMA[k], `${k} no SETTINGS_SCHEMA`));
  const raiz = path.join(__dirname, '..', '..', '..', 'src', 'features', 'integrations', 'social');
  const leitor = fs.readFileSync(path.join(raiz, 'social.params.js'), 'utf8');
  Object.keys(SOCIAL_SETTINGS_SCHEMA).forEach((k) => assert.ok(leitor.includes(`'${k}'`), `${k} é lido`));
  // Nenhuma lógica de fornecedor fora de providers: o módulo social só fala com o port e com o Dispatch Service.
  fs.readdirSync(raiz).forEach((f) => {
    const codigo = fs.readFileSync(path.join(raiz, f), 'utf8');
    assert.ok(!/graph\.facebook|api\.linkedin|instagram\.com|require\('(node-fetch|axios|undici)'\)/i.test(codigo), `${f} sem chamada de fornecedor`);
    assert.ok(codigo.split('\n').length <= 400, `${f} até 400 linhas`);
  });
});
