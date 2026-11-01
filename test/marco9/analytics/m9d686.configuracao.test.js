'use strict';

// M9-D686 (reabertura F01) — contrato de gravação: o PADRÃO de cada parâmetro da Saúde Geral (o mesmo texto que a aba "BI e Centro de Comando" mostra) é aceito pelo serviço
// de parâmetros, gravado e lido de volta sem alteração. Banco descartável (127.0.0.1).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getSeedTenant, withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting, getSetting, SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { RULES, HEALTH_DEFAULTS, AREAS_KEY } = require('../../../src/features/analytics/healthSettings');

const KEYS = [AREAS_KEY, ...Object.keys(RULES)];

test('m9d686 o padrão de cada parâmetro da Saúde Geral é aceito e gravado sem alteração', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const key of KEYS) {
      const value = HEALTH_DEFAULTS[key];
      assert.ok(SETTINGS_SCHEMA[key], `${key} está no catálogo de parâmetros`);
      await upsertSetting(key, value, tenant, tenant.userId, t);
      assert.equal(await getSetting(key, tenant, t, null), value, `${key}: o valor lido é o gravado`);
    }
  });
});

test('m9d686 o sentido do semáforo segue o indicador: vacância sobe para pior, disponibilidade desce', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (t) => {
    for (const value of ['AMARELO > 12%; VERMELHO > 25%', 'AMARELO < 60%; VERMELHO < 40%', 'AMARELO >= 10%; VERMELHO >= 20%']) {
      await upsertSetting('analytics.semaforo.rent_vacancy', value, tenant, tenant.userId, t);
      assert.equal(await getSetting('analytics.semaforo.rent_vacancy', tenant, t, null), value);
    }
  });
});

test('m9d686 o operador chegando como entidade de texto (&gt;) é lido como o sinal', () => {
  const { parseRule } = require('../../../src/features/analytics/dashboards/health/health.rules');
  assert.deepEqual(parseRule('AMARELO &gt; 10%; VERMELHO &gt; 20%'), parseRule('AMARELO > 10%; VERMELHO > 20%'));
  assert.deepEqual(parseRule('AMARELO > 12%; VERMELHO > 25%').red, { operator: 'GT', value: 25 });
});
