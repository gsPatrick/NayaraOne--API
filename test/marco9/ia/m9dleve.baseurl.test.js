'use strict';

// DI-IA-LEVE-4 — fora de dev/test, o baseUrl do provider só vale se o host for o do fornecedor ou estiver na lista de saída do administrador.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HttpModelAdapter } = require('../../../src/features/ai/providers/HttpModelAdapter');

class Fake extends HttpModelAdapter {
  defaultBaseUrl() { return 'https://api.fornecedor.test'; }
  providerCode() { return 'FAKE'; }
}
// `hostsDaPlataforma` = ctx.baseUrlHosts (integration.egress.provider_hosts, só da plataforma); `egressHosts` = policy da conexão, que a empresa edita e NÃO amplia a lista (M9-D244 R3-L5).
const adapter = (baseUrl, hostsDaPlataforma, egressHosts) => new Fake({ connection: { config: baseUrl ? { baseUrl } : {} }, baseUrlHosts: hostsDaPlataforma || [], policy: egressHosts ? { egressHosts } : {} });

function emAmbiente(nodeEnv, fn) {
  const antes = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  try { return fn(); } finally { process.env.NODE_ENV = antes; }
}

test('m9dleve4_producao_recusa_host_fora_da_lista', () => {
  emAmbiente('production', () => {
    assert.equal(adapter(null).baseUrl(), 'https://api.fornecedor.test');
    assert.equal(adapter('https://api.fornecedor.test/').baseUrl(), 'https://api.fornecedor.test');
    assert.throws(() => adapter('https://atacante.example.com').baseUrl(), (e) => e.code === 'AI_PROVIDER_BASEURL_NOT_ALLOWED');
    assert.throws(() => adapter('http://api.fornecedor.test').baseUrl(), (e) => e.code === 'AI_PROVIDER_BASEURL_NOT_ALLOWED', 'sem TLS');
    assert.throws(() => adapter('https://proxy.interno.test', ['outro.test']).baseUrl(), (e) => e.code === 'AI_PROVIDER_BASEURL_NOT_ALLOWED');
  });
});

test('m9dleve4_producao_aceita_host_da_lista_da_plataforma_e_nao_o_da_politica_da_conexao', () => {
  emAmbiente('production', () => {
    assert.throws(() => adapter('https://proxy.interno.test/v1', [], ['proxy.interno.test']).baseUrl(), (e) => e.code === 'AI_PROVIDER_BASEURL_NOT_ALLOWED', 'a lista de saída da conexão não escolhe o destino da chave');
    assert.equal(adapter('https://proxy.interno.test/v1', ['proxy.interno.test']).baseUrl(), 'https://proxy.interno.test/v1');
    assert.equal(adapter('https://a.proxy.test', ['*.proxy.test']).baseUrl(), 'https://a.proxy.test');
  });
});

test('m9dleve4_dev_e_teste_seguem_livres_para_o_servidor_local', () => {
  for (const env of ['test', 'development']) {
    emAmbiente(env, () => assert.equal(adapter('http://127.0.0.1:4010').baseUrl(), 'http://127.0.0.1:4010'));
  }
});
