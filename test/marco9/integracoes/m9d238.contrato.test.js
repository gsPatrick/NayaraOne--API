'use strict';

// Marco 9, M9-D238 — suíte de contrato da M9-D222 para os adapters de seguro (sandbox, Porto Seguro, Yelum e fluxo manual; o Junto Seguros não tem API): fixtures por versão, os 10 cenários verdes, relatório gravado e o prefixo fora das pendências.
const { test } = require('node:test');
const { provarContrato } = require('../_helpers/contratoDemanda');

test('m9d238_contrato_d222_dez_cenarios_verdes_e_fora_das_pendencias', async () => {
  await provarContrato(['insurance-sandbox', 'insurance-porto-seguro', 'insurance-yelum', 'insurance-manual'], ['insurance-']);
});

test('m9d238_junto_seguros_sem_api_recusa_toda_operacao', async () => {
  const assert = require('node:assert/strict');
  const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');
  const contract = require('../../../src/features/integrations/contract');
  const { registerBuiltInAdapters } = require('../../../src/features/integrations/adapters');
  registerBuiltInAdapters();
  const cobertura = contract.coverage();
  assert.deepEqual(cobertura.withoutApi.map((x) => x.providerCode), ['insurance-junto-seguros']);
  assert.ok(!cobertura.uncovered.includes('insurance-junto-seguros') && !cobertura.pending.some((p) => p.providerCode === 'insurance-junto-seguros'));
  const A = adapterRegistry.instantiate('insurance-junto-seguros').constructor;
  const adapter = new A({ connection: { id: 'x', providerCode: 'insurance-junto-seguros' }, secret: async () => 'x' });
  for (const op of adapter.capabilities().filter((c) => c !== 'verifyWebhook')) {
    await assert.rejects(() => adapter[op](adapter.ctx, { externalResourceId: 'x' }, {}), (e) => e.code === 'PROCUREMENT_INSURANCE_PROVIDER_NOT_IMPLEMENTED', `${op} deveria recusar`);
  }
});
