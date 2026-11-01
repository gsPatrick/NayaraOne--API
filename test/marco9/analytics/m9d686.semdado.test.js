'use strict';

// M9-D686 (reabertura F09) — sem dado atual a área é CINZA e nunca vermelha; o motivo traz o nome do indicador (nunca o código) e o resumo soma as áreas. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e686 = require('../_helpers/m9d686Env');
const { AREAS } = require('../../../src/features/analytics/dashboards/health/health.areas');

const { seedHealth, openHealth, areaOf, alertOf, clearHealth } = e686;
let env;
const { listCriticalityRows } = require('../../../src/features/analytics/metrics/seed/criticality.table');
/** Todo indicador que a linha da área lê: os KPIs principais e os críticos dos domínios dela. */
const areaCodes = (key) => {
  const area = AREAS.find((a) => a.key === key);
  return [...new Set([...area.kpis, ...listCriticalityRows().filter((r) => r.criticality === 'CRITICAL' && area.domains.includes(r.domain)).map((r) => r.code)])].filter((c) => e686.AREA_CODES.includes(c));
};

before(async () => { env = await e686.setup(); await clearHealth(env); });
after(async () => { await clearHealth(env); await e686.teardown(env); });

test('m9d686 área sem atualização nenhuma fica cinza, nunca vermelha, mesmo com alerta crítico aberto', async () => {
  const never = areaCodes('COMMERCIAL');
  assert.ok(never.length >= 3);
  await seedHealth(env, {}, { never });
  await alertOf(env, env.tenantA, { metricCode: 'crm.portfolio_without_next_action', severity: 'CRITICAL', status: 'OPEN' });
  const row = areaOf(await openHealth(env), 'COMMERCIAL');
  assert.deepEqual([row.light.color, row.light.text, row.noData], ['CINZA', 'Sem dados suficientes', true]);
  assert.notEqual(row.light.color, 'VERMELHO');
});

test('m9d686 um indicador sem atualização entre outros com dado só impede o verde (amarelo)', async () => {
  await clearHealth(env);
  await seedHealth(env, {}, { never: ['crm.proposals'] });
  const row = areaOf(await openHealth(env), 'COMMERCIAL');
  assert.equal(row.light.color, 'AMARELO');
});

test('m9d686 os motivos usam o nome do indicador, sem código, e o resumo soma as áreas', async () => {
  await clearHealth(env);
  await seedHealth(env, {}, { never: ['fin.approvals_pending'], degraded: ['fin.free_cash'] });
  const res = await openHealth(env);
  const finance = areaOf(res, 'FINANCE');
  assert.ok(finance.reasons.length > 0);
  for (const reason of finance.reasons) assert.doesNotMatch(reason, /\b[a-z]+\.[a-z_0-9]+\b/, `motivo sem código cru: ${reason}`);
  assert.ok(finance.reasons.some((r) => /Aprovações financeiras pendentes: ainda sem atualização/.test(r)), JSON.stringify(finance.reasons));
  const s = res.body.data.summary;
  assert.equal(s.verde + s.amarelo + s.vermelho + s.cinza, s.areas);
  const counted = { VERDE: 0, AMARELO: 0, VERMELHO: 0, CINZA: 0 };
  for (const a of res.body.data.areas) counted[a.light.color] += 1;
  assert.deepEqual([s.verde, s.amarelo, s.vermelho, s.cinza], [counted.VERDE, counted.AMARELO, counted.VERMELHO, counted.CINZA]);
});
