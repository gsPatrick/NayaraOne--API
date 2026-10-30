'use strict';

// Marco 9, M9-D238 — o fluxo antigo de seguro passa pelo Dispatch Service com dado minimizado, os segredos da seguradora saem de tenant_settings e vão ao cofre, e os adapters reais
// (Porto Seguro, Yelum e Junto Seguros) e o fluxo manual cumprem o contrato do port InsuranceAdapter e estão no catálogo. Banco descartável.
process.env.PORT = process.env.M9D238_ARQ_PORT || '24240';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d238Env');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
const { IntegrationAdapter } = require('../../../src/features/integrations');
const { InsuranceAdapter } = require('../../../src/features/integrations/providers/insurance/insurance.port');
const { readConnectionSecret } = require('../../../src/features/integrations/secrets');
const { IntegrationConnection } = require('../../../src/models');
const { ensureInsuranceConnection } = require('../../../src/features/procurement/insurance/insurance.connection');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.escolher(tenant, 'sandbox'); await env.sequelize.close(); process.exit(0); });

const guardado = async (chave) => (await env.sql(tenant, 'SELECT count(*)::int AS n FROM core.tenant_settings WHERE company_id = :c AND key = :k', { c: tenant.companyId, k: chave }))[0].n;
const pausarDe = (codigo) => env.sql(tenant, "UPDATE integration.connections SET status = 'PAUSED' WHERE company_id = :c AND provider_code = :p AND status = 'ACTIVE'", { c: tenant.companyId, p: codigo });

test('seguro_fluxo_antigo_passa_pelo_dispatch_service_com_dado_minimizado', async () => {
  await env.escolher(tenant, 'sandbox');
  await env.conectar(tenant, 'insurance-sandbox');
  const apolice = await env.criarApolice(tenant);
  await env.cotar(tenant, apolice.id, { estimatedValue: 9000, insuredName: 'Maria Souza', insuredDocument: '52998224725', segredoInterno: 'nao-sai', propertyType: 'HOUSE' });
  await env.emitir(tenant, apolice.id, { effectiveDate: new Date().toISOString().slice(0, 10), expiryDate: '2099-01-01' });
  const [cotacao] = await env.envios(tenant, apolice.id, 'quote');
  const [proposta] = await env.envios(tenant, apolice.id, 'propose');
  for (const envio of [cotacao, proposta]) {
    assert.equal(envio.aggregate_type, 'InsurancePolicy');
    assert.match(envio.payload_hash, /^[0-9a-f]{64}$/, 'o hash é do conteúdo minimizado');
    assert.equal(envio.attempts >= 1, true, 'o worker de envios executou o pedido (circuito, cota e tentativas do framework)');
  }
  assert.deepEqual([cotacao.purpose, proposta.purpose], ['INSURANCE_QUOTE', 'INSURANCE_PROPOSAL']);
  assert.equal(cotacao.payload_snapshot.insuredName, 'Maria Souza');
  assert.equal(cotacao.payload_snapshot.policyRef, apolice.id);
  assert.equal(Object.keys(cotacao.payload_snapshot).includes('segredoInterno'), false, 'campo fora do mapper não sai');
  assert.equal(proposta.payload_snapshot.expiryDate, '2099-01-01');
  assert.equal(proposta.payload_snapshot.premiumAmount, '90');
  // Sinistro: também pelo Dispatch Service, com a descrição sem dado pessoal.
  const claim = await env.comTenant(tenant, (t) => env.insuranceService.openClaim(apolice.id, { description: 'Vazamento; contato do morador 529.982.247-25', claimAmount: 800 }, env.actorDe(tenant), t));
  const enviado = await env.comTenant(tenant, (t) => env.insuranceService.submitClaim(claim.id, env.actorDe(tenant), t));
  assert.equal(enviado.status, 'SUBMITTED');
  const [sinistro] = await env.envios(tenant, claim.id, 'submitClaim');
  assert.equal(sinistro.purpose, 'INSURANCE_CLAIM');
  assert.equal(sinistro.aggregate_type, 'InsuranceClaim');
  assert.equal(sinistro.idempotency_key, `insurance-claim:${claim.id}`);
  assert.equal(sinistro.payload_snapshot.description.includes('529.982.247-25'), false, 'o dado pessoal da descrição é redigido antes de sair');
  assert.equal(sinistro.criticality_op, 'DANGEROUS');
  const [submissao] = await env.sql(tenant, "SELECT provider, source FROM procurement.insurance_provider_submissions WHERE claim_id = :id", { id: claim.id });
  assert.deepEqual([submissao.provider, submissao.source], ['sandbox', 'API']);
});

test('m9_d238_segredo_lido_pelo_secretstore', async () => {
  // Porto Seguro: o segredo do cliente sai de tenant_settings e vai ao cofre quando a connection é criada a partir da configuração.
  const segredoPorto = `porto-${env.uniqueSuffix()}`;
  await pausarDe('insurance-porto-seguro');
  // Reexecução no mesmo banco: a connection de uma rodada anterior (pausada) ainda guarda a referência canônica do cofre e o nome; ela é arquivada com outros valores para a desta rodada nascer limpa.
  await env.sql(tenant, "UPDATE integration.connections SET secret_ref = secret_ref || '/arquivada-' || :s, label = left(label, 120) || ' arquivada ' || :s WHERE company_id = :c AND provider_code = 'insurance-porto-seguro' AND status <> 'ACTIVE' AND secret_ref NOT LIKE '%/arquivada-%'", { c: tenant.companyId, s: env.uniqueSuffix() });
  await env.escolher(tenant, 'porto_seguro');
  await env.config(tenant, 'procurement.porto_seguro_client_id', 'cid-qa-m9');
  await env.config(tenant, 'procurement.porto_seguro_client_secret', segredoPorto);
  assert.equal(await guardado('procurement.porto_seguro_client_secret'), 1);
  const conn = await env.comTenant(tenant, (t) => ensureInsuranceConnection(env.ctxDe(tenant), t));
  assert.equal(conn.providerCode, 'insurance-porto-seguro');
  assert.equal(conn.status, 'ACTIVE');
  assert.equal(await guardado('procurement.porto_seguro_client_secret'), 0, 'depois da migração o valor deixa de existir em tenant_settings');
  const lido = await env.comTenant(tenant, async (t) => readConnectionSecret(await IntegrationConnection.findByPk(conn.id, { transaction: t }), env.ctxDe(tenant), { purpose: 'dispatch', transaction: t }));
  assert.equal(lido.value.reveal(), segredoPorto, 'a credencial é lida pelo SecretStore (readConnectionSecret)');
  const outra = await env.comTenant(tenant, (t) => ensureInsuranceConnection(env.ctxDe(tenant), t));
  assert.equal(outra.id, conn.id, 'a migração é idempotente: a segunda chamada usa a connection do cofre');
  // Credencial incompleta continua falhando fechado (nunca cai no sandbox em silêncio).
  await pausarDe('insurance-porto-seguro');
  await assert.rejects(env.comTenant(tenant, (t) => ensureInsuranceConnection(env.ctxDe(tenant), t)), (e) => e.statusCode === 400 && e.code === 'PROCUREMENT_INSURANCE_PROVIDER_CONFIG_MISSING');
  // Segredo HMAC do webhook: o primeiro webhook da empresa valida com o valor antigo e migra; o segundo valida só pelo cofre.
  await env.escolher(tenant, 'sandbox');
  const segredoWebhook = `wh-seguro-${env.uniqueSuffix()}`;
  const canal = await env.conectar(tenant, 'insurance-sandbox', { comSegredo: false });
  await env.config(tenant, 'procurement.insurance_webhook_secret', segredoWebhook);
  const hoje = new Date().toISOString().slice(0, 10);
  const apolice = await env.criarApolice(tenant);
  await env.cotar(tenant, apolice.id);
  await env.emitir(tenant, apolice.id, { effectiveDate: hoje, expiryDate: '2099-01-01' });
  const claim = await env.comTenant(tenant, (t) => env.insuranceService.openClaim(apolice.id, { description: 'Teste do segredo', claimAmount: 100 }, env.actorDe(tenant), t));
  const enviado = await env.comTenant(tenant, (t) => env.insuranceService.submitClaim(claim.id, env.actorDe(tenant), t));
  const post = (chave) => {
    const corpo = Buffer.from(JSON.stringify({ externalSubmissionId: enviado.externalClaimId, status: 'REJECTED' }));
    return env.postar('/v1/procurement/webhooks/insurance', corpo, { 'x-webhook-signature': crypto.createHmac('sha256', chave).update(corpo).digest('hex') });
  };
  assert.equal(await guardado('procurement.insurance_webhook_secret'), 1);
  assert.equal((await post(segredoWebhook)).status, 200, 'o primeiro webhook valida com o valor antigo e migra');
  assert.equal(await guardado('procurement.insurance_webhook_secret'), 0, 'depois da migração o valor deixa de existir em tenant_settings');
  const c = await env.comTenant(tenant, (t) => IntegrationConnection.findOne({ where: { id: canal.conn.id }, transaction: t }));
  const doCofre = await env.comTenant(tenant, (t) => readConnectionSecret(c, env.ctxDe(tenant), { purpose: 'webhook', kind: 'webhook', transaction: t }));
  assert.equal(doCofre.value.reveal(), segredoWebhook, 'o webhook agora é lido pelo SecretStore');
  assert.equal((await post(segredoWebhook)).status, 200, 'o segundo valida só pelo cofre (a migração é idempotente)');
  assert.equal(await guardado('procurement.insurance_webhook_secret'), 0);
  assert.equal((await post('outro-segredo')).status, 401, 'assinatura com outro segredo continua recusada');
});

test('seguro_adapters_reais_cumprem_o_contrato_e_estao_no_catalogo', async () => {
  const esperado = {
    'insurance-sandbox': ['getPolicy', 'getStatus', 'propose', 'quote', 'submitClaim', 'verifyWebhook'],
    'insurance-porto-seguro': ['getPolicy', 'getStatus', 'propose', 'quote', 'submitClaim', 'verifyWebhook'],
    'insurance-yelum': ['getPolicy', 'getStatus', 'propose', 'quote', 'submitClaim', 'verifyWebhook'],
    'insurance-junto-seguros': ['getPolicy', 'getStatus', 'propose', 'quote', 'submitClaim'],
    'insurance-manual': ['getPolicy', 'getStatus', 'propose', 'quote', 'submitClaim'],
  };
  for (const [codigo, capacidades] of Object.entries(esperado)) {
    assert.equal(adapterRegistry.has(codigo), true, `${codigo} registrado no AdapterRegistry`);
    const adapter = adapterRegistry.instantiate(codigo);
    assert.equal(adapter instanceof IntegrationAdapter && adapter instanceof InsuranceAdapter, true, `${codigo} estende o port InsuranceAdapter`);
    assert.deepEqual([...adapter.capabilities()].sort(), capacidades);
    assert.equal(Boolean(adapter.webhookVerifier()), capacidades.includes('verifyWebhook'), `${codigo}: verificador do webhook só onde há webhook`);
     
    const [linha] = await env.sql(tenant, 'SELECT domain, capabilities FROM integration.providers WHERE code = :c', { c: codigo });
    assert.equal(linha.domain, 'INSURANCE', `${codigo} no catálogo`);
    assert.deepEqual([...linha.capabilities].sort(), capacidades);
  }
  const hosts = adapterRegistry.instantiate('insurance-yelum').allowedHosts();
  assert.deepEqual(hosts.sort(), ['integracao-tst.grupohdiseguros.com.br', 'integracao.grupohdiseguros.com.br']);
  assert.deepEqual(adapterRegistry.instantiate('insurance-sandbox').toInternalEvent({ type: 'policy.status', policy: { id: 'p1' }, status: 'active' }).data, { kind: 'POLICY_STATUS', externalPolicyId: 'p1' });
  // O Junto Seguros continua sem integração: selecionado no painel, o pedido é recusado como sempre foi.
  await env.escolher(tenant, 'junto_seguros');
  const apolice = await env.criarApolice(tenant);
  await assert.rejects(env.cotar(tenant, apolice.id), (e) => e.statusCode === 400 && e.code === 'PROCUREMENT_INSURANCE_PROVIDER_UNAVAILABLE');
  // Yelum sem a chave: falha fechada.
  await env.escolher(tenant, 'yelum');
  await assert.rejects(env.cotar(tenant, apolice.id), (e) => e.statusCode === 400 && e.code === 'PROCUREMENT_INSURANCE_PROVIDER_CONFIG_MISSING');
  await env.escolher(tenant, 'sandbox');
});

test('seguro_parametros_declarados_no_dicionario', async () => {
  const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
  for (const k of ['integration.insurance.renewal_alert_days', 'integration.insurance.renewal_quote_enabled', 'integration.insurance.renewal_quote_days', 'integration.insurance.manual_task_due_days']) assert.ok(SETTINGS_SCHEMA[k], `${k} declarado`);
  assert.ok(SETTINGS_SCHEMA['procurement.insurance_provider'].enum.includes('manual'));
  await env.escolher(tenant, 'manual');
  await env.config(tenant, 'integration.insurance.manual_task_due_days', 10);
  const apolice = await env.criarApolice(tenant);
  const antes = Date.now();
  await env.cotar(tenant, apolice.id);
  const [tarefa] = await env.tarefas(tenant, apolice.id);
  const dias = (new Date(tarefa.due_at).getTime() - antes) / 86400000;
  assert.ok(dias > 9.9 && dias < 10.1, 'o prazo da tarefa manual é o parâmetro da empresa');
  await env.config(tenant, 'integration.insurance.manual_task_due_days', 3);
  await env.escolher(tenant, 'sandbox');
});
