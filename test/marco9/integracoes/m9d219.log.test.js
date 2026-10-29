'use strict';

// Marco 9, M9-D219 — o log traz só NOMES de campos descartados e contadores, nunca valores (teste 7).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe } = require('../../integrations/dispatch/dispatchHelpers');
const logger = require('../../../src/utils/logger');
const { minimizePayload } = require('../../../src/features/integrations/minimization');
const { PORTS } = require('../../../src/features/integrations/providers/ports');
const { imovelCom40Campos } = require('../_helpers/intImovel');

let tenant;
before(async () => { ({ tenant } = await carregarTenants()); });
after(async () => { await sequelize.close(); });

test('minimizacao_log_so_nomes_de_campos', async () => {
  const linhas = [];
  const original = logger.info;
  logger.info = (...args) => { linhas.push(JSON.stringify(args)); };
  try {
    const mapper = PORTS.PORTAL.operations.publishListing.outputMapper;
    await comTenant(tenant, (t) => minimizePayload({ domain: 'PORTAL', operation: 'publishListing', mapper }, imovelCom40Campos('CANARY-LOG'), ctxDe(tenant), t));
  } finally {
    logger.info = original;
  }
  const registro = linhas.find((l) => l.includes('integration.payload.minimized'));
  assert.ok(registro, 'o descarte foi registrado');
  const [obj] = JSON.parse(registro);
  assert.equal(obj.fields_dropped, 28, 'contador fields_dropped');
  assert.equal(obj.fields_kept, 12);
  assert.ok(obj.dropped_fields.includes('owner_document'), 'o nome do campo aparece');
  assert.ok(!registro.includes('CANARY-LOG'), 'nenhum valor aparece');
  assert.ok(!registro.includes('Centro') && !registro.includes('450000'), 'nem os valores dos campos mantidos');
});
