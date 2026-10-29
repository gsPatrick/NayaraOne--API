'use strict';

// M9-D811 — portão de CI `npm run check:lineage` (scripts/checkLineageCoverage.js). Puro: roda o script com registro, catálogo e mapa de arquivos temporários.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SCRIPT = path.join(__dirname, '../../../scripts/checkLineageCoverage.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-m9-gate-'));
let seq = 0;
const write = (data) => { seq += 1; const file = path.join(dir, `f${seq}.json`); fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); return file; };

const LAYERS = ['SOURCE_FIELD', 'DOMAIN_FIELD', 'EVENT', 'READ_MODEL', 'METRIC'];
function registryFor(codes, { exportCode = null, drop = null, blank = null } = {}) {
  const nodes = []; const edges = [];
  for (const code of codes) {
    const ref = (i) => ({ nodeType: LAYERS[i], code: LAYERS[i] === 'METRIC' ? code : `${code}.${LAYERS[i]}` });
    LAYERS.forEach((layer, i) => nodes.push({ ...ref(i), description: `Nó ${layer} de ${code}`, ownerDomain: 'FINANCEIRO', criticality: 'CRITICAL', area: 'EXEC_KPI' }));
    for (let i = 0; i < 4; i += 1) edges.push({ from: ref(i), to: ref(i + 1), transformation: 'soma' });
  }
  if (exportCode) {
    nodes.push({ nodeType: 'EXPORT', code: exportCode, description: 'Exportação', ownerDomain: 'FINANCEIRO', criticality: 'CRITICAL', area: 'DIMOB' });
    edges.push({ from: { nodeType: 'READ_MODEL', code: `${codes[0]}.READ_MODEL` }, to: { nodeType: 'EXPORT', code: exportCode }, transformation: 'arquivo' });
  }
  const out = { version: 1, nodes: nodes.filter((n) => n.code !== drop), edges: edges.filter((e) => e.to.code !== drop && e.from.code !== drop) };
  if (blank) out.nodes = out.nodes.map((n) => (n.code === blank.code ? { ...n, [blank.field]: '' } : n));
  return out;
}
const catalogOf = (codes, extra = {}) => codes.map((code) => ({ code, criticality: 'CRITICAL', area: 'EXEC_KPI', ...extra[code] }));
function check(registry, catalog, extra = []) {
  const res = spawnSync(process.execPath, [SCRIPT, '--registry', write(registry), '--catalog', write(catalog), ...extra], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}
const CODES = ['fin.a', 'fin.b', 'crm.c'];

test('m9d811 KPI sem lineage crítico falha gate', () => {
  const res = check(registryFor(CODES, { drop: 'crm.c' }), catalogOf([...CODES, 'EXEC_NOI']));
  assert.equal(res.status, 1);
  assert.match(res.out, /GOV_LINEAGE_UNCOVERED/);
  assert.match(res.out, /KPI crítico sem lineage: EXEC_NOI\./);
  assert.match(res.out, /KPI crítico sem lineage: crm\.c\./);
  assert.match(res.out, /uncovered=\["crm\.c","EXEC_NOI"\]/);
});

test('m9d811 cobertura total passa com exit 0', () => {
  const res = check(registryFor(CODES), catalogOf(CODES));
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /covered=3\/3/);
  const json = JSON.parse(check(registryFor(CODES), catalogOf(CODES), ['--json']).out);
  assert.deepEqual([json.ok, json.covered, json.critical, json.uncovered], [true, 3, 3, []]);
});

test('m9d811 nó sem descrição reprova', () => {
  const res = check(registryFor(CODES, { blank: { code: 'fin.a.EVENT', field: 'description' } }), catalogOf(CODES));
  assert.equal(res.status, 1);
  assert.match(res.out, /GOV_LINEAGE_NODE_INCOMPLETE/);
  const owner = check(registryFor(CODES, { blank: { code: 'fin.b.READ_MODEL', field: 'ownerDomain' } }), catalogOf(CODES));
  assert.equal(owner.status, 1);
  assert.match(owner.out, /Nó de lineage sem responsável: fin\.b\.READ_MODEL\./);
});

test('m9d811 métrica sem área reprova', () => {
  const res = check(registryFor(CODES), catalogOf(CODES, { 'crm.c': { area: undefined } }));
  assert.equal(res.status, 1);
  assert.match(res.out, /GOV_LINEAGE_AREA_MISSING/);
  assert.match(res.out, /Informe a área da métrica crm\.c\./);
  const invalid = check(registryFor(CODES), catalogOf(CODES, { 'crm.c': { area: 'QUALQUER' } }));
  assert.equal(invalid.status, 1);
});

test('m9d811 JSON inválido sai com exit 2', () => {
  for (const content of ['{ não é json', '{"nodes": 1, "edges": []}', '{"nodes": [{"nodeType":"COLUNA","code":"x"}], "edges": []}']) {
    const res = spawnSync(process.execPath, [SCRIPT, '--registry', write(content), '--catalog', write(catalogOf(CODES))], { encoding: 'utf8' });
    assert.equal(res.status, 2, content);
    assert.match(`${res.stdout}${res.stderr}`, /GOV_LINEAGE_REGISTRY_INVALID/);
    assert.match(`${res.stdout}${res.stderr}`, /Arquivo de lineage inválido\./);
  }
  const missing = spawnSync(process.execPath, [SCRIPT, '--registry', path.join(dir, 'nao-existe.json'), '--catalog', write(catalogOf(CODES))], { encoding: 'utf8' });
  assert.equal(missing.status, 2, 'erro de leitura nunca sai com 0');
});

test('m9d811 divergência entre o mapa de migração e o registro reprova', () => {
  const registry = registryFor(CODES);
  const mig = (field) => ({ entity: 'PERSON', sourceSystem: 'LEGADO', sourceField: field, domainField: 'people.persons.legal_name', critical: true });
  registry.nodes.push({ nodeType: 'SOURCE_FIELD', code: 'LEGADO.pessoas.nome', description: 'Nome no legado', ownerDomain: 'CRM', criticality: 'CRITICAL', area: 'MIGRATION' });
  registry.nodes.push({ nodeType: 'DOMAIN_FIELD', code: 'people.persons.legal_name', description: 'Nome', ownerDomain: 'CRM', criticality: 'CRITICAL', area: 'MIGRATION' });
  registry.edges.push({ from: { nodeType: 'SOURCE_FIELD', code: 'LEGADO.pessoas.nome' }, to: { nodeType: 'DOMAIN_FIELD', code: 'people.persons.legal_name' }, transformation: 'cópia' });
  const same = check(registry, catalogOf(CODES), ['--map', write([mig('pessoas.nome')])]);
  assert.equal(same.status, 0, same.out);
  const drift = check(registry, catalogOf(CODES), ['--map', write([mig('pessoas.nome'), mig('pessoas.documento')])]);
  assert.equal(drift.status, 1);
  assert.match(drift.out, /GOV_LINEAGE_MAP_DRIFT/);
  assert.match(drift.out, /O mapa de migração e o lineage divergem\./);
  const extra = check(registry, catalogOf(CODES), ['--map', write([])]);
  assert.equal(extra.status, 1, 'campo do registro que o mapa não tem também diverge');
  const noMap = check(registry, catalogOf(CODES), ['--map', path.join(dir, 'sem-mapa.json')]);
  assert.equal(noMap.status, 0, 'o mapa nasce com a M9-D914; sem o arquivo não há o que conferir');
});

test('m9d811 nó EXPORT registrado sem caminho completo reprova', () => {
  const ok = check(registryFor(CODES, { exportCode: 'dimob.file' }), catalogOf(CODES));
  assert.equal(ok.status, 0, ok.out);
  const registry = registryFor(CODES, { exportCode: 'dimob.file' });
  registry.edges = registry.edges.filter((e) => e.to.code !== 'dimob.file');
  const res = check(registry, catalogOf(CODES));
  assert.equal(res.status, 1);
  assert.match(res.out, /KPI crítico sem lineage: dimob\.file\./);
});

test('m9d811 não existe lista de isenção', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--registry', write(registryFor(CODES, { drop: 'fin.a' })), '--catalog', write(catalogOf(CODES)), '--ignore', 'fin.a', '--allow', 'fin.a'], { encoding: 'utf8' });
  assert.equal(res.status, 2, 'opção desconhecida é recusada, nunca ignora o KPI');
  assert.ok(!fs.existsSync(path.join(__dirname, '../../../docs/governance/lineage-exceptions.json')));
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/exce[cç]|isen[cç]|allowlist|ignore/i.test(source.replace('Não existe lista de exceções.', '')), 'o script não tem caminho de exceção');
});
