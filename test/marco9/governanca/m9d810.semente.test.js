'use strict';

// M9-D810 — a semente do registro (cinco áreas com linhas hoje; MIGRATION chega com a M9-D914 pelo mesmo carregador) e o gerador único.
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d810Env');
const service = require('../../../src/features/core-governance/lineage/lineage.service');
const seed = require('../../../src/features/core-governance/lineage/lineage.seed');
const registryFile = require('../../../src/features/core-governance/lineage/lineage.registryFile');
const { computeCoverage } = require('../../../src/features/core-governance/lineage/lineage.coverage');
const { listCriticalityRows } = require('../../../src/features/analytics/metrics/seed/criticality.table');
const { MANDATORY_AREAS } = require('../../../src/features/core-governance/lineage/lineage.constants');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const critical = () => listCriticalityRows().filter((r) => r.criticality === 'CRITICAL' || MANDATORY_AREAS.includes(r.area)).map((r) => ({ nodeType: 'METRIC', code: r.code, criticality: 'CRITICAL', area: r.area }));

test('m9d810 semente cobre dinheiro, contratos, comissões, DIMOB, KPIs e migração', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    const result = await seed.ensureSeeded(t, tx);
    assert.equal(typeof result.applied, 'boolean');
    const registry = await service.loadRegistry(t, tx);
    const targets = critical();
    const out = computeCoverage(registry, [...targets, { nodeType: 'EXPORT', code: 'dimob.file', criticality: 'CRITICAL', area: 'DIMOB' }]);
    assert.deepEqual(out.uncovered, [], 'todo KPI crítico do catálogo e a exportação DIMOB têm caminho completo');
    const areas = new Set(registry.nodes.filter((n) => ['METRIC', 'EXPORT'].includes(n.nodeType)).map((n) => n.area));
    for (const area of ['MONEY', 'CONTRACT', 'COMMISSION', 'DIMOB', 'EXEC_KPI']) assert.ok(areas.has(area), `área ${area} semeada`);
    const money = registry.nodes.filter((n) => n.area === 'MONEY').map((n) => n.code);
    assert.ok(money.includes('finance.financial_entries.amount') && money.includes('fin.free_cash'), 'lançamentos financeiros');
    assert.ok(registry.nodes.some((n) => n.code === 'legal.contract_versions.content_hash' || n.code.startsWith('legal.contract_versions.')), 'versões de contrato');
    assert.ok(registry.nodes.some((n) => n.code === 'finance.commission_installments.amount') && registry.nodes.some((n) => n.code === 'finance.owner_repasses.net_amount'), 'comissões e repasses');
    assert.ok(registry.nodes.every((n) => n.ownerDomain && n.description), 'nenhum nó sem responsável ou descrição');
    assert.ok(registry.nodes.every((n) => !MANDATORY_AREAS.includes(n.area) || n.criticality === 'CRITICAL'), 'área obrigatória sempre crítica');
  });
});

test('m9d810 a semente é verdadeira: campos, tabelas e eventos existem no sistema', { skip: skip() }, async () => {
  await run(async (tx) => {
    await seed.ensureSeeded(tenants.A, tx);
    const all = await service.loadRegistry(tenants.A, tx);
    const nodes = all.nodes.filter((n) => n.source === 'SEED');
    const edges = all.edges.filter((e) => e.source === 'SEED');
    const columns = new Set((await env.query("SELECT table_schema || '.' || table_name || '.' || column_name AS c FROM information_schema.columns", {}, tx)).map((r) => r.c));
    const tables = new Set([...columns].map((c) => c.split('.').slice(0, 2).join('.')));
    for (const n of nodes.filter((x) => x.nodeType === 'SOURCE_FIELD')) assert.ok(columns.has(n.code), `coluna inexistente: ${n.code}`);
    for (const n of nodes.filter((x) => x.nodeType === 'READ_MODEL')) assert.ok(tables.has(n.code), `tabela inexistente: ${n.code}`);
    const { listReadModels } = require('../../../src/features/analytics/read-models/readModel.registry');
    require('../../../src/features/analytics');
    const eventsOf = new Map(listReadModels().map((m) => [`analytics.${m.name}`, new Set(m.eventTypes)]));
    const auditSource = fs.readFileSync(path.join(__dirname, '../../../src/features/correspondent/fiscal/dimob.service.js'), 'utf8');
    for (const e of edges.filter((x) => x.from.nodeType === 'EVENT')) {
      const known = eventsOf.get(e.to.code);
      if (known) assert.ok(known.has(e.from.code), `${e.from.code} não alimenta ${e.to.code}`);
      else assert.ok(auditSource.includes(`'${e.from.code}'`), `evento ${e.from.code} sem origem conhecida`);
    }
  });
});

test('m9d810 semear de novo não muda nada e edição pela API não é sobrescrita', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    await seed.ensureSeeded(t, tx);
    assert.equal((await seed.ensureSeeded(t, tx)).applied, false, 'mesmo conjunto de sementes, nada a fazer');
    const before = await service.loadRegistry(t, tx);
    const node = before.nodes.find((n) => n.nodeType === 'METRIC' && n.code === 'fin.free_cash');
    await service.saveNode(t, env.actorOf(t), { ...node, description: 'Descrição ajustada pela área' }, tx, { create: false });
    const dir = env.tmpSeedDir({ 'extra.seed.js': "module.exports = { code: 'QA-EXTRA', build: () => ({ nodes: [], edges: [] }) };" });
    assert.equal((await seed.ensureSeeded(t, tx, { dir })).applied, true, 'conjunto diferente de sementes é aplicado');
    const mine = (await service.loadRegistry(t, tx)).nodes.find((n) => n.code === 'fin.free_cash');
    assert.equal(mine.description, 'Descrição ajustada pela área');
  });
});

test('m9d810 o gerador único produz o mesmo arquivo a partir de seeds de várias demandas', { skip: skip() }, async () => {
  const seedOf = (id, domain, code) => `module.exports = { code: '${id}', build: () => ({
    nodes: [
      { nodeType: 'SOURCE_FIELD', code: '${code}.src', description: 'QA-M9 origem ${id}', ownerDomain: '${domain}', area: 'MIGRATION' },
      { nodeType: 'DOMAIN_FIELD', code: '${code}.dom', description: 'QA-M9 domínio ${id}', ownerDomain: '${domain}', area: 'MIGRATION' },
      { nodeType: 'EVENT', code: '${code}.evt', description: 'QA-M9 evento ${id}', ownerDomain: '${domain}', area: 'MIGRATION' },
      { nodeType: 'READ_MODEL', code: '${code}.rm', description: 'QA-M9 leitura ${id}', ownerDomain: '${domain}', area: 'MIGRATION' },
      { nodeType: 'METRIC', code: '${code}', description: 'QA-M9 métrica ${id}', ownerDomain: '${domain}', area: 'MIGRATION' },
    ],
    edges: [['SOURCE_FIELD', 'src', 'DOMAIN_FIELD', 'dom'], ['DOMAIN_FIELD', 'dom', 'EVENT', 'evt'], ['EVENT', 'evt', 'READ_MODEL', 'rm'], ['READ_MODEL', 'rm', 'METRIC', null]].map(([a, ac, b, bc]) => ({
      from: { nodeType: a, code: '${code}.' + ac }, to: { nodeType: b, code: bc ? '${code}.' + bc : '${code}' }, transformation: 'QA-M9' })),
  }) };`;
  const filesAB = { 'a.seed.js': seedOf('QA-D914', 'FINANCEIRO', 'qa.mig.a'), 'b.seed.js': seedOf('QA-D8XX', 'CRM', 'qa.kpi.b') };
  const filesBA = { 'b.seed.js': filesAB['b.seed.js'], 'a.seed.js': filesAB['a.seed.js'] };
  const texts = [];
  for (const files of [filesAB, filesBA]) {
    await run(async (tx) => {
      await seed.ensureSeeded(tenants.A, tx, { dir: env.tmpSeedDir(files) });
      texts.push(await registryFile.buildRegistryFile(tenants.A, tx));
    });
  }
  assert.equal(texts[0], texts[1], 'mesma saída, qualquer que seja a ordem em que as demandas entregam seus seeds');
  const parsed = JSON.parse(texts[0]);
  const codes = parsed.nodes.map((n) => n.code);
  assert.ok(codes.includes('qa.mig.a') && codes.includes('qa.kpi.b'), 'linhas das duas demandas no mesmo arquivo');
  assert.deepEqual(Object.keys(parsed), ['version', 'seedHash', 'nodes', 'edges']);
  assert.ok(texts[0].endsWith('\n') && !/\d{4}-\d{2}-\d{2}T/.test(texts[0]), 'sem data nem hora no arquivo');
  assert.equal(registryFile.diffRegistryFiles(texts[0], texts[1]).length, 0);
  assert.ok(registryFile.diffRegistryFiles(texts[0], texts[0].replace('"qa.kpi.b"', '"qa.kpi.z"')).length > 0, 'a conferência acusa diferença');
});

test('m9d810 seed com defeito falha fechado e semente repetida com definição diferente é recusada', { skip: skip() }, async () => {
  await run(async (tx) => {
    const noOwner = env.tmpSeedDir({ 'x.seed.js': "module.exports = { code: 'QA-X', build: () => ({ nodes: [{ nodeType: 'EVENT', code: 'qa.x', description: 'd', area: 'OTHER' }], edges: [] }) };" });
    assert.equal((await env.codeOf(seed.ensureSeeded(tenants.A, tx, { dir: noOwner }))).code, 'GOV_LINEAGE_OWNER_REQUIRED');
    const node = (desc) => `{ nodeType: 'EVENT', code: 'qa.dup', description: '${desc}', ownerDomain: 'CRM', area: 'OTHER' }`;
    const dup = env.tmpSeedDir({
      'a.seed.js': `module.exports = { code: 'A', build: () => ({ nodes: [${node('um')}], edges: [] }) };`,
      'b.seed.js': `module.exports = { code: 'B', build: () => ({ nodes: [${node('dois')}], edges: [] }) };`,
    });
    assert.equal((await env.codeOf(seed.ensureSeeded(tenants.A, tx, { dir: dup }))).code, 'GOV_LINEAGE_SEED_CONFLICT');
  });
});
