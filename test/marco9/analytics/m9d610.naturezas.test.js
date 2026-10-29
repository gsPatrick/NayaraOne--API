'use strict';

// M9-D610 (BI-006) — previsto, realizado, estimado e projetado distintos. Banco descartável (ver analytics.m9d603.test.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sup = require('../../analytics.m9d603.support');
const registry = require('../../../src/features/analytics/metrics');
const { sequelize } = require('../../testHelpers');

const { inTx, ctxOf, metricInput } = sup;
const FRONT_ROOT = path.join(__dirname, '..', '..', '..', '..', 'NayaraOne--FRONT');
const HAS_FRONT = fs.existsSync(path.join(FRONT_ROOT, 'app'));
const formula = (id, extra) => `module.exports = { id: '${id}', version: 1, ${extra}
  compute: (rows) => ({ value: String(rows.length) }),
  testCases: [{ name: 'um', input: [{}], expected: { value: '1' } }] };`;
let env;
let catalog;

before(async () => {
  env = await sup.setup();
  fs.writeFileSync(path.join(env.formulaDir, 'mistura.js'), formula('fin.m9d610_mistura', 'mixesNatures: true,'));
  fs.writeFileSync(path.join(env.formulaDir, 'entradas_mistas.js'), formula('fin.m9d610_entradas_mistas', "inputNatures: ['ACTUAL', 'PLANNED'],"));
  fs.writeFileSync(path.join(env.formulaDir, 'so_previsto.js'), formula('fin.m9d610_so_previsto', "inputNatures: ['PLANNED'],"));
  catalog = registry.createFormulaCatalog(env.formulaDir);
});
after(() => sup.teardown(env));

const inA = (fn) => inTx(env.tenantA, {}, fn);
const publish = (input, tx) => registry.publishMetric(input, ctxOf(env.tenantA), tx, { catalog });

async function expectErr(promise, status, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.statusCode, status, `${e.code}: ${e.message}`);
    assert.equal(e.code, code);
    return true;
  });
}

test('m9d610 toda métrica seed tem exatamente uma value_nature', async () => {
  await inA(async (tx) => {
    for (const nature of registry.VALUE_NATURES) {
      const { version } = await publish(metricInput(env, { valueNature: nature }), tx);
      assert.equal(version.value_nature, nature);
    }
    await expectErr(publish(metricInput(env, { valueNature: undefined }), tx), 422, 'ANALYTICS_METRIC_INCOMPLETE');
    await expectErr(publish(metricInput(env, { valueNature: 'REAL' }), tx), 400, 'ANALYTICS_METRIC_INVALID');
    const [[bad]] = await sequelize.query(
      `SELECT count(*)::int AS n FROM analytics.metric_versions WHERE value_nature IS NULL OR value_nature NOT IN ('ACTUAL','PLANNED','ESTIMATED','PROJECTED')`, { transaction: tx });
    assert.equal(bad.n, 0, 'nenhuma versão fora das 4 naturezas');
  });
  assert.deepEqual([...registry.VALUE_NATURES], ['ACTUAL', 'PLANNED', 'ESTIMATED', 'PROJECTED']);
});

test('m9d610 fórmula que soma ACTUAL com PLANNED é recusada no registro', async () => {
  await inA(async (tx) => {
    await expectErr(publish(metricInput(env, { formulaId: 'fin.m9d610_mistura', unit: 'BRL' }), tx), 422, 'ANALYTICS_FORMULA_MIXES_NATURES');
    await expectErr(publish(metricInput(env, { formulaId: 'fin.m9d610_mistura', unit: 'BRL_PER_UNIT' }), tx), 422, 'ANALYTICS_FORMULA_MIXES_NATURES');
    // lê naturezas diferentes sem declarar mixesNatures: recusada mesmo assim (e em KPI monetário não há como declarar)
    await expectErr(publish(metricInput(env, { formulaId: 'fin.m9d610_entradas_mistas', unit: 'BRL' }), tx), 422, 'ANALYTICS_FORMULA_MIXES_NATURES');
    await expectErr(publish(metricInput(env, { formulaId: 'fin.m9d610_entradas_mistas', unit: 'COUNT' }), tx), 422, 'ANALYTICS_FORMULA_MIXES_NATURES');
    // fórmula que só lê PLANNED não pode ser publicada como ACTUAL
    await expectErr(publish(metricInput(env, { formulaId: 'fin.m9d610_so_previsto', valueNature: 'ACTUAL' }), tx), 422, 'ANALYTICS_FORMULA_MIXES_NATURES');
    const ok = await publish(metricInput(env, { formulaId: 'fin.m9d610_so_previsto', valueNature: 'PLANNED' }), tx);
    assert.equal(ok.version.value_nature, 'PLANNED');
    // mistura declarada em indicador que não é dinheiro continua permitida
    const count = await publish(metricInput(env, { formulaId: 'fin.m9d610_mistura', unit: 'COUNT' }), tx);
    assert.equal(count.version.unit, 'COUNT');
  });
});

test('m9d610 API devolve séries separadas por natureza', async () => {
  const series = registry.buildSeriesByNature([
    { valueNature: 'PLANNED', key: '2026-10', value: '40000.00' },
    { valueNature: 'ACTUAL', key: '2026-10', value: '80000.00' },
    { valueNature: 'PLANNED', key: '2026-11', value: '10000.50' },
    { valueNature: 'PROJECTED', key: '2026-10', value: '1.10' },
  ]);
  assert.deepEqual(series.map((s) => [s.valueNature, s.label, s.total]), [
    ['ACTUAL', 'Realizado', '80000.00'], ['PLANNED', 'Previsto', '50000.50'], ['PROJECTED', 'Projetado', '1.10'],
  ]);
  assert.ok(!series.some((s) => s.total === '130001.60'), 'nenhum total mistura naturezas');
  assert.throws(() => registry.buildSeriesByNature([{ valueNature: 'REAL', key: 'x', value: '1' }]), (e) => e.code === 'ANALYTICS_SERIES_INVALID');

  // A leitura por data devolve a natureza e o rótulo em português.
  await sup.inTx(env.tenantA, {}, async (tx) => {
    const { definition, version } = await publish(metricInput(env, { valueNature: 'PLANNED' }), tx);
    await sup.metrics.recordSnapshot({
      groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, metricId: definition.id, metricVersionId: version.id, scopeType: 'COMPANY',
      scopeId: env.tenantA.companyId, periodStart: '2026-10-01', periodEnd: '2026-10-31', asOfDate: '2026-10-27', valueNumeric: '40000', status: 'OK',
      calcHash: registry.calcHash({ metricCode: definition.metric_code, version: 1, inputs: [{ v: 40000 }], params: {} }),
    }, tx);
    const read = await registry.readMetricAsOf(ctxOf(env.tenantA, ['analytics:read']), {
      metricCode: definition.metric_code, scopeType: 'COMPANY', scopeId: env.tenantA.companyId, asOfDate: '2026-10-27',
    }, tx);
    assert.deepEqual([read.valueNature, read.valueNatureLabel], ['PLANNED', 'Previsto']);
  });
});

test('m9d610 componente declara rótulo Previsto/Estimado/Projetado em legenda e tooltip', { skip: !HAS_FRONT && 'repositório do Front ausente' }, async () => {
  // Sem navegador nesta bateria: o contrato do componente é conferido na fonte; a prova na tela é o roteiro QA-M9 da demanda (seção 9).
  const { NATURE_INFO, NATURE_ORDER } = await import(path.join(FRONT_ROOT, 'lib', 'analytics', 'valueNature.js'));
  assert.deepEqual(NATURE_ORDER.map((n) => NATURE_INFO[n].label), ['Realizado', 'Previsto', 'Estimado', 'Projetado']);
  const source = fs.readFileSync(path.join(FRONT_ROOT, 'components', 'molecules', 'analytics', 'NatureSeriesChart', 'NatureSeriesChart.js'), 'utf8');
  assert.match(source, /<Tooltip key=\{nature\} label=\{`\$\{info\.label\}: \$\{shown\}`\}/, 'tooltip com o rótulo da natureza');
  assert.match(source, /export function NatureLegend/, 'legenda exportada');
  assert.match(source, /<strong>\{info\.label\}<\/strong>/, 'legenda mostra o rótulo');
  const tab = fs.readFileSync(path.join(FRONT_ROOT, 'app', 'painel', 'configuracoes', 'BiTab.js'), 'utf8');
  assert.match(tab, /<NatureLegend \/>/, 'a legenda aparece na aba BI e Centro de Comando');
});

test('m9d610 distinção não depende só de cor (texto e padrão presentes)', { skip: !HAS_FRONT && 'repositório do Front ausente' }, async () => {
  const { NATURE_INFO, NATURE_ORDER } = await import(path.join(FRONT_ROOT, 'lib', 'analytics', 'valueNature.js'));
  const patterns = NATURE_ORDER.map((n) => NATURE_INFO[n].pattern);
  assert.equal(new Set(patterns).size, 4, 'um padrão diferente por natureza');
  const css = fs.readFileSync(path.join(FRONT_ROOT, 'components', 'molecules', 'analytics', 'NatureSeriesChart', 'NatureSeriesChart.module.css'), 'utf8');
  for (const p of patterns) assert.match(css, new RegExp(`^\\.${p}\\s*\\{`, 'm'), `regra de estilo do padrão ${p}`);
  assert.match(css, /repeating-linear-gradient/, 'hachura');
  assert.match(css, /border-style: dashed/, 'tracejado');
  assert.match(css, /border-style: dotted/, 'pontilhado');
  for (const n of NATURE_ORDER) assert.ok(NATURE_INFO[n].label.length > 0 && NATURE_INFO[n].patternName.length > 0, 'texto do rótulo e do padrão');
});
