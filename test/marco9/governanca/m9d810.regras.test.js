'use strict';

// M9-D810 — regras puras do registro de lineage (camadas, criticidade travada, cobertura). Não precisa de banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../../src/features/core-governance/lineage/lineage.rules');
const { computeCoverage } = require('../../../src/features/core-governance/lineage/lineage.coverage');
const { LAYERS, MANDATORY_AREAS } = require('../../../src/features/core-governance/lineage/lineage.constants');

const err = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const node = (nodeType, code, extra = {}) => ({ nodeType, code, description: `Nó ${code}`, ownerDomain: 'FINANCEIRO', criticality: 'CRITICAL', area: 'EXEC_KPI', ...extra });
const edge = (from, to) => ({ from: { nodeType: from.nodeType, code: from.code }, to: { nodeType: to.nodeType, code: to.code }, transformation: 't' });
function chain(code = 'k.a', overrides = {}) {
  const nodes = ['SOURCE_FIELD', 'DOMAIN_FIELD', 'EVENT', 'READ_MODEL', 'METRIC'].map((t) => node(t, t === 'METRIC' ? code : `${code}.${t}`, overrides[t]));
  return { nodes, edges: nodes.slice(1).map((n, i) => edge(nodes[i], n)) };
}
const target = (code = 'k.a', criticality = 'CRITICAL', area = 'EXEC_KPI') => ({ nodeType: 'METRIC', code, criticality, area });

test('m9d810 as seis camadas e a ordem são as do livro', () => {
  assert.deepEqual(LAYERS, ['SOURCE_FIELD', 'DOMAIN_FIELD', 'EVENT', 'READ_MODEL', ['METRIC', 'EXPORT']]);
  assert.deepEqual([...MANDATORY_AREAS].sort(), ['COMMISSION', 'CONTRACT', 'DIMOB', 'EXEC_KPI', 'MIGRATION', 'MONEY']);
  for (const [from, to] of [['SOURCE_FIELD', 'DOMAIN_FIELD'], ['DOMAIN_FIELD', 'EVENT'], ['EVENT', 'READ_MODEL'], ['READ_MODEL', 'METRIC'], ['READ_MODEL', 'EXPORT']]) {
    assert.equal(err(() => rules.assertEdgeLayers(from, to)), null, `${from} -> ${to}`);
  }
});

test('m9d810 aresta que pula camada é recusada', () => {
  const e = err(() => rules.assertEdgeLayers('SOURCE_FIELD', 'METRIC'));
  assert.deepEqual([e.statusCode, e.code, e.message], [422, 'GOV_LINEAGE_LAYER_INVALID', 'Esta ligação não respeita a ordem das camadas.']);
  assert.equal(err(() => rules.assertEdgeLayers('SOURCE_FIELD', 'EVENT')).code, 'GOV_LINEAGE_LAYER_INVALID');
  assert.equal(err(() => rules.assertEdgeLayers('DOMAIN_FIELD', 'EXPORT')).code, 'GOV_LINEAGE_LAYER_INVALID');
});

test('m9d810 aresta que volta camada é recusada', () => {
  for (const [from, to] of [['READ_MODEL', 'DOMAIN_FIELD'], ['EVENT', 'SOURCE_FIELD'], ['METRIC', 'READ_MODEL'], ['METRIC', 'EXPORT'], ['EXPORT', 'METRIC'], ['EVENT', 'EVENT']]) {
    const e = err(() => rules.assertEdgeLayers(from, to));
    assert.equal(e && e.code, 'GOV_LINEAGE_LAYER_INVALID', `${from} -> ${to}`);
    assert.equal(e.statusCode, 422);
  }
});

test('m9d810 área obrigatória não rebaixa criticidade', () => {
  for (const area of MANDATORY_AREAS) {
    const e = err(() => rules.resolveCriticality(area, 'NORMAL'));
    assert.deepEqual([e.statusCode, e.code, e.message], [409, 'GOV_LINEAGE_CRITICALITY_LOCKED', 'Esta área exige lineage crítico.'], area);
    assert.equal(rules.resolveCriticality(area, undefined), 'CRITICAL', `${area} sem informar vira CRITICAL`);
    assert.equal(rules.resolveCriticality(area, 'CRITICAL'), 'CRITICAL');
  }
  assert.equal(rules.resolveCriticality('OTHER', 'NORMAL'), 'NORMAL');
  assert.equal(rules.resolveCriticality('OTHER', undefined), 'NORMAL');
  assert.equal(rules.resolveCriticality('OTHER', 'CRITICAL'), 'CRITICAL', 'subir é livre');
});

test('m9d810 caminho completo marca KPI como coberto', () => {
  const { nodes, edges } = chain();
  const out = computeCoverage({ nodes, edges }, [target()]);
  assert.deepEqual([out.critical, out.covered, out.uncovered], [['k.a'], ['k.a'], []]);
  assert.equal(out.percent, 100);
});

test('m9d810 sem caminho completo o KPI crítico fica descoberto e o normal é ignorado', () => {
  const { nodes, edges } = chain();
  const semEvento = computeCoverage({ nodes, edges: edges.filter((e) => e.to.nodeType !== 'EVENT') }, [target()]);
  assert.deepEqual(semEvento.uncovered, [{ nodeType: 'METRIC', code: 'k.a', area: 'EXEC_KPI' }]);
  const semMetrica = computeCoverage({ nodes: nodes.filter((n) => n.nodeType !== 'METRIC'), edges: [] }, [target()]);
  assert.equal(semMetrica.uncovered.length, 1, 'métrica sem nó');
  const normal = computeCoverage({ nodes: [], edges: [] }, [target('k.n', 'NORMAL', 'OTHER')]);
  assert.deepEqual([normal.critical, normal.uncovered], [[], []]);
  const porArea = computeCoverage({ nodes: [], edges: [] }, [target('k.m', 'NORMAL', 'MONEY')]);
  assert.deepEqual(porArea.uncovered.map((u) => u.code), ['k.m'], 'área obrigatória torna crítica');
});

test('m9d810 nó do caminho sem owner_domain ou sem descrição não cobre', () => {
  for (const [nodeType, field] of [['EVENT', 'ownerDomain'], ['SOURCE_FIELD', 'description'], ['READ_MODEL', 'description']]) {
    const { nodes, edges } = chain('k.b', { [nodeType]: { [field]: '  ' } });
    const out = computeCoverage({ nodes, edges }, [target('k.b')]);
    assert.deepEqual(out.uncovered.map((u) => u.code), ['k.b'], `${nodeType}.${field}`);
    assert.ok(out.incomplete.some((i) => i.nodeType === nodeType && i.missing.includes(field)), 'o nó incompleto é listado');
  }
});

test('m9d810 caminho alternativo completo cobre mesmo com outro ramo quebrado', () => {
  const { nodes, edges } = chain('k.c');
  const extraSource = node('SOURCE_FIELD', 'k.c.outro', { ownerDomain: '' });
  const out = computeCoverage({ nodes: [...nodes, extraSource], edges: [...edges, edge(extraSource, nodes[1])] }, [target('k.c')]);
  assert.deepEqual(out.covered, ['k.c']);
});

test('m9d810 exportação crítica registrada também precisa do caminho completo', () => {
  const { nodes, edges } = chain('k.d');
  const exp = node('EXPORT', 'k.d.export', { area: 'DIMOB' });
  const incompleto = computeCoverage({ nodes: [...nodes, exp], edges }, []);
  assert.deepEqual(incompleto.uncovered, [{ nodeType: 'EXPORT', code: 'k.d.export', area: 'DIMOB' }]);
  const completo = computeCoverage({ nodes: [...nodes, exp], edges: [...edges, edge(nodes[3], exp)] }, []);
  assert.deepEqual([completo.uncovered, completo.covered], [[], ['k.d', 'k.d.export']]);
});
