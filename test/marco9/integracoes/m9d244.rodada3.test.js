'use strict';

// Marco 9, M9-D244 (reabertura R3-M3 e R3-L5) — metadados de nuvem nunca viram exceção, porta fora da lista é recusada antes de qualquer conexão (sem oráculo de porta)
// e o destino do token do canal de marketing e da IA não é escolhido pela empresa. Sem banco: funções puras e adaptadores com contexto montado à mão.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedIp } = require('../../../src/features/integrations/http/ssrf/ipRanges');
const { privateHostProblem, parsePrivateHosts } = require('../../../src/features/integrations/http/privateHosts.settings');
const { isMetadataName } = require('../../../src/features/integrations/http/metadataNames');
const { resolveDestination } = require('../../../src/features/integrations/http/destination.policy');
const { IntegrationHttpClient } = require('../../../src/features/integrations/http/IntegrationHttpClient');
const { RealChannelAdapter } = require('../../../src/features/marketing/publications/adapters/real/RealChannelAdapter');
const { OpenAIAdapter } = require('../../../src/features/ai/providers/openai/OpenAIAdapter');

const bloqueado = (p) => p.then(() => null, (e) => e);

test('r3m3_metadados_ipv6_e_azure_nunca_sao_liberados_como_rede_propria', () => {
  for (const ip of ['fd00:ec2::254', 'fd00:0ec2:0:0:0:0:0:254', 'fd00:ec2::1', '168.63.129.16', '169.254.169.254', '100.100.100.200', '192.0.0.192']) {
    assert.equal(isBlockedIp(ip, { allowPrivate: true }), true, ip);
    assert.equal(isBlockedIp(ip), true, ip);
  }
  // rede própria comum segue liberável quando a plataforma a listar
  for (const ip of ['10.0.0.5', '172.31.0.9', '192.168.1.20', 'fd00::5', 'fd12:3456:789a::1']) assert.equal(isBlockedIp(ip, { allowPrivate: true }), false, ip);
});

test('r3m3_nomes_de_metadados_e_de_servico_interno_nunca_entram_no_parametro_nem_na_execucao', async () => {
  for (const nome of ['metadata.google.internal', 'metadata', 'kubernetes', 'kubernetes.default', 'kubernetes.default.svc', 'api.prod.svc.cluster.local', 'instance-data', 'metadata.goog']) {
    assert.equal(isMetadataName(nome), true, nome);
    assert.ok(privateHostProblem(nome), `o parâmetro deveria recusar ${nome}`);
    assert.equal(parsePrivateHosts(`storage-s3:${nome}`), null, nome);
    const e = await bloqueado(resolveDestination(`https://${nome}/x`, { resolver: null, privateHosts: [nome] }));
    assert.equal(e && e.code, 'INTEGRATION_EGRESS_BLOCKED', `valor já gravado também é barrado na execução: ${nome}`);
  }
  for (const ip of ['fd00:ec2::254', '169.254.169.254', '168.63.129.16']) assert.ok(privateHostProblem(ip), ip);
  assert.equal(privateHostProblem('minio.empresa.lan'), null);
  assert.equal(privateHostProblem('10.0.0.5'), null);
});

test('r3m3_porta_fora_da_lista_e_recusada_antes_de_conectar_e_a_resposta_nao_revela_porta_aberta_ou_fechada', async () => {
  const a = await bloqueado(resolveDestination('https://api.parceiro.com.br:22/x', { resolver: null }));
  const b = await bloqueado(resolveDestination('https://api.parceiro.com.br:8443/x', { resolver: null }));
  for (const e of [a, b]) { assert.equal(e.code, 'INTEGRATION_EGRESS_BLOCKED'); assert.equal(e.details.reason, 'PORT_NOT_ALLOWED'); }
  assert.deepEqual([a.message, a.statusCode, a.details], [b.message, b.statusCode, b.details], 'mesma resposta para qualquer porta recusada');
  assert.equal((await resolveDestination('https://api.parceiro.com.br/x', { resolver: null })).host, 'api.parceiro.com.br');
  assert.equal((await resolveDestination('https://api.parceiro.com.br:443/x', { resolver: null })).host, 'api.parceiro.com.br');
  // a lista é parâmetro (integration.ssrf.allowed_ports): com 8443 liberada, 443 e 8443 passam e 22 continua fora
  assert.ok(await resolveDestination('https://api.parceiro.com.br:8443/x', { resolver: null, allowedPorts: [443, 8443] }));
  assert.equal((await bloqueado(resolveDestination('https://api.parceiro.com.br:22/x', { resolver: null, allowedPorts: [443, 8443] }))).details.reason, 'PORT_NOT_ALLOWED');
  // rede própria liberada pela plataforma escolhe a sua porta (MinIO)
  assert.ok(await resolveDestination('https://minio.empresa.lan:9000/x', { resolver: null, privateHosts: ['minio.empresa.lan'] }));
});

test('r3m3_o_cliente_http_aplica_a_lista_de_portas_antes_da_rede', async () => {
  const cliente = new IntegrationHttpClient({ providerCode: 'canal-x', allowedHosts: ['gw.parceiro.com.br'], resolver: null, egressMode: 'log', allowedPorts: [443] });
  for (const porta of [22, 6379, 8443]) {
    const e = await bloqueado(cliente.request({ method: 'GET', url: `https://gw.parceiro.com.br:${porta}/health`, maxAttempts: 1 }));
    assert.equal(e && e.code, 'INTEGRATION_EGRESS_BLOCKED', String(porta));
    assert.equal(e.details.reason, 'PORT_NOT_ALLOWED');
  }
});

test('r3l5_url_base_do_canal_de_marketing_so_vale_para_host_da_lista_da_plataforma_em_qualquer_ambiente', () => {
  const adapter = (baseUrl, baseUrlHosts, environment = 'SANDBOX') => Object.assign(Object.create(RealChannelAdapter.prototype), {
    channel: 'INSTAGRAM', ctx: { connection: { environment, config: { baseUrl } }, baseUrlHosts, policy: { egressHosts: ['gw.atacante.example.com'] } },
  });
  for (const ambiente of ['SANDBOX', 'PRODUCTION']) {
    assert.throws(() => adapter('https://gw.atacante.example.com/v1', [], ambiente).endpoints(), (e) => e.code === 'INTEGRATION_CONFIG_INVALID', `policy.egressHosts da empresa não amplia (${ambiente})`);
  }
  assert.ok(adapter('https://gw.parceiro.com.br/v1', ['gw.parceiro.com.br']).endpoints().create.startsWith('https://gw.parceiro.com.br/v1/'));
});

test('r3l5_url_base_da_ia_nao_e_ampliada_pela_lista_de_saida_da_conexao', () => {
  const anterior = process.env.NODE_ENV;
  const montar = (baseUrlHosts) => Object.assign(Object.create(OpenAIAdapter.prototype), {
    ctx: { connection: { config: { baseUrl: 'https://gw.atacante.example.com/v1' } }, baseUrlHosts, policy: { egressHosts: ['gw.atacante.example.com'] } },
  });
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => montar([]).baseUrl(), (e) => e.code === 'AI_PROVIDER_BASEURL_NOT_ALLOWED');
    assert.equal(montar(['gw.atacante.example.com']).baseUrl(), 'https://gw.atacante.example.com/v1', 'a lista da plataforma (provider_hosts) é a que vale');
  } finally { process.env.NODE_ENV = anterior; }
});
