'use strict';

// M9-D603 — leitura do registro, valor pronto para a UI, ausência de semente e varredura do Front. Banco descartável (ver m9d603.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sup = require('./analytics.m9d603.support');
const registry = require('../src/features/analytics/metrics');

const { inTx, ctxOf, metricInput } = sup;
const FRONT_ROOT = path.join(__dirname, '..', '..', 'NayaraOne--FRONT');
let env;
let catalog;

before(async () => {
  env = await sup.setup();
  catalog = registry.createFormulaCatalog(env.formulaDir);
});
after(() => sup.teardown(env));

test('m9d603 listar o registry devolve código, nome, owner, unidade, versão e status', async () => {
  await inTx(env.tenantA, {}, async (tx) => {
    const input = metricInput(env);
    await registry.publishMetric(input, ctxOf(env.tenantA), tx, { catalog });
    const lista = await registry.listRegistry(ctxOf(env.tenantA, ['analytics:read', 'finance:read']), {}, tx);
    const m = lista.find((x) => x.metricCode === input.metricCode);
    assert.deepEqual(
      { name: m.name, ownerRole: m.ownerRole, unit: m.unit, version: m.version, status: m.status },
      { name: 'Caixa livre', ownerRole: 'CFO', unit: 'BRL', version: 1, status: 'PUBLISHED' }
    );
    await assert.rejects(registry.listRegistry(ctxOf(env.tenantA, []), {}, tx), (e) => e.code === 'PERMISSION_DENIED');
  });
});

test('m9d603 resposta de métrica traz valor, unidade, versão e sourceRefs', async () => {
  await inTx(env.tenantA, {}, async (tx) => {
    const input = metricInput(env);
    const { definition, version } = await registry.publishMetric(input, ctxOf(env.tenantA), tx, { catalog });
    await sup.metrics.recordSnapshot({
      groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, metricId: definition.id, metricVersionId: version.id,
      scopeType: 'COMPANY', scopeId: env.tenantA.companyId, periodStart: '2026-10-01', periodEnd: '2026-10-31', asOfDate: '2026-10-31',
      valueNumeric: '120000.5000', status: 'OK', sourceSnapshotAt: '2026-10-31T23:00:00Z', sourceRefs: [{ table: 'finance.entries', id: 'abc' }],
      calcHash: createHash('sha256').update('x').digest('hex'),
    }, tx);
    const r = await registry.readMetricValue(ctxOf(env.tenantA, ['analytics:read', 'finance:read']), {
      metricCode: input.metricCode, scopeType: 'COMPANY', scopeId: env.tenantA.companyId, asOfDate: '2026-10-31',
    }, tx);
    assert.equal(r.value, '120000.5000');
    assert.equal(r.unit, 'BRL');
    assert.equal(r.version, 1);
    assert.equal(r.status, 'OK');
    assert.deepEqual(r.sourceRefs, [{ table: 'finance.entries', id: 'abc' }]);
    assert.ok(r.sourceSnapshotAt && r.refreshedAt);
    await assert.rejects(registry.readMetricValue(ctxOf(env.tenantA, ['analytics:read', 'finance:read']), { metricCode: input.metricCode, scopeType: 'COMPANY', scopeId: env.tenantA.companyId, asOfDate: '2026-09-30' }, tx),
      (e) => e.statusCode === 404 && e.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE');
  });
});

test('m9d603 o registro não semeia métrica alguma (a semente é de M9-D712)', async () => {
  const src = fs.readdirSync(path.join(__dirname, '..', 'src', 'features', 'analytics', 'metrics')).filter((f) => f.endsWith('.js'));
  for (const f of src) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'analytics', 'metrics', f), 'utf8');
    assert.ok(!/INSERT INTO analytics\.metric_definitions/.test(text), `${f} não pode semear métrica`);
  }
  const migration = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => /^20260101009603/.test(f)); // 9604 a 9614 pertencem às demais demandas do BI (D604...)
  assert.deepEqual(migration, [], 'D603 não entrega migration de semente');
});

test('m9d603 busca no Front por cálculo de KPI retorna zero', { skip: !fs.existsSync(path.join(FRONT_ROOT, 'app')) && 'repositório do Front ausente' }, () => {
  const { scanFrontForKpiCalculation } = require('../scripts/lib/frontKpiCalcScan');
  const real = scanFrontForKpiCalculation(FRONT_ROOT);
  assert.deepEqual(real.violations, [], 'tela de BI calculando KPI');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d603-front-'));
  try {
    fs.mkdirSync(path.join(dir, 'app', 'painel', 'analytics'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'painel', 'analytics', 'page.js'), [
      'const total = kpis.reduce((a, k) => a + k.value, 0);',
      'const taxa = metric.paid / metric.total;',
      'const ok = formatBRL(metric.value); // so formata',
      'const margem = indicador.receita - indicador.custo;',
      '',
    ].join('\n'));
    const fake = scanFrontForKpiCalculation(dir);
    assert.deepEqual(fake.violations.map((v) => v.line), [1, 2, 4]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
