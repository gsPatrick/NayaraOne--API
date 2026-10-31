'use strict';

// Marco 9, M9-D238 (reabertura M2 e L6) — os adapters reais de seguro: emitir apólice (POST/PUT) nunca é repetido às cegas em timeout; os tempos vêm dos parâmetros
// da empresa (nada de 20000/3/500 fixos no adapter) e uma só tentativa por chamada.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('../../testHelpers');
const settingsService = require('../../../src/features/settings/settings.service');
const { IntegrationHttpClient } = require('../../../src/features/integrations/http/IntegrationHttpClient');
const { PortoSeguroInsuranceAdapter, YelumInsuranceAdapter } = require('../../../src/features/procurement/adapters/InsuranceAdapter');
const { insuranceHttpFor } = require('../../../src/features/procurement/adapters/insurance.http');

const servidores = [];
after(async () => { servidores.forEach((s) => s.close()); await sequelize.close(); });

/** Seguradora que aceita a conexão e nunca responde (o envio pode ter sido processado). */
function seguradoraMuda() {
  const vistas = [];
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        vistas.push(`${req.method} ${req.url}`);
        if (req.url.includes('access-token')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"access_token":"t","expires_in":3600}'); }
        /* demais chamadas: sem resposta */
      });
    });
    servidores.push(s);
    s.listen(0, '127.0.0.1', () => resolve({ vistas, base: `http://127.0.0.1:${s.address().port}` }));
  });
}
// Cliente SEM maxAttempts: exatamente o caso que o INT-005 proíbe (3 tentativas do resilientFetch).
const clienteCru = () => new IntegrationHttpClient({ providerCode: 'insurance', timeouts: { readMs: 150, writeMs: 150 }, environment: 'SANDBOX' });

test('seguro_emitir_apolice_porto_nao_repete_apos_timeout', async () => {
  const { vistas, base } = await seguradoraMuda();
  const porto = new PortoSeguroInsuranceAdapter({ clientId: 'c', clientSecret: 's', baseUrl: base, authBaseUrl: base, http: clienteCru() });
  await assert.rejects(porto.issuePolicy({ quoteId: 'q-1' }), (e) => e.code === 'TIMEOUT' || /tempo|timeout/i.test(e.message));
  assert.equal(vistas.filter((v) => v.includes('/apolices')).length, 1, 'uma única emissão chegou à seguradora');
});

test('seguro_emitir_apolice_yelum_nao_repete_apos_timeout', async () => {
  const { vistas, base } = await seguradoraMuda();
  const yelum = new YelumInsuranceAdapter({ apiKey: 'k', baseUrl: base, http: clienteCru() });
  await assert.rejects(yelum.issuePolicy({ QuoteNo: 1 }), (e) => e.code === 'TIMEOUT' || /tempo|timeout/i.test(e.message));
  assert.equal(vistas.length, 1, 'um único PUT chegou à seguradora');
});

test('seguro_cotacao_e_leitura_seguem_com_retry_de_erro_transitorio', async () => {
  const { vistas, base } = await seguradoraMuda();
  const porto = new PortoSeguroInsuranceAdapter({ clientId: 'c', clientSecret: 's', baseUrl: base, authBaseUrl: base, http: clienteCru() });
  await assert.rejects(porto.quote({ valor: 1 }));
  assert.equal(vistas.filter((v) => v.includes('cotacoes')).length, 3, 'cotar não emite nada: 3 tentativas');
});

test('seguro_adapter_real_exige_cliente_http_com_os_tempos_da_empresa', async () => {
  assert.throws(() => new PortoSeguroInsuranceAdapter({ clientId: 'c', clientSecret: 's' }), (e) => e.code === 'PROCUREMENT_INSURANCE_PROVIDER_CONFIG_MISSING');
  assert.throws(() => new YelumInsuranceAdapter({ apiKey: 'k' }), (e) => e.code === 'PROCUREMENT_INSURANCE_PROVIDER_CONFIG_MISSING');
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const padrao = await insuranceHttpFor(tenant, t);
    assert.equal(padrao.defaultMaxAttempts, 1, 'o Dispatch Service repete; o adapter faz uma tentativa');
    await settingsService.upsertSetting('integration.dispatch.timeout_ms.read', 3000, tenant, tenant.userId, t);
    await settingsService.upsertSetting('integration.dispatch.timeout_ms.write', 4500, tenant, tenant.userId, t);
    const c = await insuranceHttpFor(tenant, t);
    assert.deepEqual(c.timeouts, { readMs: 3000, writeMs: 4500 }, 'tempos lidos dos parâmetros da empresa');
    const porto = new PortoSeguroInsuranceAdapter({ clientId: 'c', clientSecret: 's', http: c });
    assert.deepEqual(porto._http.timeouts, { readMs: 3000, writeMs: 4500 });
    assert.equal(porto._http.defaultMaxAttempts, 1);
  });
});
