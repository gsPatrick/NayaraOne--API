'use strict';

// M9-D011 — ProviderRegistry sobre o registro único de integrações: resolve por código, adapter real só por segredo, sandbox
// recusado em produção, sem tabela ai.providers. Roda com nayara_runtime (RLS real) em transação com rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { providerRegistry } = require('../../../src/features/ai/providers');
const { registerAiAdapters } = require('../../../src/features/ai/providers/builtIn');
const { readProviderParams } = require('../../../src/features/ai/providers/providers.params');
const { sequelize, prepararTenants, q } = require('../../helpers/aiAgents');
const P = require('../_helpers/iaProviders');

let tenantA;
before(async () => {
  ({ tenantA } = await prepararTenants());
  await P.prepararAmbiente(tenantA);
  registerAiAdapters();
});
after(async () => { await sequelize.close(); });

test('m9d011_registry_resolve_por_codigo_e_lista_so_a_familia_ai', () => {
  assert.deepEqual(providerRegistry.list().map((a) => a.providerCode).sort(), ['ai-sandbox', 'anthropic', 'openai']);
  assert.ok(providerRegistry.list().every((a) => a.domain === 'AI'));
  assert.deepEqual(providerRegistry.resolve('ai-sandbox').capabilities, ['generate', 'embed', 'transcribe', 'analyzeImage']);
  assert.deepEqual(providerRegistry.resolve('anthropic').capabilities, ['generate']);
  assert.equal(providerRegistry.has('bank-sandbox'), false, 'adapter de outra família não é de IA');
  assert.throws(() => providerRegistry.resolve('bank-sandbox'), { code: 'AI_PROVIDER_NOT_FOUND', statusCode: 404, message: 'Provedor não encontrado.' });
  assert.throws(() => providerRegistry.resolve('nao-existe'), { code: 'AI_PROVIDER_NOT_FOUND' });
  assert.throws(() => providerRegistry.register(class Qualquer {}), /AIProviderAdapter/);
});

test('m9d011_adapter_real_exige_secret', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // Sem a referência do segredo: ativar (enabled=true) é 400 AI_PROVIDER_NOT_CONFIGURED; a conexão fica em rascunho.
    const sem = await P.criarConexao(tenantA, tx, { providerCode: 'anthropic', secretRef: null });
    const err = await P.recusa(P.registry.transitionConnection(sem.id, 'ACTIVE', P.comAdmin(tenantA), tx), 'AI_PROVIDER_NOT_CONFIGURED', 400);
    assert.equal(err.message, 'Informe a credencial do provedor antes de ativá-lo.');
    assert.equal((await P.registry.getConnection(sem.id, P.comAdmin(tenantA), tx)).status, 'DRAFT');
    // Enquanto não há conexão ativa o adapter real não existe para a empresa (nasce desabilitado).
    await P.recusa(providerRegistry.instance('anthropic', tenantA, tx), 'AI_PROVIDER_NOT_ENABLED', 409);
    // Informada a referência, ativa; remover a referência de uma conexão ativa também é recusado.
    const com = await P.criarConexao(tenantA, tx, { providerCode: 'anthropic' });
    await P.registry.transitionConnection(com.id, 'ACTIVE', P.comAdmin(tenantA), tx);
    const adapter = await providerRegistry.instance('anthropic', tenantA, tx);
    assert.equal(adapter.providerCode(), 'anthropic');
    await P.recusa(P.registry.updateConnection(com.id, { secretRef: null }, P.comAdmin(tenantA), tx), 'AI_PROVIDER_NOT_CONFIGURED', 400);
    // A credencial só é lida no instante da chamada: referência sem valor no cofre -> erro de configuração, nada de rede.
    const e = await P.recusa(adapter.generate({ model: 'm-gen', system: '', messages: [{ role: 'user', content: 'oi' }] }), 'AI_PROVIDER_NOT_CONFIGURED', 400);
    assert.equal(e.kind, 'AUTH');
    // O sandbox não é um adapter "real": ativa sem segredo.
    const sb = await P.criarConexao(tenantA, tx, { providerCode: 'ai-sandbox', secretRef: null, config: { models: [] } });
    await P.registry.transitionConnection(sb.id, 'ACTIVE', P.comAdmin(tenantA), tx);
  });
});

test('m9d011_sandbox_bloqueado_em_producao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // LAB (padrão): o sandbox atende, sem conexão nenhuma.
    assert.equal((await providerRegistry.instance('ai-sandbox', tenantA, tx)).providerCode(), 'ai-sandbox');
    assert.equal((await providerRegistry.defaultInstance(tenantA, tx)).providerCode(), 'ai-sandbox', 'ia.provedor.padrao = ai-sandbox');
    await P.ajustar(tenantA, 'ia.ambiente', 'PRODUCAO', tx);
    assert.equal((await readProviderParams(tenantA, tx)).production, true);
    const err = await P.recusa(providerRegistry.instance('ai-sandbox', tenantA, tx), 'AI_SANDBOX_NOT_ALLOWED_IN_PRODUCTION', 409);
    assert.equal(err.message, 'O provedor de testes não pode ser usado em produção.');
    await P.recusa(providerRegistry.defaultInstance(tenantA, tx), 'AI_SANDBOX_NOT_ALLOWED_IN_PRODUCTION', 409);
    // Sem exceção por parâmetro: nenhuma chave desliga a recusa (o ambiente é a única entrada).
    await P.ajustar(tenantA, 'ia.provedor.padrao', 'ai-sandbox', tx);
    await P.recusa(providerRegistry.defaultInstance(tenantA, tx), 'AI_SANDBOX_NOT_ALLOWED_IN_PRODUCTION', 409);
    // Volta para o laboratório: libera de novo.
    await P.ajustar(tenantA, 'ia.ambiente', 'LAB', tx);
    assert.equal((await providerRegistry.instance('ai-sandbox', tenantA, tx)).providerCode(), 'ai-sandbox');
    // Provedor inexistente: 404.
    await P.recusa(providerRegistry.instance('nao-existe', tenantA, tx), 'AI_PROVIDER_NOT_FOUND', 404);
  });
});

test('m9d011_provedor_padrao_e_parametros_configuraveis', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const p0 = await readProviderParams(tenantA, tx);
    assert.deepEqual(p0, { defaultProvider: 'ai-sandbox', criticalMinSafetyTier: 2, production: false });
    await P.ajustar(tenantA, 'ia.provedor.padrao', 'openai', tx);
    await P.ajustar(tenantA, 'ia.provedor.safety_tier_minimo_critico', 3, tx);
    assert.deepEqual(await readProviderParams(tenantA, tx), { defaultProvider: 'openai', criticalMinSafetyTier: 3, production: false });
    // O padrão é lido de verdade: sem conexão ativa o openai não atende e a empresa vê o motivo.
    await P.recusa(providerRegistry.defaultInstance(tenantA, tx), 'AI_PROVIDER_NOT_ENABLED', 409);
    // A chave tem validação (fail-closed) na API de configurações.
    await P.recusa(P.ajustar(tenantA, 'ia.provedor.safety_tier_minimo_critico', 4, tx), 'SETTING_INVALID_VALUE');
    await P.recusa(P.ajustar(tenantA, 'ia.provedor.padrao', 'Código Inválido!', tx), 'SETTING_INVALID_VALUE');
    await P.recusa(P.ajustar(tenantA, 'ia.ambiente', 'HOMOLOG', tx), 'SETTING_INVALID_VALUE');
  });
});

test('m9d011_provider_de_ia_vive_no_registro_de_integracoes_sem_tabela_ai_providers', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // Não existe ai.providers (nem ai.secrets, nem cofre próprio): o provedor é uma linha de integration.providers (domain AI).
    const tabelas = await q("SELECT table_name FROM information_schema.tables WHERE table_schema = 'ai' AND table_name IN ('providers', 'provider_secrets', 'secrets')", {}, tx);
    assert.deepEqual(tabelas, []);
    const linhas = await q("SELECT code, capabilities, sandbox_available, config_schema FROM integration.providers WHERE domain = 'AI' ORDER BY code", {}, tx);
    assert.deepEqual(linhas.map((l) => l.code), ['ai-sandbox', 'anthropic', 'openai']);
    assert.deepEqual(linhas.map((l) => l.sandbox_available), [true, false, false]);
    assert.deepEqual(providerRegistry.list().map((a) => a.providerCode).sort(), linhas.map((l) => l.code), 'o registry é a visão do catálogo');
    linhas.forEach((l) => {
      assert.ok(l.config_schema.properties.data_retention && l.config_schema.properties.allowsRestricted && l.config_schema.properties.contract_ref, `${l.code}: schema do config_json`);
      assert.deepEqual([...l.capabilities].sort(), [...providerRegistry.resolve(l.code).capabilities].sort(), `${l.code}: catálogo = adapter`);
    });
    // A conexão e o segredo são do registro único: a conexão guarda só a referência, o valor nunca.
    const c = await P.criarConexao(tenantA, tx, { providerCode: 'openai' });
    const [linha] = await q('SELECT secret_ref, config_json::text AS cfg FROM integration.connections WHERE id = :id', { id: c.id }, tx);
    assert.match(linha.secret_ref, /^company\/.+\/ai\/openai-/);
    assert.ok(!/sk-|Bearer|api[_-]?key/i.test(linha.cfg));
    const [{ n }] = await q("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'integration' AND table_name = 'connections' AND column_name ~* 'secret_value|api_key'", {}, tx);
    assert.equal(n, 0);
  });
});
