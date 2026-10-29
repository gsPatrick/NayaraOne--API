'use strict';

// M9-D820 — matriz padrão de DLP (24 linhas), tetos, prazos, marca d'água e política efetiva, com banco (rollback). Banco descartável:
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d820.matriz.test.js"
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/dlpEnv');
const service = require('../../../src/features/core-governance/dlp/policy.service');
const { effectivePolicy } = require('../../../src/features/core-governance/dlp/policy.effective');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { resolver.resetResolver(); await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const cell = (list, classification, action) => list.find((p) => p.classification === classification && p.action === action);

test('m9d820 matriz padrão tem 24 linhas', { skip: skip() }, async () => {
  await run(async (tx) => {
    const list = await service.listPolicies(tenants.A, tx);
    assert.equal(list.length, 24);
    for (const c of ['LOW', 'MEDIUM', 'HIGH', 'RESTRICTED']) for (const a of ['VIEW', 'COPY', 'EXPORT', 'PRINT', 'SHARE', 'AI']) assert.ok(cell(list, c, a), `${c}/${a}`);
    assert.equal((await service.listPolicies(tenants.A, tx)).length, 24, 'ler de novo não duplica');
  });
});

test('m9d820 matriz padrão segue a tabela da demanda', { skip: skip() }, async () => {
  await run(async (tx) => {
    const list = await service.listPolicies(tenants.A, tx);
    const flags = (p) => [p.allowed, p.requireJustification, p.requireMfa, p.requireAudit, p.requireMask, p.requirePermission];
    assert.deepEqual(flags(cell(list, 'LOW', 'VIEW')), [true, false, false, false, false, null]);
    assert.deepEqual(flags(cell(list, 'LOW', 'EXPORT')), [true, false, false, true, false, null]);
    assert.deepEqual(flags(cell(list, 'MEDIUM', 'PRINT')), [true, false, false, true, false, null]);
    assert.deepEqual(flags(cell(list, 'MEDIUM', 'AI')), [true, false, false, false, true, null]);
    assert.deepEqual(flags(cell(list, 'HIGH', 'VIEW')), [true, false, false, true, false, null]);
    assert.deepEqual(flags(cell(list, 'HIGH', 'EXPORT')), [true, true, true, true, false, null]);
    assert.deepEqual(flags(cell(list, 'HIGH', 'PRINT')), [true, true, false, true, false, null]);
    assert.deepEqual(flags(cell(list, 'HIGH', 'SHARE')), [true, true, true, true, false, null]);
    assert.deepEqual(flags(cell(list, 'HIGH', 'AI')), [true, false, false, false, true, null]);
    assert.deepEqual(flags(cell(list, 'RESTRICTED', 'VIEW')), [true, false, false, true, false, 'governance:dlp:view-restricted']);
    assert.deepEqual(flags(cell(list, 'RESTRICTED', 'PRINT')), [true, true, true, true, false, null]);
    assert.deepEqual(flags(cell(list, 'RESTRICTED', 'SHARE')), [true, true, true, true, false, null]);
  });
});

test('m9d820 COPY de RESTRICTED negado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const list = await service.listPolicies(tenants.A, tx);
    assert.equal(cell(list, 'RESTRICTED', 'COPY').allowed, false);
    assert.equal(cell(list, 'RESTRICTED', 'AI').allowed, false);
    for (const p of list.filter((x) => !(x.classification === 'RESTRICTED' && ['COPY', 'AI'].includes(x.action)))) assert.equal(p.allowed, true, `${p.classification}/${p.action}`);
  });
});

test('m9d820 max_rows padrão é 100.000, 50.000, 10.000 e 1.000 por classe', { skip: skip() }, async () => {
  await run(async (tx) => {
    const list = await service.listPolicies(tenants.A, tx);
    assert.deepEqual(['LOW', 'MEDIUM', 'HIGH', 'RESTRICTED'].map((c) => cell(list, c, 'EXPORT').maxRows), [100000, 50000, 10000, 1000]);
    assert.ok(list.filter((p) => p.action !== 'EXPORT').every((p) => p.maxRows === null), 'volume só vale na exportação');
  });
});

test('m9d820 tetos de expiração por classe são LOW 168, MEDIUM 72, HIGH 48 e RESTRICTED 24 horas', { skip: skip() }, async () => {
  await run(async (tx) => {
    const list = await service.listPolicies(tenants.A, tx);
    for (const action of ['EXPORT', 'SHARE']) assert.deepEqual(['LOW', 'MEDIUM', 'HIGH', 'RESTRICTED'].map((c) => cell(list, c, action).maxExpiryHours), [168, 72, 48, 24], action);
    assert.ok(list.filter((p) => !['EXPORT', 'SHARE'].includes(p.action)).every((p) => p.maxExpiryHours === null));
  });
});

test("m9d820 marca d'água é campo da política, editável, padrão desligado em todas as classes", { skip: skip() }, async () => {
  await run(async (tx) => {
    const list = await service.listPolicies(tenants.A, tx);
    assert.ok(list.every((p) => p.requireWatermark === false), 'o livro diz opcional: tudo desligado');
    const changed = await service.updatePolicy(tenants.A, env.actorOf(tenants.A), 'restricted', 'export', { requireWatermark: true }, tx);
    assert.equal(changed.requireWatermark, true);
    assert.equal((await service.getPolicy(tenants.A, 'RESTRICTED', 'EXPORT', tx)).requireWatermark, true);
    const off = await service.updatePolicy(tenants.A, env.actorOf(tenants.A), 'RESTRICTED', 'EXPORT', { requireWatermark: false }, tx);
    assert.equal(off.requireWatermark, false, 'a marca d\'água nunca é piso');
  });
});

test('m9d820 os parâmetros governanca.dlp.* definem a política inicial da empresa', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    await upsertSetting('governanca.dlp.volume_teto_por_classe', 'LOW 900; MEDIUM 800; HIGH 700; RESTRICTED 600', t, t.userId, tx);
    await upsertSetting('governanca.dlp.expiracao_horas_da_classe', 'LOW 100; MEDIUM 50; HIGH 30; RESTRICTED 10', t, t.userId, tx);
    await upsertSetting('governanca.dlp.watermark.padrao_por_classe', 'LOW desligado; MEDIUM desligado; HIGH ligado; RESTRICTED ligado', t, t.userId, tx);
    const list = await service.listPolicies(t, tx);
    assert.deepEqual(['LOW', 'MEDIUM', 'HIGH', 'RESTRICTED'].map((c) => cell(list, c, 'EXPORT').maxRows), [900, 800, 700, 600]);
    assert.deepEqual(['LOW', 'MEDIUM', 'HIGH', 'RESTRICTED'].map((c) => cell(list, c, 'SHARE').maxExpiryHours), [100, 50, 30, 10]);
    assert.deepEqual(['LOW', 'MEDIUM', 'HIGH', 'RESTRICTED'].map((c) => cell(list, c, 'VIEW').requireWatermark), [false, false, true, true]);
    const bad = await env.codeOf(upsertSetting('governanca.dlp.volume_teto_por_classe', 'LOW 1; MEDIUM 2', t, t.userId, tx));
    assert.equal(bad.code, 'VALIDATION_ERROR', 'faltando classe, o valor é recusado');
  });
});

test('m9d820 a política efetiva é resolvida pela classe devolvida pelo registro (a classe padrão sem registro é de M9-D910)', { skip: skip() }, async () => {
  await run(async (tx) => {
    const t = tenants.A;
    resolver.setResolver(async (_tenant, resources) => resources.map((r) => r.classification));
    try {
      const restricted = await effectivePolicy(t, { resources: [{ classification: 'LOW' }, { classification: 'RESTRICTED' }], action: 'COPY' }, tx);
      assert.equal(restricted.classification, 'RESTRICTED', 'a classe mais alta do pedido');
      assert.equal(restricted.policy.allowed, false);
      const low = await effectivePolicy(t, { resources: [{ classification: 'LOW' }], action: 'COPY' }, tx);
      assert.deepEqual([low.classification, low.policy.allowed], ['LOW', true]);
    } finally { resolver.resetResolver(); }
    const sem = await effectivePolicy(t, { resources: [{}], action: 'EXPORT' }, tx);
    assert.equal(sem.classification, 'HIGH', 'sem registro vale a classe padrão do parâmetro');
    await upsertSetting('governanca.dlp.classificacao_padrao', 'MEDIUM', t, t.userId, tx);
    assert.equal((await effectivePolicy(t, { resources: [{}], action: 'EXPORT' }, tx)).classification, 'MEDIUM');
  });
});

test('m9d820 a IA só recebe o campo se a classe permitir e ai_allowed for verdadeiro', { skip: skip() }, async () => {
  const { allowsAi } = require('../../../src/features/core-governance/dlp/policy.rules');
  await run(async (tx) => {
    const list = await service.listPolicies(tenants.A, tx);
    const ai = (c) => cell(list, c, 'AI');
    assert.equal(allowsAi(ai('LOW'), true), true);
    assert.equal(allowsAi(ai('LOW'), false), false, 'a trava por campo vale');
    assert.equal(allowsAi(ai('LOW'), undefined), false);
    assert.equal(allowsAi(ai('HIGH'), true), true);
    assert.equal(allowsAi(ai('RESTRICTED'), true), false, 'o teto da classe vale');
  });
});

test('m9d820 isolamento entre empresas', { skip: skip() }, async () => {
  await run(async (tx) => {
    await service.updatePolicy(tenants.A, env.actorOf(tenants.A), 'LOW', 'VIEW', { requireAudit: true }, tx);
    assert.equal((await service.getPolicy(tenants.A, 'LOW', 'VIEW', tx)).requireAudit, true);
  }, tenants.A);
  await run(async (tx) => {
    const list = await service.listPolicies(tenants.B, tx);
    assert.equal(cell(list, 'LOW', 'VIEW').requireAudit, false, 'a política de B não herda a de A');
    const seen = await env.rows('SELECT DISTINCT company_id FROM governance.dlp_policies', {}, tx);
    assert.deepEqual(seen.map((r) => r.company_id), [tenants.B.companyId], 'sessão de B só enxerga as linhas de B');
  }, tenants.B);
});
