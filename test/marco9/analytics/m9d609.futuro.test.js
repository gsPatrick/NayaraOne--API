'use strict';

// M9-D609 (reabertura L-1) — carimbo da fonte no futuro não é "fresco com idade 0": vira dado inválido (UNKNOWN, INCOMPLETE, sem valor),
// com folga parametrizada para relógio levemente adiantado. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d609Env');
const { computeFreshness, FUTURE_TEXT } = require('../../../src/features/analytics/metrics/freshness');
const { DEFAULTS, K, QUALITY_SETTINGS_SCHEMA } = require('../../../src/features/analytics/quality/quality.settings');

const NOW = '2026-10-29T15:00:00Z';
const TODAY = '2026-10-29';
const shifted = (minutes) => new Date(new Date(NOW).getTime() + minutes * 60000).toISOString();
let env;
let tenant;

before(async () => {
  env = await e.setup();
  tenant = env.tenantA;
  e.at(NOW);
});
after(() => e.teardown(env));

const base = { maxStalenessMinutes: 60, factor: 4, now: new Date(NOW), refreshedAt: NOW };

test('m9d609 carimbo no futuro além da folga é UNKNOWN com rótulo próprio e a folga é parâmetro', () => {
  assert.equal(DEFAULTS[K.futureTolerance], 5);
  assert.deepEqual(QUALITY_SETTINGS_SCHEMA[K.futureTolerance], { type: 'integer', min: 0, max: 1440 });
  const dentro = computeFreshness({ ...base, sourceSnapshotAt: shifted(5) });
  assert.equal(dentro.state, 'FRESH', 'dentro da folga de 5 min continua fresco');
  assert.equal(dentro.futureStamp, false);
  const fora = computeFreshness({ ...base, sourceSnapshotAt: shifted(6) });
  assert.equal(fora.state, 'UNKNOWN');
  assert.equal(fora.futureStamp, true);
  assert.equal(fora.ageMinutes, null);
  assert.equal(fora.label, FUTURE_TEXT);
  assert.equal(computeFreshness({ ...base, sourceSnapshotAt: shifted(1440) }).state, 'UNKNOWN', 'o exemplo da auditoria: 24 h à frente');
  assert.equal(computeFreshness({ ...base, sourceSnapshotAt: shifted(30), futureToleranceMinutes: 60 }).state, 'FRESH', 'folga maior configurada pelo administrador');
  assert.equal(computeFreshness({ ...base, sourceSnapshotAt: shifted(1), futureToleranceMinutes: 0 }).state, 'UNKNOWN', 'folga zero: qualquer adiantamento é inválido');
  assert.equal(computeFreshness({ ...base, sourceSnapshotAt: shifted(0), futureToleranceMinutes: 0 }).state, 'FRESH', 'igual ao relógio não é futuro');
});

test('m9d609 leitura da métrica com source_snapshot_at 24 h no futuro vem INCOMPLETE, sem valor e não confiável', async () => {
  const m = await e.publish(env, tenant, {});
  await e.snapshot(tenant, { ...m, asOfDate: TODAY, sourceSnapshotAt: shifted(1440), refreshedAt: NOW });
  const r = await e.readValue(tenant, m.code, TODAY);
  assert.equal(r.freshness.state, 'UNKNOWN');
  assert.equal(r.freshness.futureStamp, true);
  assert.equal(r.status, 'INCOMPLETE');
  assert.equal(r.value, null);
  assert.equal(r.valueReliable, false);
  const asOf = await e.readAsOf(tenant, m.code, TODAY);
  assert.equal(asOf.freshness.futureStamp, true, 'a leitura por data traz o mesmo veredito');
  assert.equal(asOf.value, null);
});

test('m9d609 check de qualidade FRESHNESS reprova carimbo no futuro com estado FUTURE', async () => {
  const { sequelize } = require('../../../src/models');
  const types = require('../../../src/features/analytics/quality/types');
  const original = sequelize.query;
  const check = types.freshness({ code: 'frescor', domain: 'FINANCE', metrics: [] });
  const ctx = { table: 'rm_qualquer', scope: { companyId: tenant.companyId }, params: { freshnessLimits: { FINANCE: 60 }, freshnessFactor: 4, futureToleranceMinutes: 5 } };
  try {
    let calls = 0;
    sequelize.query = async () => { calls += 1; return [[{ v: calls === 1 ? shifted(1440) : NOW }]]; };
    const out = await check.run(ctx);
    assert.equal(out.passed, false);
    assert.equal(out.severityKey, 'FRESHNESS_EXPIRED');
    assert.equal(out.observed.state, 'FUTURE');
    calls = 0;
    sequelize.query = async () => { calls += 1; return [[{ v: calls === 1 ? shifted(3) : NOW }]]; };
    assert.equal((await check.run(ctx)).passed, true, 'dentro da folga passa');
  } finally {
    sequelize.query = original;
  }
});
