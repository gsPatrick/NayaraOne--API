'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const settingsService = require('../src/features/settings/settings.service');
const { FgvIgpmIndexSourceAdapter, IpcaIndexSourceAdapter } = require('../src/features/billing/adapters/IndexSourceAdapter');
const rentAdjustmentService = require('../src/features/billing/rentAdjustment.service');

let tenant;
let originalFetch;

before(async () => {
  tenant = await getSeedTenant();
  originalFetch = global.fetch;
});

after(async () => {
  global.fetch = originalFetch;
  await sequelize.close();
});

// --- IGPM modo manual nunca tenta rede ---
test('billing IGPM: modo manual nunca tenta rede (fetch não é chamado) e retorna indisponível', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await settingsService.upsertSetting('billing.igpm_mode', 'manual', tenant, tenant.userId, transaction);
    await settingsService.upsertSetting('billing.fgv_api_token', 'token-que-nao-deveria-ser-usado', tenant, tenant.userId, transaction);

    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      throw new Error('fetch não deveria ser chamado em modo manual');
    };

    const adapter = new FgvIgpmIndexSourceAdapter({ getSettingFn: settingsService.getSetting, tenant, transaction });
    const result = await adapter.getIndex('IGPM', '2026-08');

    assert.equal(fetchCalled, false);
    assert.deepEqual(result, { available: false });
  });
});

// --- IGPM modo automático SEM token retorna indisponível (sem tentar rede) ---
test('billing IGPM: modo automático SEM token configurado retorna indisponível sem tentar rede', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await settingsService.upsertSetting('billing.igpm_mode', 'automatic', tenant, tenant.userId, transaction);
    // Propositalmente NÃO configura billing.fgv_api_token.

    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      throw new Error('fetch não deveria ser chamado sem token configurado');
    };

    const adapter = new FgvIgpmIndexSourceAdapter({ getSettingFn: settingsService.getSetting, tenant, transaction });
    const result = await adapter.getIndex('IGPM', '2026-08');

    assert.equal(fetchCalled, false);
    assert.deepEqual(result, { available: false });
  });
});

// --- IGPM modo automático COM token tenta a chamada (mockada) e trata falha graciosamente ---
test('billing IGPM: modo automático COM token tenta a chamada real, mas qualquer falha de rede vira indisponível (nunca lança)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await settingsService.upsertSetting('billing.igpm_mode', 'automatic', tenant, tenant.userId, transaction);
    await settingsService.upsertSetting('billing.fgv_api_token', 'token-valido-fake', tenant, tenant.userId, transaction);

    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      throw new Error('rede indisponível (simulado)');
    };

    const adapter = new FgvIgpmIndexSourceAdapter({ getSettingFn: settingsService.getSetting, tenant, transaction });
    const result = await adapter.getIndex('IGPM', '2026-08');

    assert.equal(fetchCalled, true);
    assert.deepEqual(result, { available: false });
  });
});

// --- IPCA: só responde para o código IPCA, nunca lança em falha de rede/parsing ---
test('billing IPCA: indexCode diferente de IPCA retorna indisponível sem tentar rede', async () => {
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('não deveria ser chamado para outro índice');
  };
  const result = await IpcaIndexSourceAdapter.getIndex('IGPM', '2026-08');
  assert.equal(fetchCalled, false);
  assert.deepEqual(result, { available: false });
});

test('billing IPCA: falha de rede ao consultar IBGE nunca lança exceção, retorna indisponível', async () => {
  global.fetch = async () => {
    throw new Error('rede fora do ar (simulado)');
  };
  const result = await IpcaIndexSourceAdapter.getIndex('IPCA', '2026-08');
  assert.deepEqual(result, { available: false });
});

test('billing IPCA: resposta 2xx com JSON válido extrai o valor numérico da variação mensal', async () => {
  global.fetch = async () => ({
    ok: true,
    json: async () => [
      {
        id: '63',
        resultados: [
          {
            series: [
              {
                serie: { '202608': '0,45' },
              },
            ],
          },
        ],
      },
    ],
  });
  const result = await IpcaIndexSourceAdapter.getIndex('IPCA', '2026-08');
  assert.equal(result.available, true);
  assert.equal(result.rawValue, 0.45);
});

// --- resolução dinâmica de adapter em rentAdjustment.service.js ---
test('billing: resolveIndexSourceAdapter escolhe IPCA/IGPM/unavailable conforme o indexCode', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const ipcaAdapter = rentAdjustmentService.resolveIndexSourceAdapter('IPCA', tenant, transaction);
    assert.equal(ipcaAdapter, IpcaIndexSourceAdapter);

    const igpmAdapter = rentAdjustmentService.resolveIndexSourceAdapter('IGPM', tenant, transaction);
    assert.equal(igpmAdapter.constructor.name, 'FgvIgpmIndexSourceAdapter');

    const outroAdapter = rentAdjustmentService.resolveIndexSourceAdapter('OUTRO_INDICE', tenant, transaction);
    const outroResult = await outroAdapter.getIndex('OUTRO_INDICE', '2026-08');
    assert.deepEqual(outroResult, { available: false });
  });
});
