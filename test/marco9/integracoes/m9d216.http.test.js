'use strict';

// Marco 9, M9-D216 — nenhuma repetição escondida: a chamada HTTP dos adapters faz UMA tentativa; quem repete é o Dispatch Service.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant } = require('../../testHelpers');
const { IntegrationHttpClient } = require('../../../src/features/integrations/http/IntegrationHttpClient');
const { buildAdapterCtx } = require('../../../src/features/integrations/registry/adapterCtx');

let tenant;
const original = global.fetch;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { global.fetch = original; await sequelize.close(); });

function simular(status) {
  const chamadas = [];
  global.fetch = async (url) => { chamadas.push(url); return { status, headers: { get: () => null }, text: async () => '' }; };
  return chamadas;
}

test('retry_http_do_adapter_faz_uma_tentativa', async () => {
  const hosts = ['api.exemplo.com.br'];
  const url = 'https://api.exemplo.com.br/pagamentos';
  // O cliente padrão repete 5xx sozinho (3 tentativas): é o retry escondido que a política da D216 substitui nos adapters.
  let chamadas = simular(503);
  await new IntegrationHttpClient({ providerCode: 'qa-m9', allowedHosts: hosts, egressMode: 'enforce', environment: 'SANDBOX', maxAttempts: 1 }).request({ method: 'POST', url, circuitKey: 'qa-m9-d216-a' });
  assert.equal(chamadas.length, 1, 'com maxAttempts 1 a chamada sai uma vez só');
  chamadas = simular(503);
  const c = new IntegrationHttpClient({ providerCode: 'qa-m9', allowedHosts: hosts, environment: 'SANDBOX', maxAttempts: 1 });
  await c.scoped(['outro.exemplo.com.br']).request({ method: 'POST', url, circuitKey: 'qa-m9-d216-b' });
  assert.equal(chamadas.length, 1, 'o cliente com escopo herda a regra');
  // O cliente que o adapter recebe no contexto já nasce assim.
  const ctx = await sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
    return buildAdapterCtx({ id: '00000000-0000-4000-8000-0000000d0216', providerCode: 'qa-m9', environment: 'SANDBOX', policyJson: {}, configJson: {} }, { groupId: tenant.groupId, companyId: tenant.companyId }, t, { adapterHosts: hosts });
  });
  assert.equal(ctx.http.stateChangeMaxAttempts, 1, 'o que altera estado faz uma tentativa');
  assert.equal(ctx.http.defaultMaxAttempts, 3, 'leitura e operação idempotente seguem o parâmetro da empresa (N3)');
  chamadas = simular(503);
  await ctx.http.request({ method: 'POST', url, circuitKey: 'qa-m9-d216-c' });
  assert.equal(chamadas.length, 1, 'ctx.http dos adapters: uma tentativa');
  // Quem pedir mais tentativas explicitamente (fluxo antigo fora do Dispatch) continua podendo.
  chamadas = simular(400);
  await ctx.http.request({ method: 'GET', url, maxAttempts: 3, circuitKey: 'qa-m9-d216-d' });
  assert.equal(chamadas.length, 1, '4xx nunca repete (INT-006)');
});
