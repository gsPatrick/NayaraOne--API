'use strict';

// M9-D914 — o mapa de campos da migração (docs/governance/migration-field-map.json): formato, dono, as 10 entidades, a fidelidade ao aplicador (M9-D900) e ao esquema canônico (M9-D905).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d914Kit');
const { loadMap, rowProblem, sourceCode } = require('../../../src/features/core-governance/lineage/kit/migrationMap');
const { ENTITY_DOMAIN } = require('../../../src/features/core-governance/lineage/kit/migrationCatalog');
const { qualifiedColumnOf, domainFieldOf } = require('../../../src/features/core-governance/lineage/kit/domain');
const { SOURCE_SEEDS } = require('../../../src/features/migration-v2/seeds/sources.seed');
const { ENTITY_SCHEMA_SEEDS } = require('../../../src/features/migration-v2/integrity/schema.seed');
const env = require('../_helpers/m9d901Env');

const map = kit.readJson(kit.MAP_FILE);
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
after(async () => { await env.sequelize.close(); });

test('m9d914 migration-field-map.json tem o formato e cobre as 10 entidades', () => {
  assert.ok(Array.isArray(map) && map.length > 0);
  for (const [i, row] of map.entries()) {
    assert.deepEqual(Object.keys(row).sort(), ['critical', 'domainField', 'entity', 'sourceField', 'sourceSystem'], `linha ${i + 1}`);
    assert.equal(rowProblem(row), null, `linha ${i + 1}`);
  }
  assert.equal(JSON.stringify(loadMap()), JSON.stringify(map), 'o carregador lê o mesmo mapa');
  const entities = [...new Set(map.map((r) => r.entity))].sort();
  assert.deepEqual(entities, ['COMMISSION', 'CONTRACT', 'CORRESPONDENT_CASE', 'FINANCIAL_ENTRY', 'INSTALLMENT', 'PERSON', 'PROJECT', 'PROPERTY', 'STOCK_ITEM', 'SUPPLIER']);
  assert.deepEqual(Object.keys(ENTITY_DOMAIN).sort(), entities, 'cada entidade do mapa tem o domínio do seu data steward (D804)');
  for (const entity of entities) assert.ok(map.some((r) => r.entity === entity && r.critical), `${entity} tem campo crítico`);
  assert.equal(new Set(map.map((r) => `${sourceCode(r)}>${r.domainField}`)).size, map.length, 'uma linha por campo');
  // a linha em disco é uma por campo (diff legível)
  assert.equal(require('node:fs').readFileSync(kit.MAP_FILE, 'utf8').trim().split('\n').length, map.length + 2);
});

test('m9d914 o mapa cobre as classes de campo crítico do livro: chave, CPF/CNPJ, dinheiro, datas, status, partes, repasses e comissões', () => {
  const critical = map.filter((r) => r.critical).map((r) => r.domainField);
  const has = (re) => critical.some((f) => re.test(f));
  assert.ok(has(/^core\.external_refs\.sourceKey$/), 'identificadores e chaves (external_refs)');
  assert.ok(has(/Person\.taxIdNormalized$/), 'CPF/CNPJ');
  assert.ok(has(/FinancialEntry\.amount$/) && has(/BillingScheduleItem\.amount$/) && has(/Contract\.totalValue$/), 'valores monetários');
  assert.ok(has(/FinancialEntry\.dueAt$/) && has(/FinancialEntry\.settledAt$/) && has(/Contract\.startsAt$/) && has(/Contract\.endsAt$/), 'datas de vencimento, pagamento e vigência');
  assert.ok(has(/FinancialEntry\.status$/) && has(/Contract\.status$/), 'status');
  assert.ok(has(/ContractParty\.personId$/) && has(/ContractParty\.partyRole$/), 'partes de contrato');
  assert.ok(has(/OwnerRepass\.netAmount$/) && has(/Commission\.totalAmount$/) && has(/CommissionInstallment\.amount$/), 'repasses e comissões');
});

test('m9d914 o mapa parte do mapeamento do aplicador (D900): toda coluna do columnMap da fonte tem linha', () => {
  for (const seed of SOURCE_SEEDS) {
    const table = seed.config.relation.split('.').pop();
    const rows = map.filter((r) => r.entity === seed.entity && r.sourceField.startsWith(`${table}.`));
    assert.deepEqual(rows.map((r) => r.sourceField.split('.')[1]).sort(), Object.keys(seed.config.columnMap).sort(), `${seed.entity}: colunas do legado`);
    assert.ok(rows.every((r) => r.sourceSystem === seed.sourceSystem), `${seed.entity}: sistema de origem`);
  }
});

test('m9d914 o mapa respeita o esquema canônico (D905): os campos de PERSON, SUPPLIER e PROPERTY do esquema têm destino no mapa', () => {
  const attributeOf = { personType: 'personType', legalName: 'legalName', preferredName: 'preferredName', taxId: 'taxIdNormalized', birthDate: 'birthOrFoundationDate' };
  for (const entity of ['PERSON', 'SUPPLIER']) {
    for (const def of ENTITY_SCHEMA_SEEDS[entity]) assert.ok(map.some((r) => r.entity === entity && r.domainField === `people.Person.${attributeOf[def.field]}`), `${entity}.${def.field}`);
  }
  for (const def of ENTITY_SCHEMA_SEEDS.PROPERTY) assert.ok(map.some((r) => r.entity === 'PROPERTY' && r.domainField === `real_estate.Property.${def.field}`), `PROPERTY.${def.field}`);
});

test('m9d914 todo campo de domínio do mapa existe nos modelos e volta ao mesmo código', () => {
  for (const row of map) {
    const column = qualifiedColumnOf(row.domainField);
    assert.ok(column, `${row.domainField} não existe nos modelos`);
    assert.equal(domainFieldOf(column), row.domainField, column);
  }
});

test('m9d914 toda coluna de destino do mapa existe no banco', { skip: skip() }, async () => {
  const columns = [...new Set(map.map((r) => qualifiedColumnOf(r.domainField)))];
  const rows = await env.q("SELECT table_schema || '.' || table_name || '.' || column_name AS qualified FROM information_schema.columns WHERE table_schema IN ('people', 'real_estate', 'legal', 'finance', 'construction', 'inventory', 'correspondent', 'core')");
  const existing = new Set(rows.map((r) => r.qualified));
  for (const column of columns) assert.ok(existing.has(column), `${column} não existe no banco`);
});

test('m9d914 linha inválida do mapa falha fechado', () => {
  assert.notEqual(rowProblem({ entity: 'NADA', sourceSystem: 'LEGADO_ERP', sourceField: 'a.b', domainField: 'x.Y.z', critical: true }), null);
  assert.notEqual(rowProblem({ entity: 'PERSON', sourceSystem: 'LEGADO_ERP', sourceField: 'semtabela', domainField: 'people.Person.legalName', critical: true }), null);
  assert.notEqual(rowProblem({ entity: 'PERSON', sourceSystem: 'LEGADO_ERP', sourceField: 'a.b', domainField: 'people.Person.legalName', critical: 'sim' }), null);
  assert.throws(() => loadMap(require('node:path').join(kit.ROOT, 'docs/governance/nao-existe.json')), /ilegível/);
});
