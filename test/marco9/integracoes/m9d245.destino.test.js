'use strict';

// Marco 9, M9-D245 (reabertura G2 e M3) — endereço vindo da configuração de uma conexão: Clicksign, ZapSign e S3 não levam o token nem a rede
// interna a um host arbitrário; o cliente HTTP recusa IP privado em qualquer modo e prende a conexão ao DNS validado. Banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, withRollbackTenantTransaction } = require('../../testHelpers');
const registry = require('../../../src/features/integrations/registry/registry.service');
const { SignatureClicksignContractAdapter, SignatureZapSignContractAdapter } = require('../../../src/features/integrations/adapters/legacy/signature.adapters');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { IntegrationHttpClient } = require('../../../src/features/integrations/http/IntegrationHttpClient');
const { pinnedFetch } = require('../../../src/features/integrations/http/pinnedFetch');
const { validateEgressHostList } = require('../../../src/features/integrations/http/egressHostRules');
const { assertConfiguredBaseUrl } = require('../../../src/features/integrations/http/configUrl.policy');
const { gerarCertificado, subirServidor } = require('../_helpers/tlsFixture');
const { setupEnv, teardownEnv, novaConexao } = require('../../helpers/integrationsRegistryEnv');

let tenant;
let ctx;
before(async () => { ({ tenant, ctx } = await setupEnv()); });
after(async () => { await teardownEnv(tenant); await sequelize.close(); });

const recusa = (promessa, code) => assert.rejects(promessa, (e) => { assert.equal(e.code, code); return true; });
const criar = (over) => withRollbackTenantTransaction(tenant, (t) => registry.createConnection(novaConexao(over), ctx, t));
const MALICIOSOS = ['https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/api', 'http://app.clicksign.com/api/v3', 'https://u:p@app.clicksign.com/api', 'https://servidor.internal/api', 'https://evil.example.org/api/v3'];

test('g2_baseurl_da_conexao_recusada_na_gravacao_para_clicksign_e_zapsign', async () => {
  for (const providerCode of ['signature-clicksign', 'signature-zapsign']) {
    for (const baseUrl of MALICIOSOS) {
      // Usuário e senha na URL já caem no detector de segredo da configuração; os demais, na política de endereço.
      await recusa(criar({ providerCode, configJson: { baseUrl }, policyJson: { egressHosts: ['evil.example.org'] } }), baseUrl.includes('u:p@') ? 'INTEGRATION_SECRET_IN_CONFIG' : 'INTEGRATION_CONFIG_INVALID');
    }
  }
  const ok = await criar({ providerCode: 'signature-clicksign', configJson: { baseUrl: 'https://sandbox.clicksign.com/api/v3' } });
  assert.equal(ok.configJson.baseUrl, 'https://sandbox.clicksign.com/api/v3');
  const zap = await criar({ providerCode: 'signature-zapsign', configJson: { baseUrl: 'https://sandbox.api.zapsign.com.br/api/v1' } });
  assert.ok(zap.id);
});

test('g2_baseurl_na_edicao_tambem_e_conferida', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const c = await registry.createConnection(novaConexao({ providerCode: 'signature-clicksign', configJson: {} }), ctx, t);
    await recusa(registry.updateConnection(c.id, { configJson: { baseUrl: 'https://169.254.169.254/x' } }, ctx, t), 'INTEGRATION_CONFIG_INVALID');
  });
});

test('g2_parametro_provider_hosts_amplia_so_o_fornecedor_nomeado', async () => {
  const salvar = (v) => withRollbackTenantTransaction(tenant, async (t) => { await upsertSetting('integration.egress.provider_hosts', v, tenant, tenant.userId, t, { platform: true }); });
  for (const ruim of ['sem-formato', 'signature-clicksign:10.0.0.5', 'signature-clicksign:servidor.internal', 'signature-clicksign:https://x.com', 'signature-clicksign:']) {
    await assert.rejects(salvar(ruim), (e) => e.code === 'SETTING_INVALID_VALUE', ruim);
  }
  await withRollbackTenantTransaction(tenant, async (t) => {
    await upsertSetting('integration.egress.provider_hosts', 'signature-clicksign:clicksign.parceiro.example', tenant, tenant.userId, t, { platform: true });
    const c = await registry.createConnection(novaConexao({ providerCode: 'signature-clicksign', configJson: { baseUrl: 'https://clicksign.parceiro.example/api/v3' } }), ctx, t);
    assert.ok(c.id, 'o host liberado no parâmetro vale para o fornecedor nomeado');
    await recusa(registry.createConnection(novaConexao({ providerCode: 'signature-zapsign', configJson: { baseUrl: 'https://clicksign.parceiro.example/api/v1' } }), ctx, t), 'INTEGRATION_CONFIG_INVALID');
  });
});

test('g2_execucao_confere_de_novo_mesmo_com_dado_antigo_no_banco', async () => {
  const adaptador = new SignatureClicksignContractAdapter(null);
  const fazer = (baseUrl, extra = {}) => ({ connection: { environment: 'PRODUCTION', config: { baseUrl } }, baseUrlHosts: adaptador.allowedHosts(), secret: async () => ({ value: { reveal: () => 'token' } }), ...extra });
  await recusa(adaptador.legacy(fazer('https://169.254.169.254/latest/meta-data')), 'INTEGRATION_CONFIG_INVALID');
  const bom = await adaptador.legacy(fazer('https://app.clicksign.com/api/v3'));
  assert.equal(bom.baseUrl, 'https://app.clicksign.com/api/v3');
  const zap = new SignatureZapSignContractAdapter(null);
  await recusa(zap.legacy({ ...fazer('https://10.0.0.5/api'), baseUrlHosts: zap.allowedHosts() }), 'INTEGRATION_CONFIG_INVALID');
});

test('m3_policy_egresshosts_so_aceita_nome_publico', async () => {
  assert.deepEqual(validateEgressHostList(['api.fornecedor.com.br', '*.cdn.example.com']), []);
  for (const ruim of ['10.0.0.5', '169.254.169.254', 'localhost', 'db.internal', '127.1', 'https://x.com', 'a.com:8443', '', 5]) {
    assert.ok(validateEgressHostList([ruim]).length > 0, `${ruim}`);
  }
  await recusa(criar({ policyJson: { egressHosts: ['10.0.0.5'] } }), 'INTEGRATION_POLICY_INVALID');
  assert.ok((await criar({ policyJson: { egressHosts: ['api.fornecedor.com.br'] } })).id);
});

test('m3_s3_endpoint_e_bucket_de_texto_livre_sao_recusados', async () => {
  const base = { providerCode: 'storage-s3', secretRef: undefined };
  for (const config of [{ endpoint: '169.254.169.254', bucket: 'nayara' }, { endpoint: 's3.exemplo.test#@10.0.0.5', bucket: 'nayara' }, { endpoint: 's3.exemplo.test/x', bucket: 'nayara' },
    { endpoint: 'meu-servidor.internal', bucket: 'nayara' }, { endpoint: 's3.exemplo.test', bucket: 'a/../b' }, { endpoint: 's3.exemplo.test', bucket: 'Nayara' }]) {
    await recusa(criar({ ...base, configJson: config }), 'INTEGRATION_CONFIG_INVALID');
  }
  assert.ok((await criar({ ...base, configJson: { endpoint: 's3.sa-east-1.amazonaws.com', bucket: 'nayara-docs', region: 'sa-east-1' } })).id);
  const { StorageS3Adapter } = require('../../../src/features/integrations/providers/storage/storage-s3.adapter');
  const a = new StorageS3Adapter();
  assert.throws(() => a.target({ connection: { config: { endpoint: 's3.exemplo.test@10.0.0.5', bucket: 'nayara' } } }, 'k'), (e) => e.code === 'INTEGRATION_CONFIG_INVALID');
});

test('m3_cliente_http_recusa_destino_privado_em_qualquer_modo', async () => {
  for (const [environment, egressMode] of [['PRODUCTION', 'enforce'], ['SANDBOX', 'log'], ['HOMOLOG', 'log']]) {
    const http = new IntegrationHttpClient({ environment, egressMode, allowedHosts: ['169.254.169.254', '10.0.0.5', 'api.interna.example'] });
    for (const url of ['https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/x', 'https://[fd00::1]/x']) {
      await recusa(http.guard(url, 'GET'), 'INTEGRATION_EGRESS_BLOCKED');
    }
    await recusa(http.scoped(['servidor.internal']).guard('https://servidor.internal/x', 'GET'), 'INTEGRATION_EGRESS_BLOCKED');
  }
  const eventos = [];
  const http = new IntegrationHttpClient({ environment: 'PRODUCTION', egressMode: 'enforce', onEgress: (e) => eventos.push(e) });
  await recusa(http.scoped(['169.254.169.254']).guard('https://169.254.169.254/x', 'GET'), 'INTEGRATION_EGRESS_BLOCKED');
  assert.ok(eventos.some((e) => e.decision === 'BLOCKED' && e.host === '169.254.169.254'), 'o bloqueio é registrado');
  // localhost segue liberado em teste e SANDBOX (servidores de teste), nunca em produção.
  assert.equal((await new IntegrationHttpClient({ environment: 'SANDBOX', egressMode: 'log', allowedHosts: ['localhost'] }).guard('http://localhost:9/x', 'GET')).decision, 'ALLOWED');
});

test('m3_dns_e_resolvido_uma_vez_validado_e_fixado', async () => {
  const consultas = [];
  const resolverPublico = async (h) => { consultas.push(h); return [{ address: '93.184.216.34', family: 4 }]; };
  const http = new IntegrationHttpClient({ environment: 'PRODUCTION', egressMode: 'enforce', allowedHosts: ['api.fornecedor.example'], resolver: resolverPublico });
  const d = await http.guard('https://api.fornecedor.example/v1', 'GET');
  assert.deepEqual(d.pin, { address: '93.184.216.34', family: 4 });
  assert.deepEqual(consultas, ['api.fornecedor.example'], 'uma consulta por chamada');
  // Nome que resolve para endereço interno (DNS rebinding) ou para público + interno é recusado.
  for (const lista of [[{ address: '10.0.0.7', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }], [{ address: '::ffff:7f00:1', family: 6 }]]) {
    const mau = new IntegrationHttpClient({ environment: 'PRODUCTION', egressMode: 'enforce', allowedHosts: ['api.fornecedor.example'], resolver: async () => lista });
    await recusa(mau.guard('https://api.fornecedor.example/v1', 'GET'), 'INTEGRATION_EGRESS_BLOCKED');
  }
  const semDns = new IntegrationHttpClient({ environment: 'PRODUCTION', egressMode: 'enforce', allowedHosts: ['api.fornecedor.example'], resolver: async () => { throw new Error('ENOTFOUND'); } });
  await recusa(semDns.guard('https://api.fornecedor.example/v1', 'GET'), 'INTEGRATION_EGRESS_BLOCKED');
});

test('m3_conexao_presa_ao_endereco_validado_e_sem_seguir_redirecionamento', async () => {
  const par = gerarCertificado(['pin.example.test']);
  let visto = null;
  const srv = await subirServidor(par, {}, (req, res) => {
    visto = req.headers.host;
    if (req.url === '/vai') { res.statusCode = 302; res.setHeader('location', 'https://169.254.169.254/'); return res.end(); }
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  });
  try {
    // O nome não existe no DNS do sistema: só o endereço validado (pin) leva até o servidor, com SNI, Host e certificado do nome original.
    const r = await pinnedFetch(`https://pin.example.test:${srv.port}/v1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }, { address: '127.0.0.1', family: 4 }, { ca: par.cert });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
    assert.equal(visto, `pin.example.test:${srv.port}`);
    const red = await pinnedFetch(`https://pin.example.test:${srv.port}/vai`, {}, { address: '127.0.0.1', family: 4 }, { ca: par.cert });
    assert.equal(red.status, 302, 'o redirecionamento volta ao chamador, não é seguido');
    await assert.rejects(pinnedFetch(`https://pin.example.test:${srv.port}/v1`, {}, { address: '127.0.0.1', family: 4 }), /certificate|self.signed|unable to verify/i, 'sem a autoridade de teste o certificado é recusado');
  } finally { await srv.close(); }
});

test('g2_configuracao_pura_aceita_local_so_em_teste_e_sandbox', () => {
  assert.doesNotThrow(() => assertConfiguredBaseUrl({ baseUrl: 'http://127.0.0.1:4010/api', allowedHosts: [], environment: 'SANDBOX', nodeEnv: 'test' }));
  assert.throws(() => assertConfiguredBaseUrl({ baseUrl: 'http://127.0.0.1:4010/api', allowedHosts: [], environment: 'PRODUCTION', nodeEnv: 'production' }), (e) => e.code === 'INTEGRATION_CONFIG_INVALID');
  // Em produção nenhuma forma de loopback ou rede interna passa, nem a numérica (2130706433 vira 127.0.0.1) nem a de IPv6, mesmo se o host constasse na lista.
  for (const baseUrl of ['https://127.0.0.1/api', 'https://[::1]/api', 'https://2130706433/api', 'https://0x7f.1/api', 'https://169.254.169.254/x', 'https://[::ffff:10.0.0.1]/x', 'https://localhost/x']) {
    assert.throws(() => assertConfiguredBaseUrl({ baseUrl, allowedHosts: ['127.0.0.1', '::1', 'localhost', '169.254.169.254', '10.0.0.1'], environment: 'PRODUCTION', nodeEnv: 'production' }), (e) => e.code === 'INTEGRATION_CONFIG_INVALID', baseUrl);
  }
});
