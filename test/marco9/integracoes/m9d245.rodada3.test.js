'use strict';

// Marco 9, M9-D245 (reabertura da rodada 3: R3-L1 e R3-L3) — host com ponto final (nome absoluto) e NAT64 (DNS64). Funções puras, sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBlockedIp } = require('../../../src/features/integrations/http/ssrf/ipRanges');
const { hostOf, matchHost } = require('../../../src/features/integrations/http/egressPolicy');
const { assertConfiguredBaseUrl } = require('../../../src/features/integrations/http/configUrl.policy');

test('r3_l1_baseurl_legitima_com_ponto_final_e_aceita_e_o_ponto_nao_escapa_da_lista', () => {
  const permitidos = ['app.clicksign.com', 'sandbox.clicksign.com'];
  for (const baseUrl of ['https://SANDBOX.CLICKSIGN.COM./api/v1', 'https://sandbox.clicksign.com/api/v1']) {
    assert.doesNotThrow(() => assertConfiguredBaseUrl({ baseUrl, allowedHosts: permitidos, environment: 'PRODUCTION', nodeEnv: 'production' }), baseUrl);
  }
  assert.equal(hostOf('https://sandbox.clicksign.com./x'), 'sandbox.clicksign.com');
  assert.equal(matchHost('*.clicksign.com', 'api.clicksign.com.'), true);
  for (const baseUrl of ['https://coletor.atacante.example./x', 'https://localhost./x', 'https://10.0.0.5./x', 'https://sandbox.clicksign.com.atacante.example./x']) {
    assert.throws(() => assertConfiguredBaseUrl({ baseUrl, allowedHosts: permitidos, environment: 'PRODUCTION', nodeEnv: 'production' }), (e) => e.code === 'INTEGRATION_CONFIG_INVALID', baseUrl);
  }
});

test('r3_l3_nat64_decide_pelo_ipv4_embutido_em_vez_de_bloquear_o_prefixo_inteiro', () => {
  ['64:ff9b::808:808', '64:ff9b::0808:0808', '64:ff9b::1.1.1.1'].forEach((ip) => assert.equal(isBlockedIp(ip), false, `${ip} (IPv4 público via DNS64)`));
  ['64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b:0:0:0:0:7f00:1', '64:FF9B::A9FE:A9FE', '64:ff9b::a00:5', '64:ff9b::c0a8:1', '64:ff9b::', '64:ff9b:1::1'].forEach((ip) => assert.equal(isBlockedIp(ip), true, `${ip} (interno, metadados ou local-use)`));
});
