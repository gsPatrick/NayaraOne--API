'use strict';

// M9-D244 — TLS 1.2+, certificado sempre verificado e allowlist de saída (sem banco; servidor HTTPS local com certificado gerado na hora).
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const dns = require('node:dns');
const https = require('node:https');
const { IntegrationHttpClient, createMtlsAgent } = require('../../../src/features/integrations/http/IntegrationHttpClient');
const { secureTlsOptions, ensureMinTlsVersion } = require('../../../src/features/integrations/http/tlsPolicy');
const { assertSecureScheme, resolveEgressMode, matchHost, checkEgress } = require('../../../src/features/integrations/http/egressPolicy');
const { scanTlsVerification } = require('../../../scripts/lib/integrationBoundaries');
const { criarFixture } = require('../_helpers/boundariesFixture');
const { gerarCertificado, subirServidor } = require('../_helpers/tlsFixture');

const fetchOriginal = global.fetch;
const lookupOriginal = dns.lookup;
afterEach(() => { global.fetch = fetchOriginal; dns.lookup = lookupOriginal; });

const falha = async (promessa, status, code) => assert.rejects(promessa, (e) => e.statusCode === status && e.code === code, `esperava ${status} ${code}`);
const ok = () => new Response('{}', { status: 200 });

test('tls_somente_https_exceto_localhost_teste: http, ftp e file são recusados antes da rede; http://localhost só com NODE_ENV=test', async () => {
  for (const url of ['http://api.fornecedor.com.br/x', 'ftp://x.example/a', 'file:///etc/passwd', 'http://evil.example/x', 'x']) {
    assert.throws(() => assertSecureScheme(url, { nodeEnv: 'test' }), (e) => e.statusCode === 502 && e.code === 'INTEGRATION_TLS_REQUIRED', url);
  }
  assert.doesNotThrow(() => assertSecureScheme('https://api.fornecedor.com.br/x', { nodeEnv: 'production' }));
  assert.doesNotThrow(() => assertSecureScheme('http://localhost:3000/x', { nodeEnv: 'test' }));
  assert.doesNotThrow(() => assertSecureScheme('http://127.0.0.1:3000/x', { nodeEnv: 'test' }));
  // M9-D245 (N2): o campo environment da conexão não abre a exceção; só o NODE_ENV=test do servidor.
  assert.throws(() => assertSecureScheme('http://localhost:3000/x', { nodeEnv: 'production', environment: 'SANDBOX' }), /conexão segura/);
  assert.throws(() => assertSecureScheme('http://localhost:3000/x', { nodeEnv: 'production', environment: 'PRODUCTION' }), /conexão segura/);
  assert.throws(() => assertSecureScheme('http://localhost:3000/x', { nodeEnv: 'production', environment: 'HOMOLOG' }));

  let tocou = 0;
  global.fetch = async () => { tocou += 1; return ok(); };
  dns.lookup = () => { tocou += 1; };
  const client = new IntegrationHttpClient({ providerCode: 'qa', allowedHosts: ['api.fornecedor.com.br', 'evil.example'], egressMode: 'enforce' });
  await falha(client.request({ url: 'http://evil.example/x' }), 502, 'INTEGRATION_TLS_REQUIRED');
  await falha(client.fetch('http://api.fornecedor.com.br/x'), 502, 'INTEGRATION_TLS_REQUIRED');
  await falha(client.httpsJson({ method: 'GET', url: 'http://api.fornecedor.com.br/x' }), 502, 'INTEGRATION_TLS_REQUIRED');
  assert.equal(tocou, 0, 'nenhuma consulta de DNS nem chamada de rede');
});

test('tls_versao_minima_1_2: o mínimo do processo sobe para TLS 1.2 e as opções de toda chamada não deixam baixá-lo nem desligar a verificação', async () => {
  const anterior = tls.DEFAULT_MIN_VERSION;
  try {
    tls.DEFAULT_MIN_VERSION = 'TLSv1.1';
    assert.equal(ensureMinTlsVersion(), 'TLSv1.2');
    assert.equal(tls.DEFAULT_MIN_VERSION, 'TLSv1.2');
  } finally { tls.DEFAULT_MIN_VERSION = anterior; }
  assert.equal(tls.DEFAULT_MIN_VERSION, 'TLSv1.2');
  // O chamador não consegue afrouxar: o que ele manda é sobreposto.
  const tentativa = { minVersion: 'TLSv1', rejectUnauthorized: [false][0], ca: 'x' };
  assert.deepEqual(secureTlsOptions(tentativa), { ca: 'x', minVersion: 'TLSv1.2', rejectUnauthorized: true });
  const agente = createMtlsAgent({ cert: 'c', key: 'k' });
  assert.equal(agente.options.minVersion, 'TLSv1.2');
  assert.equal(agente.options.rejectUnauthorized, true);

  // Na prática: servidor que só fala TLS 1.1 é recusado; um de TLS 1.2 é aceito.
  const par = gerarCertificado();
  const velho = await subirServidor(par, { minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'ALL:@SECLEVEL=0' }).catch(() => null);
  const novo = await subirServidor(par);
  try {
    const client = new IntegrationHttpClient({ providerCode: 'qa', allowedHosts: ['localhost'], egressMode: 'enforce', environment: 'HOMOLOG' });
    const agenteConfiavel = new https.Agent(secureTlsOptions({ ca: par.cert }));
    const r = await client.httpsJson({ method: 'GET', url: `https://localhost:${novo.port}/`, agent: agenteConfiavel });
    assert.deepEqual(r, { statusCode: 200, body: { ok: true } });
    assert.ok(velho, 'o servidor de TLS 1.1 precisa subir neste ambiente para a prova valer');
    if (velho) {
      await assert.rejects(client.httpsJson({ method: 'GET', url: `https://localhost:${velho.port}/`, agent: agenteConfiavel }), /protocol|version|handshake|ssl/i, 'TLS 1.1 recusado');
    }
  } finally { if (velho) await velho.close(); await novo.close(); }
});

test('tls_certificado_e_hostname_sao_verificados_sempre: certificado desconhecido e nome errado derrubam a conexão', async () => {
  const par = gerarCertificado();
  const srv = await subirServidor(par);
  try {
    const client = new IntegrationHttpClient({ providerCode: 'qa', allowedHosts: ['localhost', '127.0.0.1'], egressMode: 'enforce', environment: 'HOMOLOG' });
    await assert.rejects(client.httpsJson({ method: 'GET', url: `https://localhost:${srv.port}/` }), /self.signed|unable to verify|certificate/i, 'sem a autoridade, o certificado não é aceito');
    const agente = new https.Agent(secureTlsOptions({ ca: par.cert }));
    await assert.rejects(client.httpsJson({ method: 'GET', url: `https://127.0.0.1:${srv.port}/`, agent: agente }), (e) => e.code === 'ERR_TLS_CERT_ALTNAME_INVALID', 'nome do host diferente do certificado');
    assert.equal((await client.httpsJson({ method: 'GET', url: `https://localhost:${srv.port}/`, agent: agente })).statusCode, 200);
  } finally { await srv.close(); }
});

test('tls_verificacao_de_certificado_nunca_desligada: o código real não tem o desligamento e a varredura acha o sintético no código, no Dockerfile, no .env e no CI', () => {
  assert.deepEqual(scanTlsVerification(), []);
  const f = criarFixture({
    'features/x/a.js': 'const o = { rejectUnauthorized: false };\n',
    'features/x/b.js': "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\n",
    'config/database.js': 'const ssl = { rejectUnauthorized: false };\n',
  });
  const fs = require('node:fs');
  const path = require('node:path');
  fs.writeFileSync(path.join(f.base, 'Dockerfile'), 'ENV NODE_TLS_REJECT_UNAUTHORIZED=0\n');
  fs.writeFileSync(path.join(f.base, '.env.example'), 'NODE_TLS_REJECT_UNAUTHORIZED=0\n');
  fs.mkdirSync(path.join(f.base, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(f.base, '.github', 'workflows', 'ci.yml'), '      NODE_TLS_REJECT_UNAUTHORIZED: "0"\n');
  try {
    const achados = scanTlsVerification({ projectRoot: f.base }).map((v) => v.file).sort();
    assert.deepEqual(achados, ['.env.example', '.github/workflows/ci.yml', 'Dockerfile', 'src/features/x/a.js', 'src/features/x/b.js'], 'src/config (conexão com o banco) fica fora do escopo de tráfego com fornecedor');
  } finally { f.limpar(); }
});

test('egress_host_fora_da_allowlist_bloqueado: 502 INTEGRATION_EGRESS_BLOCKED antes do DNS e da rede, com curinga só para subdomínio', async () => {
  let rede = 0;
  global.fetch = async () => { rede += 1; return ok(); };
  dns.lookup = () => { rede += 1; };
  const client = new IntegrationHttpClient({ providerCode: 'banco-exemplo', allowedHosts: ['api.banco-exemplo.com.br', '*.cdn-exemplo.com'], egressMode: 'enforce' });
  await falha(client.request({ url: 'https://evil.example/collect' }), 502, 'INTEGRATION_EGRESS_BLOCKED');
  await falha(client.fetch('https://evil.example/collect?token=1'), 502, 'INTEGRATION_EGRESS_BLOCKED');
  await falha(client.request({ url: 'https://api.banco-exemplo.com.br.evil.example/x' }), 502, 'INTEGRATION_EGRESS_BLOCKED');
  await falha(client.request({ url: 'https://cdn-exemplo.com/apex' }), 502, 'INTEGRATION_EGRESS_BLOCKED');
  assert.equal(rede, 0, 'bloqueado sem consulta de DNS e sem tocar a rede');
  try { await client.request({ url: 'https://evil.example/collect' }); } catch (e) { assert.equal(e.message, 'Destino não permitido para esta integração.'); assert.deepEqual(e.details, { host: 'evil.example' }); }

  assert.equal((await client.request({ url: 'https://api.banco-exemplo.com.br/v1/x', maxAttempts: 1 })).status, 200);
  assert.equal((await client.fetch('https://img.cdn-exemplo.com/a.png')).status, 200);
  assert.equal(rede, 2, 'só as duas chamadas permitidas chegaram ao fetch');
  // Sem nenhum host declarado, enforce não deixa sair para lugar nenhum.
  await falha(new IntegrationHttpClient({ providerCode: 'x', egressMode: 'enforce' }).fetch('https://api.banco-exemplo.com.br/'), 502, 'INTEGRATION_EGRESS_BLOCKED');
  // Hosts da chamada (config validada do adapter) somam aos do cliente.
  assert.equal((await client.fetch('https://extra.example/', {}, { allowedHosts: ['extra.example'] })).status, 200);
  assert.ok(matchHost('*.x.com', 'a.b.x.com') && !matchHost('*.x.com', 'x.com') && matchHost('A.X.com', 'a.x.com'));
  assert.equal(checkEgress({ url: 'https://[::1]/', allowedHosts: ['::1'], mode: 'enforce' }).decision, 'ALLOWED');
});

test('egress_modo_log_apenas_registra: fora da lista a chamada segue e o evento LOGGED é registrado; o padrão do modo vem do ambiente e o parâmetro vale sobre ele', async () => {
  global.fetch = async () => ok();
  const eventos = [];
  const client = new IntegrationHttpClient({ providerCode: 'sandbox-x', allowedHosts: ['api.ok.example'], egressMode: 'log', onEgress: (e) => eventos.push(e) });
  assert.equal((await client.fetch('https://fora.example/x?segredo=1')).status, 200, 'em modo log a chamada não é impedida');
  assert.deepEqual(eventos.map((e) => [e.decision, e.host, e.mode, e.providerCode]), [['LOGGED', 'fora.example', 'log', 'sandbox-x']]);
  await client.fetch('https://api.ok.example/x');
  assert.equal(eventos.length, 1, 'host permitido não gera evento');

  assert.equal(resolveEgressMode({ environment: 'PRODUCTION' }), 'enforce');
  assert.equal(resolveEgressMode({ environment: 'HOMOLOG' }), 'enforce');
  assert.equal(resolveEgressMode({ environment: 'SANDBOX' }), 'log');
  assert.equal(resolveEgressMode({ nodeEnv: 'production' }), 'enforce');
  assert.equal(resolveEgressMode({ nodeEnv: 'development' }), 'log');
  assert.equal(resolveEgressMode({ environment: 'PRODUCTION', mode: 'log' }), 'log', 'o parâmetro integration.egress.mode vale sobre o padrão');
  assert.equal(resolveEgressMode({ environment: 'SANDBOX', mode: 'enforce' }), 'enforce');
  assert.equal(resolveEgressMode({ environment: 'SANDBOX', mode: 'qualquer' }), 'log', 'valor inválido volta ao padrão');
});
