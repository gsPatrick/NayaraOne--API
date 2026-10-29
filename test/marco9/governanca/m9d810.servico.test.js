'use strict';

// M9-D810 — registro de lineage com banco (rollback). Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d810.servico.test.js"
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d810Env');
const service = require('../../../src/features/core-governance/lineage/lineage.service');
const { computeCoverage } = require('../../../src/features/core-governance/lineage/lineage.coverage');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const cov = async (tenant, tx, targets) => computeCoverage(await service.loadRegistry(tenant, tx), targets);
const target = (code, area = 'EXEC_KPI') => ({ nodeType: 'METRIC', code, criticality: 'CRITICAL', area });

test('m9d810 caminho completo marca KPI como coberto', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    const path = env.fullPath('qa.kpi.cobre');
    for (const n of path.nodes.slice(0, 4)) await service.saveNode(t, env.actorOf(t), n, tx, { create: false });
    const before = await cov(t, tx, [target('qa.kpi.cobre')]);
    assert.ok(before.uncovered.some((u) => u.code === 'qa.kpi.cobre'), 'sem a métrica e as arestas, descoberto');
    await env.savePath(service, t, tx, path);
    const out = await cov(t, tx, [target('qa.kpi.cobre')]);
    assert.ok(out.covered.includes('qa.kpi.cobre') && !out.uncovered.some((u) => u.code === 'qa.kpi.cobre'), 'com o caminho completo, coberto');
  });
});

test('m9d810 aresta que pula camada é recusada e nada é gravado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    const path = env.fullPath('qa.pula');
    for (const n of path.nodes) await service.saveNode(t, env.actorOf(t), n, tx, { create: false });
    const bad = { from: { nodeType: 'SOURCE_FIELD', code: 'qa.pula.src' }, to: { nodeType: 'METRIC', code: 'qa.pula' }, transformation: 'soma' };
    const res = await env.codeOf(service.saveEdge(t, env.actorOf(t), bad, tx, { create: false }));
    assert.deepEqual([res.status, res.code, res.message], [422, 'GOV_LINEAGE_LAYER_INVALID', 'Esta ligação não respeita a ordem das camadas.']);
    assert.equal((await service.loadRegistry(t, tx)).edges.filter((e) => e.to.code === 'qa.pula').length, 0);
  });
});

test('m9d810 aresta que volta camada é recusada', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    const path = await env.savePath(service, t, tx, env.fullPath('qa.volta'));
    const back = { from: { nodeType: 'READ_MODEL', code: 'qa.volta.rm' }, to: { nodeType: 'DOMAIN_FIELD', code: 'qa.volta.dom' }, transformation: 'volta' };
    assert.equal((await env.codeOf(service.saveEdge(t, env.actorOf(t), back, tx, { create: false }))).code, 'GOV_LINEAGE_LAYER_INVALID');
    assert.equal(path.edges.length, 4);
  });
});

test('m9d810 área obrigatória não rebaixa criticidade (criação e atualização)', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    const base = { nodeType: 'METRIC', code: 'qa.trava', description: 'QA-M9 trava', ownerDomain: 'FINANCEIRO', area: 'MONEY' };
    const low = await env.codeOf(service.saveNode(t, env.actorOf(t), { ...base, criticality: 'NORMAL' }, tx, { create: false }));
    assert.deepEqual([low.status, low.code, low.message], [409, 'GOV_LINEAGE_CRITICALITY_LOCKED', 'Esta área exige lineage crítico.']);
    const saved = await service.saveNode(t, env.actorOf(t), base, tx, { create: false });
    assert.equal(saved.criticality, 'CRITICAL', 'sem informar, a área obrigatória grava CRITICAL');
    assert.equal((await env.codeOf(service.saveNode(t, env.actorOf(t), { ...base, criticality: 'NORMAL' }, tx, { create: false }))).code, 'GOV_LINEAGE_CRITICALITY_LOCKED');
    const other = await service.saveNode(t, env.actorOf(t), { ...base, code: 'qa.livre', area: 'OTHER', criticality: 'NORMAL' }, tx, { create: false });
    assert.equal(other.criticality, 'NORMAL');
    const semArea = await env.codeOf(service.saveNode(t, env.actorOf(t), { ...base, code: 'qa.semarea', area: undefined }, tx, { create: false }));
    assert.deepEqual([semArea.status, semArea.code], [422, 'GOV_LINEAGE_AREA_REQUIRED']);
  });
});

test('m9d810 nó sem owner_domain devolve 422 GOV_LINEAGE_OWNER_REQUIRED', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    const base = { nodeType: 'EVENT', code: 'qa.evento', description: 'QA-M9 evento', area: 'EXEC_KPI' };
    for (const ownerDomain of [undefined, '', '   ']) {
      const res = await env.codeOf(service.saveNode(t, env.actorOf(t), { ...base, ownerDomain }, tx, { create: false }));
      assert.deepEqual([res.status, res.code, res.message], [422, 'GOV_LINEAGE_OWNER_REQUIRED', 'Informe o domínio responsável pelo nó.']);
    }
    const noDesc = await env.codeOf(service.saveNode(t, env.actorOf(t), { ...base, ownerDomain: 'FINANCEIRO', description: ' ' }, tx, { create: false }));
    assert.deepEqual([noDesc.status, noDesc.code], [422, 'GOV_LINEAGE_DESCRIPTION_REQUIRED']);
    const bad = await env.codeOf(service.saveNode(t, env.actorOf(t), { ...base, ownerDomain: 'NAO_EXISTE' }, tx, { create: false }));
    assert.deepEqual([bad.status, bad.code], [400, 'GOV_DOMAIN_INVALID']);
    const extra = await service.saveNode(t, env.actorOf(t), { ...base, ownerDomain: 'TECNOLOGIA' }, tx, { create: false });
    assert.equal(extra.ownerDomain, 'TECNOLOGIA', 'domínio adicional do parâmetro de lineage vale');
  });
});

test('m9d810 PUT é idempotente por código, POST repetido é 409 e a auditoria guarda antes e depois', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    const body = { nodeType: 'SOURCE_FIELD', code: 'qa.idem.campo', description: 'Primeira', ownerDomain: 'FINANCEIRO', area: 'MONEY' };
    const first = await service.saveNode(t, env.actorOf(t), body, tx, { create: true });
    const dup = await env.codeOf(service.saveNode(t, env.actorOf(t), body, tx, { create: true }));
    assert.deepEqual([dup.status, dup.code], [409, 'GOV_LINEAGE_NODE_EXISTS']);
    const second = await service.saveNode(t, env.actorOf(t), { ...body, description: 'Segunda' }, tx, { create: false });
    assert.equal(second.id, first.id, 'mesmo nó');
    const again = await service.saveNode(t, env.actorOf(t), { ...body, description: 'Segunda' }, tx, { create: false });
    assert.equal(again.id, first.id);
    const [{ n }] = await env.query("SELECT count(*)::int AS n FROM governance.lineage_nodes WHERE group_id = :g AND code = 'qa.idem.campo'", { g: t.groupId }, tx);
    assert.equal(n, 1);
    const audits = await env.query("SELECT before_json, after_json FROM audit.audit_log WHERE entity_id = :id AND entity_type = 'governance.lineage_node' ORDER BY occurred_at, id", { id: first.id }, tx);
    assert.equal(audits.length, 2, 'criação e atualização; repetir o mesmo conteúdo não grava nem audita');
    assert.equal(audits[0].before_json, null);
    assert.equal(audits[1].before_json.description, 'Primeira');
    assert.equal(audits[1].after_json.description, 'Segunda');
  });
});

test('m9d810 aresta com nó inexistente devolve 404 GOV_NOT_FOUND e PUT de aresta troca a transformação', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    const path = await env.savePath(service, t, tx, env.fullPath('qa.aresta'));
    const ghost = { from: { nodeType: 'SOURCE_FIELD', code: 'qa.aresta.fantasma' }, to: { nodeType: 'DOMAIN_FIELD', code: 'qa.aresta.dom' }, transformation: 'x' };
    const res = await env.codeOf(service.saveEdge(t, env.actorOf(t), ghost, tx, { create: false }));
    assert.deepEqual([res.status, res.code, res.message], [404, 'GOV_NOT_FOUND', 'Nó de lineage não encontrado.']);
    const dup = await env.codeOf(service.saveEdge(t, env.actorOf(t), path.edges[0], tx, { create: true }));
    assert.deepEqual([dup.status, dup.code], [409, 'GOV_LINEAGE_EDGE_EXISTS']);
    const changed = await service.saveEdge(t, env.actorOf(t), { ...path.edges[0], transformation: 'filtro paid_at nulo' }, tx, { create: false });
    assert.equal(changed.transformation, 'filtro paid_at nulo');
    assert.equal((await service.loadRegistry(t, tx)).edges.filter((e) => e.to.code === 'qa.aresta.dom').length, 1);
  });
});

test('m9d810 o registro é do grupo: outra empresa do mesmo grupo vê, outro grupo não', { skip: skip() }, async () => {
  const code = 'qa.isolamento.campo';
  await run(async (tx) => {
    await service.saveNode(tenants.A, env.actorOf(tenants.A), { nodeType: 'SOURCE_FIELD', code, description: 'QA-M9', ownerDomain: 'FINANCEIRO', area: 'MONEY' }, tx, { create: false });
    assert.ok((await service.loadRegistry(tenants.A, tx)).nodes.some((n) => n.code === code));
  }, tenants.A);
  await run(async (tx) => {
    assert.equal((await service.loadRegistry(tenants.B, tx)).nodes.some((n) => n.code === code), false);
    const stolen = await env.query('SELECT id FROM governance.lineage_nodes WHERE code = :code', { code }, tx);
    assert.equal(stolen.length, 0, 'a RLS por grupo esconde o nó');
  }, tenants.B);
});

test('m9d810 a visão geral traz a cobertura e o parâmetro de KPIs críticos restringe a lista', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    const full = await service.getOverview(t, tx);
    assert.equal(full.habilitado, true);
    assert.deepEqual(Object.keys(full.cobertura).sort(), ['covered', 'critical', 'percent', 'uncovered']);
    assert.equal(full.cobertura.percent, 100, 'a semente cobre todo o catálogo crítico');
    await upsertSetting('governanca.lineage.kpis_criticos', 'fin.free_cash', t, t.userId, tx);
    const one = await service.getOverview(t, tx);
    const executives = one.cobertura.critical.filter((code) => code === 'fin.free_cash' || code.startsWith('crm.'));
    assert.deepEqual(executives, ['fin.free_cash'], 'KPI executivo fora da lista deixa de ser cobrado na visão da API');
  });
});
