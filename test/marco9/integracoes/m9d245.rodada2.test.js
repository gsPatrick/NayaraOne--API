'use strict';

// Marco 9, M9-D245 (reabertura da rodada 2: N1 e N2) — o ADMIN da empresa não escolhe para onde vai o token do fornecedor, e a exceção de
// localhost não depende do campo `environment` da conexão. HTTP real contra o app de teste; banco descartável (os testes COMMITAM e limpam).
process.env.PORT = process.env.M9D245_R2_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d249Env');
const { IntegrationHttpClient } = require('../../../src/features/integrations/http/IntegrationHttpClient');
const { assertConfiguredBaseUrl } = require('../../../src/features/integrations/http/configUrl.policy');
const { isLocalException } = require('../../../src/features/integrations/http/destination.policy');
const { assertSecureScheme } = require('../../../src/features/integrations/http/egressPolicy');

const CHAVE = 'integration.egress.provider_hosts';
const VALOR = 'signature-clicksign:coletor.atacante.example';
let tenants;
let tokenAdmin;
let tokenPlataforma;
let chamar;
const limpar = () => env.sql(tenants.tenant, 'DELETE FROM core.tenant_settings WHERE company_id = :c AND key = :k', { c: tenants.tenant.companyId, k: CHAVE });

before(async () => {
  tenants = await env.carregarTenants();
  tokenAdmin = env.tokenDe(tenants.tenant, ['settings:read', 'settings:update', 'integration:manage', 'integration:read']);
  tokenPlataforma = env.tokenDe(tenants.tenant, ['settings:read', 'settings:update', 'integration:platform']);
  chamar = env.chamador();
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => { await limpar(); await env.sequelize.close(); process.exit(0); });

test('n1_hosts_extras_de_fornecedor_exigem_integration_platform', async () => {
  await limpar();
  const admin = await chamar(tokenAdmin, 'PUT', `/settings/${CHAVE}`, { value: VALOR });
  assert.equal(admin.status, 403, 'o ADMIN da empresa (settings:update + integration:manage) não escolhe o destino do token');
  assert.equal(admin.corpo.error.code, 'PERMISSION_DENIED');
  const linhas = await env.sql(tenants.tenant, 'SELECT 1 FROM core.tenant_settings WHERE company_id = :c AND key = :k', { c: tenants.tenant.companyId, k: CHAVE });
  assert.equal(linhas.length, 0, 'nada foi gravado');
  const plataforma = await chamar(tokenPlataforma, 'PUT', `/settings/${CHAVE}`, { value: 'signature-clicksign:clicksign.parceiro.example' });
  assert.equal(plataforma.status, 200, 'a equipe da plataforma continua podendo');
  const ruim = await chamar(tokenPlataforma, 'PUT', `/settings/${CHAVE}`, { value: 'signature-clicksign:10.0.0.5' });
  assert.equal(ruim.status, 400, 'a validação de host público continua valendo para quem pode');
  await limpar();
});

test('n2_localhost_nao_depende_do_campo_environment_da_conexao', () => {
  for (const baseUrl of ['http://127.0.0.1:3001/internal', 'https://localhost/x', 'https://[::1]/x', 'https://2130706433/x', 'http://localhost/x']) {
    assert.throws(() => assertConfiguredBaseUrl({ baseUrl, allowedHosts: ['localhost', '127.0.0.1', '::1'], environment: 'SANDBOX', nodeEnv: 'production' }), (e) => e.code === 'INTEGRATION_CONFIG_INVALID', baseUrl);
  }
  assert.equal(isLocalException('127.0.0.1', { environment: 'SANDBOX', nodeEnv: 'production' }), false);
  assert.equal(isLocalException('127.0.0.1', { environment: 'SANDBOX', nodeEnv: 'development' }), false);
  assert.equal(isLocalException('127.0.0.1', { environment: 'PRODUCTION', nodeEnv: 'test' }), true, 'só o ambiente do servidor (teste) abre a exceção');
  assert.throws(() => assertSecureScheme('http://127.0.0.1:3001/x', { environment: 'SANDBOX', nodeEnv: 'production' }), (e) => e.code === 'INTEGRATION_TLS_REQUIRED');
});

test('n2_cliente_em_sandbox_com_servidor_em_producao_nao_entrega_token_a_loopback', async () => {
  const anterior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const http = new IntegrationHttpClient({ environment: 'SANDBOX', egressMode: 'log', allowedHosts: ['127.0.0.1', 'localhost'], maxAttempts: 1 });
    for (const url of ['http://127.0.0.1:9/x', 'https://127.0.0.1:9/x', 'https://localhost:9/x', 'https://[::1]:9/x']) {
      await assert.rejects(http.request({ method: 'GET', url, headers: { Authorization: 'Bearer token' } }), (e) => ['INTEGRATION_TLS_REQUIRED', 'INTEGRATION_EGRESS_BLOCKED'].includes(e.code), url);
    }
  } finally { process.env.NODE_ENV = anterior; }
});
