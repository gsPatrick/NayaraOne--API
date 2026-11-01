'use strict';

// M9-D697 (reabertura F08/F10, 01/11/2026) — a faixa de qualidade diz o MOTIVO e a data da última atualização de cada indicador ruim, e as telas não escrevem o código
// cru do indicador como texto. Banco descartável para a parte da API; leitura do código do Front para a parte da tela.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const e = require('../_helpers/m9d697Env');
const { composeWidgets } = require('../../../src/features/analytics/dashboards/dashboard.compose');
const { incompleteReason, lastUpdateOf, REASONS } = require('../../../src/features/analytics/dashboards/dashboard.reason');

let env;
let tenant;
before(async () => { env = await e.setup(); tenant = env.tenantA; });
after(() => e.teardown(env));

const ctx = () => ({ companyId: tenant.companyId, groupId: tenant.groupId, actorUserId: tenant.userId, permissions: e.PERMS, rowScope: { mode: 'ALL', userIds: [] } });
const row = (position, widget_type, extra = {}) => ({ position, widget_type, metric_code: null, dimension_key: '', title: `w${position}`, value_nature: 'ACTUAL', drilldown_enabled: false, config: {}, ...extra });
const FRONT = path.resolve(__dirname, '../../../../NayaraOne--FRONT');
const read = (rel) => fs.readFileSync(path.join(FRONT, rel), 'utf8');

test('m9d697 faixa de qualidade traz o motivo e a data da última atualização de cada indicador ruim', async () => {
  const ruim = await e.freshMetric(env, tenant);
  const velha = await e.freshMetric(env, tenant, { ageMinutes: 120 });
  await e.recordCheck(tenant, { metrics: [ruim.code] });
  const widgets = [row(0, 'QUALITY_BANNER'), row(1, 'KPI_CARD', { metric_code: ruim.code }), row(2, 'KPI_CARD', { metric_code: velha.code })];
  const out = await e.inTx(tenant, {}, (tx) => composeWidgets(ctx(), widgets, e.TODAY, tx));
  const list = out.widgets[0].banner.degradedMetrics;
  const bad = list.find((d) => d.metricCode === ruim.code);
  assert.equal(bad.detail, REASONS.CHECK, 'a verificação reprovada é dita em português, sem o código do check');
  assert.ok(!bad.detail.includes('recon_saldo'), 'nada do código do check no texto');
  assert.ok(bad.lastUpdateAt === null || !Number.isNaN(Date.parse(bad.lastUpdateAt)), 'última atualização é data ISO ou nula');
  const stale = list.find((d) => d.metricCode === velha.code);
  assert.equal(stale.detail, REASONS.STALE);
  assert.deepEqual(out.quality.degradedMetrics.map((d) => d.metricCode).sort(), list.map((d) => d.metricCode).sort(), 'o resumo de qualidade leva as mesmas linhas');
});

test('m9d697 motivo por tipo de problema: nunca atualizado, expirado, herança, amostra', () => {
  assert.equal(incompleteReason({ freshness: { state: 'UNKNOWN' }, status: 'INCOMPLETE', incomplete: true }), REASONS.NEVER);
  assert.equal(incompleteReason({ freshness: { state: 'EXPIRED' }, status: 'DEGRADED' }), REASONS.EXPIRED);
  assert.equal(incompleteReason({ freshness: { state: 'FRESH' }, status: 'DEGRADED', quality: { inheritedFrom: [{ metricCode: 'x' }] } }), REASONS.INHERITED);
  assert.equal(incompleteReason({ freshness: { state: 'FRESH' }, status: 'INCOMPLETE', incomplete: true }), REASONS.SAMPLE);
  assert.equal(incompleteReason({ freshness: { state: 'FRESH' }, status: 'OK' }), null, 'indicador confiável não tem motivo');
  assert.equal(lastUpdateOf({ freshness: {} }), null);
  assert.equal(lastUpdateOf({ freshness: { sourceSnapshotAt: '2026-10-28T12:00:00Z' } }), '2026-10-28T12:00:00.000Z');
});

test('m9d697 telas: faixa e bloco adiado mostram nome, motivo e data, e nunca o código do indicador como texto', () => {
  const block = read('components/organisms/CommandCenter/CommandBlock.js');
  assert.ok(!/>\s*\{r\.metricCode\}|\{r\.metricCode\}:/.test(block), 'o bloco adiado não escreve metricCode como texto');
  assert.match(block, /r\.name/);
  assert.match(block, /lastUpdateAt/);
  const banner = read('components/molecules/analytics/BiBanner/BiBanner.js');
  assert.match(banner, /BiBannerDetail/);
  const detail = read('components/molecules/analytics/BiBanner/BiBannerDetail.js');
  assert.match(detail, /lastUpdateAt/);
  assert.match(detail, /Sem atualização registrada/);
  for (const rel of ['components/molecules/analytics', 'components/organisms/CommandCenter', 'components/organisms/BiDashboard']) {
    const dir = path.join(FRONT, rel);
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const code = fs.readFileSync(path.join(dir, f), 'utf8');
      const asText = [...code.matchAll(/>\s*\{(?:\w+\.)*metricCode\}\s*</g)];
      assert.equal(asText.length, 0, `${rel}/${f}: metricCode como texto visível`);
    }
  }
});
