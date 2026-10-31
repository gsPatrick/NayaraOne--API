'use strict';

// M9-D914 — a semente MIGRATION entra no registro único (M9-D810) e o arquivo versionado a contém: caminhos de cinco camadas, métricas e relatórios críticos, geração determinística.
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d914Kit');
const { loadSeeds, DEFAULT_DIR } = require('../../../src/features/core-governance/lineage/lineage.seed');
const { serializeRegistry } = require('../../../src/features/core-governance/lineage/lineage.registryFormat');
const { computeCoverage } = require('../../../src/features/core-governance/lineage/lineage.coverage');
const { METRICS, EXPORTS, EVENT_CODE } = require('../../../src/features/core-governance/lineage/kit/migrationCatalog');
const { sourceCode } = require('../../../src/features/core-governance/lineage/kit/migrationMap');

const registry = kit.readJson(kit.REGISTRY_FILE);
const map = kit.readJson(kit.MAP_FILE);
const LAYERS = ['SOURCE_FIELD', 'DOMAIN_FIELD', 'EVENT', 'READ_MODEL'];

test('m9d914 todo campo crítico do mapa tem caminho de 5 camadas', () => {
  const critical = map.filter((r) => r.critical);
  assert.ok(critical.length > 40);
  for (const row of critical) {
    const trail = kit.pathFrom(registry, 'SOURCE_FIELD', sourceCode(row), { via: EVENT_CODE });
    assert.ok(trail, `${sourceCode(row)} não chega a uma métrica ou relatório`);
    assert.equal(trail.length, 5, sourceCode(row));
    assert.deepEqual(trail.slice(0, 4).map((n) => n.nodeType), LAYERS);
    assert.ok(['METRIC', 'EXPORT'].includes(trail[4].nodeType));
    assert.equal(trail[1].code, row.domainField, 'a segunda camada é o campo de domínio do mapa');
    assert.equal(trail[2].code, EVENT_CODE, 'a camada de evento é a auditoria por lote');
    for (const ref of trail) {
      const node = registry.nodes.find((n) => n.nodeType === ref.nodeType && n.code === ref.code);
      assert.ok(node && node.description && node.ownerDomain, `${ref.nodeType} ${ref.code} sem descrição ou responsável`);
    }
  }
  // exemplo do livro: parcela -> domínio -> auditoria do lote -> registro -> métrica
  const parcela = kit.pathFrom(registry, 'SOURCE_FIELD', 'LEGADO_ERP.parcelas_itens.amount', { via: EVENT_CODE, to: 'MIG_RECONCILED' });
  assert.deepEqual(parcela.map((n) => n.code).slice(0, 4), ['LEGADO_ERP.parcelas_itens.amount', 'finance.BillingScheduleItem.amount', 'migration.batch.applied', 'governance.mig_records']);
});

test('m9d914 só campo crítico entra no registro: o campo não crítico do mapa não vira nó de origem', () => {
  const sources = registry.nodes.filter((n) => n.nodeType === 'SOURCE_FIELD' && n.area === 'MIGRATION').map((n) => n.code).sort();
  assert.deepEqual(sources, map.filter((r) => r.critical).map(sourceCode).sort());
  assert.ok(map.some((r) => !r.critical), 'o mapa lista também campos não críticos');
  for (const row of map.filter((r) => !r.critical)) assert.ok(!sources.includes(sourceCode(row)));
});

test('m9d914 métricas e relatórios da migração são críticos, da área MIGRATION e cobertos', () => {
  const wanted = [...METRICS.map((m) => ['METRIC', m.code]), ...EXPORTS.map((e) => ['EXPORT', e.code])];
  assert.deepEqual(wanted.map(([, code]) => code), ['MIG_TOTAL', 'MIG_MIGRATED', 'MIG_QUARANTINED', 'MIG_PENDING_REVIEW', 'MIG_RECONCILED', 'MIG_ETA', 'MIG_BLOCKERS', 'EXPORT_MIG_RECONCILIATION', 'EXPORT_MIG_DISPOSAL']);
  for (const [nodeType, code] of wanted) {
    const node = registry.nodes.find((n) => n.nodeType === nodeType && n.code === code);
    assert.ok(node, `${code} registrado`);
    assert.deepEqual([node.area, node.criticality], ['MIGRATION', 'CRITICAL'], code);
    assert.ok(node.description.length > 30 && node.ownerDomain, `${code} com descrição e responsável`);
  }
  const coverage = computeCoverage(registry, wanted.map(([nodeType, code]) => ({ nodeType, code, criticality: 'CRITICAL', area: 'MIGRATION' })));
  assert.deepEqual(coverage.uncovered, []);
  assert.equal(coverage.percent, 100);
});

test('m9d914 MIG_RECONCILED tem no registro todos os campos que o alimentam', () => {
  assert.deepEqual(registry.edges.filter((e) => e.to.code === 'MIG_RECONCILED').map((e) => e.from.code), ['governance.mig_records']);
  const critical = map.filter((r) => r.critical);
  for (const row of critical) {
    const trail = kit.pathFrom(registry, 'SOURCE_FIELD', sourceCode(row), { via: EVENT_CODE, to: 'MIG_RECONCILED' });
    assert.ok(trail, `${sourceCode(row)} não alimenta MIG_RECONCILED`);
    assert.deepEqual(trail.map((n) => n.nodeType), [...LAYERS, 'METRIC']);
  }
  assert.ok(critical.length > 40);
});

test('m9d914 relatório de reconciliação tem lineage (e o de descarte também)', () => {
  for (const code of ['EXPORT_MIG_RECONCILIATION', 'EXPORT_MIG_DISPOSAL']) {
    const node = registry.nodes.find((n) => n.nodeType === 'EXPORT' && n.code === code);
    assert.ok(node);
    const into = registry.edges.filter((e) => e.to.nodeType === 'EXPORT' && e.to.code === code);
    assert.equal(into.length, 1);
    assert.equal(into[0].from.code, 'governance.mig_records');
    const trail = kit.pathFrom(registry, 'SOURCE_FIELD', 'LEGADO_ERP.clientes.tax_id', { via: EVENT_CODE, to: code });
    assert.deepEqual(trail.map((n) => n.nodeType), [...LAYERS, 'EXPORT'], `CPF/CNPJ do legado chega a ${code}`);
  }
});

test('m9d914 a semente MIGRATION entra no registro único sem criar outro arquivo ou gerador', () => {
  const seeds = fs.readdirSync(DEFAULT_DIR).filter((f) => f.endsWith('.seed.js'));
  assert.ok(seeds.includes('migration.seed.js'));
  const loaded = loadSeeds();
  assert.ok(loaded.nodes.some((n) => n.area === 'MIGRATION' && n.nodeType === 'METRIC'), 'o carregador da D810 traz a área MIGRATION');
  assert.ok(loaded.nodes.some((n) => n.area === 'MIGRATION' && n.nodeType === 'SOURCE_FIELD'));
  // um só arquivo de registro e um só gerador
  const govFiles = fs.readdirSync(path.join(kit.ROOT, 'docs/governance')).filter((f) => /lineage/i.test(f));
  assert.deepEqual(govFiles, ['lineage-registry.json']);
  const writers = fs.readdirSync(path.join(kit.ROOT, 'scripts')).filter((f) => f.endsWith('.js') && /lineage/i.test(fs.readFileSync(path.join(kit.ROOT, 'scripts', f), 'utf8')) && /writeFileSync/.test(fs.readFileSync(path.join(kit.ROOT, 'scripts', f), 'utf8')));
  assert.deepEqual(writers, ['syncLineageRegistry.js']);
  const migrationLineageFiles = fs.readdirSync(path.join(kit.ROOT, 'src/features/migration-v2'), { recursive: true }).filter((f) => /lineage/i.test(String(f)));
  assert.deepEqual(migrationLineageFiles, [], 'a migração não cria registro de lineage próprio');
  assert.equal(JSON.stringify(Object.keys(registry)), JSON.stringify(['version', 'seedHash', 'nodes', 'edges']));
});

test('m9d914 geração é determinística e o arquivo versionado é exatamente o das sementes', () => {
  const first = loadSeeds();
  const second = loadSeeds();
  assert.equal(first.hash, second.hash);
  assert.equal(serializeRegistry(first), serializeRegistry(second));
  const onDisk = fs.readFileSync(kit.REGISTRY_FILE, 'utf8');
  assert.equal(serializeRegistry(first), onDisk, 'rode npm run sync:lineage: o arquivo difere das sementes');
  // a ordem das sementes não muda o resultado: o carregador ordena
  const { mapProblems } = require('../../../src/features/core-governance/lineage/lineage.gate');
  assert.deepEqual(mapProblems(registry, map), []);
});
