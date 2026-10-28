'use strict';

// M9-D603 — Metric Registry: campos obrigatórios, publicação, aposentadoria e consistência. Roda SÓ em banco descartável:
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/analytics.m9d603.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sup = require('./analytics.m9d603.support');
const registry = require('../src/modules/analytics/metrics');
const dashboards = require('../src/features/analytics/dashboardStore.service');

const { inTx, ctxOf, metricInput } = sup;
let env;
let catalog;

before(async () => {
  env = await sup.setup();
  catalog = registry.createFormulaCatalog(env.formulaDir);
});
after(() => sup.teardown(env));

const publish = (input, tenant = env.tenantA, tx, perms) => registry.publishMetric(input, ctxOf(tenant, perms), tx, { catalog });
const inA = (fn, opts) => inTx(env.tenantA, opts || {}, fn);

async function expectErr(promise, status, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.statusCode, status, `${e.code}: ${e.message}`);
    assert.equal(e.code, code);
    return true;
  });
}

// livro §13 (13 campos) + value_nature + criticality: nome do livro -> chaves de entrada removidas
const FIELD_CASES = [
  ['metric_code', ['metricCode']], ['name', ['name']], ['description', ['description']],
  ['formula/semantic', ['formulaId', 'formulaSemantic']], ['source_read_model', ['sourceReadModel']],
  ['dimensions', ['dimensions']], ['filters', ['filters']], ['unit', ['unit']], ['owner', ['ownerRole']],
  ['refresh_policy', ['refreshPolicy']], ['version', ['version']], ['valid_from/until', ['validFrom']],
  ['quality_rule', ['qualityRule']], ['value_nature', ['valueNature']], ['criticality', ['criticality']],
];

for (const [field, keys] of FIELD_CASES) {
  test(`m9d603 publicar sem cada campo obrigatório é recusado (um caso por campo): ${field}`, async () => {
    const input = metricInput(env);
    keys.forEach((k) => delete input[k]);
    await inA(async (tx) => {
      await assert.rejects(publish(input, env.tenantA, tx), (e) => {
        assert.equal(e.statusCode, 422);
        assert.equal(e.code, 'ANALYTICS_METRIC_INCOMPLETE');
        assert.match(e.message, /^Faltam campos obrigatórios: .+\.$/);
        assert.ok(e.details.campos.length >= keys.length);
        return true;
      });
    });
  });
}

test('m9d603 owner nulo devolve 422 listando o campo owner e dimensions vazia é aceita', async () => {
  await inA(async (tx) => {
    await assert.rejects(publish(metricInput(env, { ownerRole: null }), env.tenantA, tx), (e) => {
      assert.equal(e.code, 'ANALYTICS_METRIC_INCOMPLETE');
      assert.deepEqual(e.details.campos, ['owner']);
      return true;
    });
    const ok = await publish(metricInput(env, { dimensions: [] }), env.tenantA, tx);
    assert.equal(ok.version.version, 1);
  });
});

test('m9d603 criticality só aceita CRITICAL ou NORMAL, sem valor padrão', async () => {
  await inA(async (tx) => {
    await expectErr(publish(metricInput(env, { criticality: 'HIGH' }), env.tenantA, tx), 400, 'ANALYTICS_METRIC_INVALID');
    await expectErr(publish(metricInput(env, { criticality: '' }), env.tenantA, tx), 422, 'ANALYTICS_METRIC_INCOMPLETE');
    const normal = await publish(metricInput(env, { criticality: 'NORMAL' }), env.tenantA, tx);
    assert.equal(normal.definition.criticality, 'NORMAL');
    const critical = await publish(metricInput(env, { criticality: 'CRITICAL' }), env.tenantA, tx);
    assert.equal(critical.definition.criticality, 'CRITICAL');
  });
});

test('m9d603 publicar métrica completa cria definição, versão 1 e ponteiro, com hash do dry-run', async () => {
  await inA(async (tx) => {
    const input = metricInput(env);
    const { definition, version } = await publish(input, env.tenantA, tx);
    assert.equal(version.version, 1);
    assert.match(version.formula_test_hash, /^[0-9a-f]{64}$/);
    assert.equal(version.source_read_model, env.readModel);
    const [[row]] = await sup.sequelize.query('SELECT status, current_version_id, domain, owner_role FROM analytics.metric_definitions WHERE id = :id', { replacements: { id: definition.id }, transaction: tx });
    assert.equal(row.status, 'PUBLISHED');
    assert.equal(row.current_version_id, version.id);
    assert.equal(row.domain, 'FINANCE');
    assert.equal(row.owner_role, 'CFO');
    const [[audit]] = await sup.sequelize.query(`SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'analytics.metric.publish' AND entity_id = :id`, { replacements: { id: version.id }, transaction: tx });
    assert.equal(audit.n, 1);
  });
});

test('m9d603 fórmula inexistente é recusada', async () => {
  await inA(async (tx) => {
    await expectErr(publish(metricInput(env, { formulaId: 'fin.xyz' }), env.tenantA, tx), 422, 'ANALYTICS_FORMULA_NOT_FOUND');
  });
});

test('m9d603 fórmula com teste vermelho ou sem testes não publica', async () => {
  await inA(async (tx) => {
    await expectErr(publish(metricInput(env, { formulaId: 'fin.m9d603_errada' }), env.tenantA, tx), 422, 'ANALYTICS_FORMULA_TESTS_FAILED');
    await expectErr(publish(metricInput(env, { formulaId: 'fin.m9d603_sem_testes' }), env.tenantA, tx), 422, 'ANALYTICS_FORMULA_TESTS_FAILED');
  });
});

test('m9d603 read model inexistente, regra de qualidade inválida e vigência com fim são recusados', async () => {
  await inA(async (tx) => {
    await expectErr(publish(metricInput(env, { sourceReadModel: 'rm_nao_existe_xyz' }), env.tenantA, tx), 422, 'ANALYTICS_READ_MODEL_NOT_FOUND');
    await expectErr(publish(metricInput(env, { qualityRule: { maxStalenessMinutes: 10 } }), env.tenantA, tx), 400, 'ANALYTICS_METRIC_INVALID');
    await expectErr(publish(metricInput(env, { qualityRule: { referenceReport: 'x', maxStalenessMinutes: -1 } }), env.tenantA, tx), 400, 'ANALYTICS_METRIC_INVALID');
    await expectErr(publish(metricInput(env, { validUntil: '2027-01-01' }), env.tenantA, tx), 400, 'ANALYTICS_METRIC_INVALID');
    await expectErr(publish(metricInput(env, { refreshPolicy: { mode: 'EVENT' } }), env.tenantA, tx), 400, 'ANALYTICS_METRIC_INVALID');
  });
});

test('m9d603 sem a permissão analytics:manage o serviço recusa (PERMISSION_DENIED)', async () => {
  await inA(async (tx) => {
    await assert.rejects(publish(metricInput(env), env.tenantA, tx, ['analytics:read']), (e) => {
      assert.equal(e.statusCode, 403);
      assert.equal(e.code, 'PERMISSION_DENIED');
      assert.equal(e.message, 'Permissão ausente: analytics:manage.');
      return true;
    });
    await expectErr(registry.retireMetric({ metricCode: 'fin.x' }, ctxOf(env.tenantA, []), tx), 403, 'PERMISSION_DENIED');
  });
});

test('m9d603 código duplicado responde 409', async () => {
  await inA(async (tx) => {
    const input = metricInput(env);
    await publish(input, env.tenantA, tx);
    await expectErr(publish(input, env.tenantA, tx), 409, 'ANALYTICS_METRIC_CODE_DUPLICATE');
  });
});

test('m9d603 registry consistente: toda definição publicada tem formula_id no código', async () => {
  await inA(async (tx) => {
    const { definition } = await publish(metricInput(env), env.tenantA, tx);
    const mine = (list) => list.filter((o) => o.metricCode.startsWith('fin.m9d603_'));
    assert.deepEqual(mine(await registry.findInconsistentMetrics(tx, catalog)), []);
    // O catálogo real (sem fórmulas ainda) enxerga a métrica de teste como órfã: a checagem detecta de verdade.
    const orfas = await registry.findInconsistentMetrics(tx, registry.createFormulaCatalog('/caminho/inexistente'));
    assert.ok(orfas.some((o) => o.metricCode === definition.metric_code && o.formulaId === 'fin.m9d603_soma'));
  });
  // O catálogo real carrega sem erro (todo arquivo de fórmula do código é válido e sem id repetido).
  assert.ok(Array.isArray(registry.getFormulaCatalog().ids()));
});

test('m9d603 aposentar métrica em uso é recusado e sem uso aposenta, sem voltar', async () => {
  await inA(async (tx) => {
    const input = metricInput(env);
    await publish(input, env.tenantA, tx);
    const dash = await dashboards.createDashboardDefinition({
      scopeLevel: 'COMPANY', groupId: env.tenantA.groupId, companyId: env.tenantA.companyId, dashboardCode: `fin_${sup.sfx()}`,
      name: 'Financeiro', domain: 'FINANCE', audienceRoles: ['DIRETORIA'], requiredPermission: 'analytics:read', p95TargetMs: 1500,
    }, ctxOf(env.tenantA), tx);
    await dashboards.addDashboardWidget(dash.id, { widgetType: 'QUALITY_BANNER', title: 'Qualidade', position: 0 }, ctxOf(env.tenantA), tx);
    await dashboards.addDashboardWidget(dash.id, { widgetType: 'KPI_CARD', metricCode: input.metricCode, title: 'Caixa', position: 1 }, ctxOf(env.tenantA), tx);
    await dashboards.publishDashboard(dash.id, ctxOf(env.tenantA), tx);
    await assert.rejects(registry.retireMetric({ ...input, scopeLevel: 'COMPANY' }, ctxOf(env.tenantA), tx), (e) => {
      assert.equal(e.statusCode, 409);
      assert.equal(e.code, 'ANALYTICS_METRIC_IN_USE');
      assert.ok(e.message.includes(dash.dashboard_code));
      return true;
    });
    const free = metricInput(env);
    await publish(free, env.tenantA, tx);
    const retired = await registry.retireMetric({ ...free, scopeLevel: 'COMPANY' }, ctxOf(env.tenantA), tx);
    assert.equal(retired.status, 'RETIRED');
    await expectErr(registry.retireMetric({ ...free, scopeLevel: 'COMPANY' }, ctxOf(env.tenantA), tx), 409, 'ANALYTICS_METRIC_STATE_INVALID');
    await expectErr(publish(free, env.tenantA, tx), 409, 'ANALYTICS_METRIC_RETIRED');
    const ativos = await registry.listRegistry(ctxOf(env.tenantA, ['analytics:manage', 'finance:read']), {}, tx);
    assert.ok(!ativos.some((m) => m.metricCode === free.metricCode), 'RETIRED some do catálogo ativo');
    const todos = await registry.listRegistry(ctxOf(env.tenantA, ['analytics:manage', 'finance:read']), { includeRetired: true }, tx);
    assert.ok(todos.some((m) => m.metricCode === free.metricCode && m.status === 'RETIRED'));
    const detalhe = await registry.getMetric(ctxOf(env.tenantA, ['analytics:manage', 'finance:read']), free.metricCode, tx);
    assert.equal(detalhe.versions.length, 1, 'histórico legível após aposentar');
    const [[aud]] = await sup.sequelize.query(`SELECT before_json, after_json FROM audit.audit_log WHERE action = 'analytics.metric.retire' AND entity_id = :id`, { replacements: { id: detalhe.definition.id }, transaction: tx });
    assert.equal(aud.before_json.status, 'PUBLISHED');
    assert.equal(aud.after_json.status, 'RETIRED');
  });
});

test('m9d603 duas publicações simultâneas do mesmo código: uma vence, a outra recebe 409', async () => {
  const input = metricInput(env);
  const go = () => inA((tx) => publish(input, env.tenantA, tx), { commit: true });
  const results = await Promise.allSettled([go(), go()]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.reason?.code || r.status)));
  assert.equal(bad[0].reason.statusCode, 409);
  assert.match(bad[0].reason.code, /^ANALYTICS_METRIC_(CODE_DUPLICATE|VERSION_CONFLICT)$/);
  const [rows] = await env.admin.query(`SELECT v.version FROM analytics.metric_versions v JOIN analytics.metric_definitions d ON d.id = v.metric_id WHERE d.metric_code = :c`, { replacements: { c: input.metricCode } });
  assert.deepEqual(rows.map((r) => r.version), [1]);
});
