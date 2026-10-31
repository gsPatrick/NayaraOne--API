'use strict';

// M9-D914 — o portão de CI (npm run check:lineage, M9-D811) sobre o registro e o mapa reais e sobre cópias adulteradas: campo do mapa sem caminho, mapa e registro divergentes e
// métrica da Torre sem registro ou sem descrição reprovam com o código e a mensagem do livro.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d914Kit');

const registry = kit.readJson(kit.REGISTRY_FILE);
const map = kit.readJson(kit.MAP_FILE);
const without = (reg, predicate) => ({ ...reg, nodes: reg.nodes.filter((n) => !predicate(n, 'node')), edges: reg.edges.filter((e) => !predicate(e, 'edge')) });

test('m9d914 o portão passa com o registro e o mapa reais, com a área MIGRATION em 100%', () => {
  const res = kit.gate(registry, map);
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /percent=100 uncovered=\[\]/);
  const json = JSON.parse(kit.gate(registry, map, ['--json']).out);
  assert.equal(json.ok, true);
  const migration = registry.nodes.filter((n) => n.area === 'MIGRATION' && ['METRIC', 'EXPORT'].includes(n.nodeType)).map((n) => n.code);
  assert.equal(migration.length, 9);
  for (const code of migration) assert.ok(json.critical >= 1 && !json.uncovered.includes(code), code);
});

test('m9d914 campo crítico do mapa sem caminho completo reprova com GOV_LINEAGE_UNCOVERED', () => {
  // o evento da auditoria por lote perde as ligações com os read models: o campo de origem existe, mas não chega a lugar nenhum
  const broken = without(registry, (item, kind) => kind === 'edge' && item.from.code === 'migration.batch.applied');
  const res = kit.gate(broken, map);
  assert.equal(res.status, 1);
  assert.match(res.out, /GOV_LINEAGE_UNCOVERED: Campo de migração sem lineage: LEGADO_ERP\.clientes\.tax_id\./);
  assert.match(res.out, /GOV_LINEAGE_UNCOVERED: KPI crítico sem lineage: MIG_RECONCILED\./);
});

test('m9d914 campo novo no mapa sem lineage reprova o portão (mapa e registro divergem)', () => {
  const extra = [...map, { entity: 'PERSON', sourceSystem: 'LEGADO_ERP', sourceField: 'clientes.rg', domainField: 'people.Person.legalName', critical: true }];
  const res = kit.gate(registry, extra);
  assert.equal(res.status, 1);
  assert.match(res.out, /GOV_LINEAGE_MAP_DRIFT: O mapa de migração e o lineage divergem\./);
  const less = map.filter((r) => r.sourceField !== 'clientes.tax_id');
  const drift = kit.gate(registry, less);
  assert.equal(drift.status, 1, 'campo do registro que saiu do mapa também diverge');
  assert.match(drift.out, /GOV_LINEAGE_MAP_DRIFT/);
});

test('m9d914 métrica da Torre sem registro reprova: KPI crítico sem lineage', () => {
  const gone = without(registry, (item, kind) => (kind === 'node' ? item.code === 'MIG_ETA' : item.to.code === 'MIG_ETA'));
  const res = kit.gate(gone, map);
  assert.equal(res.status, 1);
  assert.match(res.out, /GOV_LINEAGE_UNCOVERED: KPI crítico sem lineage: MIG_ETA\./);
  const exportGone = without(registry, (item, kind) => (kind === 'node' ? item.code === 'EXPORT_MIG_RECONCILIATION' : item.to.code === 'EXPORT_MIG_RECONCILIATION'));
  assert.match(kit.gate(exportGone, map).out, /KPI crítico sem lineage: EXPORT_MIG_RECONCILIATION\./);
});

test('m9d914 métrica MIG_ETA sem descrição reprova o portão', () => {
  const blank = kit.clone(registry);
  blank.nodes.find((n) => n.code === 'MIG_ETA').description = '';
  const res = kit.gate(blank, map);
  assert.equal(res.status, 1);
  assert.match(res.out, /GOV_LINEAGE_NODE_INCOMPLETE: Nó de lineage sem descrição: MIG_ETA\./);
});

test('m9d914 mudar o mapeamento de um campo sem regerar o registro reprova (mesmo commit)', () => {
  const renamed = map.map((r) => (r.sourceField === 'parcelas_itens.amount' ? { ...r, sourceField: 'parcelas_itens.vlr' } : r));
  const res = kit.gate(registry, renamed);
  assert.equal(res.status, 1);
  assert.match(res.out, /GOV_LINEAGE_MAP_DRIFT/);
});
