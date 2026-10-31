'use strict';

// Marco 9, M9-D238 e M9-D216 (reabertura da rodada 2, N3) — os adapters reais de seguro voltam a repetir leitura, cotação e pedido de token em erro transitório
// (fiação real: o cliente do contexto dos adapters e o do fluxo antigo), e nunca repetem a emissão. O número de tentativas vem do parâmetro da empresa.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('../../testHelpers');
const settingsService = require('../../../src/features/settings/settings.service');
const { buildAdapterCtx } = require('../../../src/features/integrations/registry/adapterCtx');
const { PortoSeguroInsuranceAdapter, YelumInsuranceAdapter } = require('../../../src/features/procurement/adapters/InsuranceAdapter');
const { insuranceHttpFor } = require('../../../src/features/procurement/adapters/insurance.http');

let tenant;
const servidores = [];
before(async () => { tenant = await getSeedTenant(); });
after(async () => { servidores.forEach((s) => s.close()); await sequelize.close(); });

/** Seguradora que responde 503 às primeiras `falhas` chamadas de cada rota e 200 depois; guarda as chamadas na ordem. */
function seguradora(falhas) {
  const vistas = [];
  const contagem = new Map();
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const rota = `${req.method} ${req.url}`;
        vistas.push(rota);
        if (req.url.includes('access-token')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"access_token":"t","expires_in":3600}'); }
        const n = (contagem.get(rota) || 0) + 1;
        contagem.set(rota, n);
        res.writeHead(n <= falhas ? 503 : 200, { 'content-type': 'application/json' });
        res.end('{"id":"x","status":"ISSUED"}');
      });
    });
    servidores.push(s);
    s.listen(0, '127.0.0.1', () => resolve({ vistas, base: `http://127.0.0.1:${s.address().port}` }));
  });
}
const conta = (vistas, trecho) => vistas.filter((v) => v.includes(trecho)).length;
const conexao = { id: '00000000-0000-4000-8000-0000000000d8', providerCode: 'insurance-porto-seguro', environment: 'SANDBOX', configJson: {}, policyJson: {} };

test('n3_contexto_dos_adapters_repete_leitura_e_cotacao_e_nao_repete_emissao', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ctx = await buildAdapterCtx(conexao, tenant, t, { adapterHosts: ['127.0.0.1'] });
    assert.equal(ctx.http.defaultMaxAttempts, 3, 'padrão: 3 tentativas para leitura e operação idempotente');
    assert.equal(ctx.http.stateChangeMaxAttempts, 1, 'operação que altera estado: uma só');
    const { vistas, base } = await seguradora(2);
    const porto = new PortoSeguroInsuranceAdapter({ clientId: 'c', clientSecret: 's', baseUrl: base, authBaseUrl: base, http: ctx.http });
    assert.equal((await porto.quote({ valor: 1 })).externalId, 'x');
    assert.equal(conta(vistas, 'cotacoes'), 3, 'cotação: 2 falhas e o sucesso');
    assert.equal((await porto.getPolicyStatus('ap-1')).status, 'ISSUED');
    assert.equal(conta(vistas, 'apolices/ap-1'), 3, 'leitura da apólice repetida');
    await assert.rejects(porto.issuePolicy({ quoteId: 'q' }), (e) => e.code === 'PROCUREMENT_INSURANCE_PROVIDER_ERROR');
    assert.equal(conta(vistas, 'POST /fianca-locaticia/v1/apolices'), 1, 'emissão: um único envio');
    const yelum = new YelumInsuranceAdapter({ apiKey: 'k', baseUrl: base, http: ctx.http });
    assert.ok(await yelum.quote({ QuoteNo: 1 }));
    assert.equal(conta(vistas, 'POST /cotador/fianca/v1/quote'), 3);
    await assert.rejects(yelum.issuePolicy({ QuoteNo: 1 }));
    assert.equal(conta(vistas, 'PUT /cotador/fianca/v1/quote'), 1, 'emissão da Yelum: um único PUT');
  });
});

test('n3_pedido_de_token_falho_e_repetido_no_cliente_do_contexto', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ctx = await buildAdapterCtx(conexao, tenant, t, { adapterHosts: ['127.0.0.1'] });
    const vistas = [];
    let n = 0;
    const s = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        vistas.push(req.url);
        if (req.url.includes('access-token')) { n += 1; if (n === 1) { res.writeHead(503); return res.end(); } res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"access_token":"t","expires_in":3600}'); }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"c1"}');
      });
    });
    servidores.push(s);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${s.address().port}`;
    const porto = new PortoSeguroInsuranceAdapter({ clientId: 'c', clientSecret: 's', baseUrl: base, authBaseUrl: base, http: ctx.http });
    assert.equal((await porto.quote({ valor: 1 })).externalId, 'c1');
    assert.equal(conta(vistas, 'access-token'), 2, 'o token falhou uma vez e foi pedido de novo');
  });
});

test('n3_fluxo_antigo_de_compras_usa_a_mesma_regra', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const cliente = await insuranceHttpFor(tenant, t);
    assert.equal(cliente.defaultMaxAttempts, 3);
    assert.equal(cliente.stateChangeMaxAttempts, 1);
    const { vistas, base } = await seguradora(1);
    const porto = new PortoSeguroInsuranceAdapter({ clientId: 'c', clientSecret: 's', baseUrl: base, authBaseUrl: base, http: cliente });
    await porto.quote({ valor: 1 });
    assert.equal(conta(vistas, 'cotacoes'), 2);
    await assert.rejects(porto.issuePolicy({ quoteId: 'q' }));
    assert.equal(conta(vistas, 'POST /fianca-locaticia/v1/apolices'), 1);
  });
});

test('n3_tentativas_vem_do_parametro_da_empresa_e_e_validado', async () => {
  const salvar = (t, v) => settingsService.upsertSetting('integration.dispatch.call_attempts.idempotent', v, tenant, tenant.userId, t);
  for (const ruim of [0, 6, 2.5, 'tres']) {
    await assert.rejects(withRollbackTenantTransaction(tenant, (t) => salvar(t, ruim)), (e) => e.code === 'SETTING_INVALID_VALUE' || e.statusCode === 400, String(ruim));
  }
  await withRollbackTenantTransaction(tenant, async (t) => {
    await salvar(t, 1);
    assert.equal((await buildAdapterCtx(conexao, tenant, t, { adapterHosts: ['127.0.0.1'] })).http.defaultMaxAttempts, 1, 'a empresa pode deixar toda repetição ao Dispatch Service');
    assert.equal((await insuranceHttpFor(tenant, t)).defaultMaxAttempts, 1);
    await salvar(t, 5);
    const ctx = await buildAdapterCtx(conexao, tenant, t, { adapterHosts: ['127.0.0.1'] });
    assert.equal(ctx.http.defaultMaxAttempts, 5);
    assert.equal(ctx.http.stateChangeMaxAttempts, 1, 'emissão continua com uma só tentativa');
    const { vistas, base } = await seguradora(4);
    const porto = new PortoSeguroInsuranceAdapter({ clientId: 'c', clientSecret: 's', baseUrl: base, authBaseUrl: base, http: ctx.http });
    await porto.getPolicyStatus('ap-9');
    assert.equal(conta(vistas, 'apolices/ap-9'), 5, 'o parâmetro muda o número de tentativas da leitura');
  });
});
