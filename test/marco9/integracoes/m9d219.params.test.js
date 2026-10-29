'use strict';

// Marco 9, M9-D219 — parâmetro de classificação máxima por família: a empresa só consegue ser mais restritiva que o livro.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe, config } = require('../../integrations/dispatch/dispatchHelpers');
const minimization = require('../../../src/features/integrations/minimization');
const { PORTS } = require('../../../src/features/integrations/providers/ports');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { maxKey } = require('../../../src/features/integrations/minimization/minimization.settings');

let tenant;
before(async () => { ({ tenant } = await carregarTenants()); });
after(async () => { await sequelize.close(); });

const max = (domain) => comTenant(tenant, (t) => minimization.resolveMaxClassification(domain, ctxDe(tenant), t));

test('minimizacao_parametro_so_restringe', async () => {
  assert.ok(SETTINGS_SCHEMA[maxKey('MESSAGING')], 'a chave existe no dicionário do administrador');
  assert.equal(await max('MESSAGING'), 'PERSONAL', 'padrão = o do livro');
  await config(tenant, maxKey('MESSAGING'), 'INTERNAL');
  assert.equal(await max('MESSAGING'), 'INTERNAL', 'a empresa restringiu');
  await config(tenant, maxKey('MESSAGING'), 'SENSITIVE');
  assert.equal(await max('MESSAGING'), 'PERSONAL', 'subir acima do livro não vale');
  await config(tenant, maxKey('PORTAL'), 'PERSONAL');
  assert.equal(await max('PORTAL'), 'PUBLIC');
  await config(tenant, maxKey('MESSAGING'), 'PERSONAL');
});

test('minimizacao_parametro_restrito_vale_no_envio', async () => {
  await config(tenant, maxKey('MESSAGING'), 'INTERNAL');
  try {
    const mapper = PORTS.MESSAGING.operations.sendText.outputMapper;
    await assert.rejects(
      comTenant(tenant, (t) => minimization.minimizePayload({ domain: 'MESSAGING', operation: 'sendText', mapper }, { to: '+5541999990000', text: 'oi' }, ctxDe(tenant), t)),
      (e) => e.code === 'INTEGRATION_PAYLOAD_CLASSIFICATION_VIOLATION', 'o destinatário (PERSONAL) deixou de caber'
    );
  } finally {
    await config(tenant, maxKey('MESSAGING'), 'PERSONAL');
  }
});

test('minimizacao_schema_recusa_valor_fora_da_escala', async () => {
  const settingsService = require('../../../src/features/settings/settings.service');
  await assert.rejects(
    comTenant(tenant, (t) => settingsService.upsertSetting(maxKey('BANK'), 'SECRETO', tenant, tenant.userId, t)),
    (e) => e.statusCode === 400 || e.statusCode === 422
  );
});
