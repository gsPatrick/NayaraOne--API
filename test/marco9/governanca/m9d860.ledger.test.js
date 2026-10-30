'use strict';

// M9-D860 — cost ledger: categorias, separação ESTIMATED x BILLED, crédito, chave com empresa e domínio, supersede por contenção, isolamento.
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d860.ledger.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d860Env');
const readModel = require('../../../src/features/core-governance/finops/costReadModel');
const { importInvoice } = require('../../../src/features/core-governance/finops/collectors/billing');
const finops = require('../../../src/features/core-governance/finops/finops.service');
const { divHalfEven } = require('../../../src/features/core-governance/finops/money');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);
const NOW = new Date('2026-11-05T12:00:00Z');

test('m9d860 as 6 categorias são aceitas e outras recusadas', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const categories = ['CLOUD_SERVICE', 'PROVIDER', 'AI', 'STORAGE', 'EGRESS', 'MESSAGING'];
    await env.record(A, categories.map((category, i) => env.dayLine(A, '2026-10-10', { category, service: `svc${i}` })), tx);
    assert.equal((await env.rows(A, tx)).length, 6);
    assert.equal(await env.codeOf(env.record(A, [env.dayLine(A, '2026-10-10', { category: 'FOO' })], tx)), 'GOV_FINOPS_LINE_INVALID');
    assert.equal(await env.codeOf(env.record(A, [env.dayLine(A, '2026-10-10', { costKind: 'MIXED' })], tx)), 'GOV_FINOPS_LINE_INVALID');
    assert.equal(await env.codeOf(env.record(A, [env.dayLine(A, '2026-10-10', { environment: 'STAGING' })], tx)), 'GOV_FINOPS_LINE_INVALID');
    assert.equal(await env.codeOf(env.record(A, [env.dayLine(A, '2026-10-10', { domain: 'INEXISTENTE' })], tx)), 'GOV_FINOPS_LINE_INVALID');
    assert.equal(await env.codeOf(env.record(A, [env.dayLine(A, '2026-10-10', { amountCents: 10.5 })], tx)), 'GOV_FINOPS_LINE_INVALID', 'centavos são inteiros');
  });
});

test('m9d860 fatura BILLED substitui ESTIMATED sem somar os dois', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.record(A, [env.dayLine(A, '2026-10-05', { amountCents: 199000 }), env.dayLine(A, '2026-10-06', { amountCents: 199000 })], tx);
    const csv = 'invoice_id,period_start,period_end,category,service,domain,amount_brl\nINV-1,2026-10-01,2026-10-31,CLOUD_SERVICE,compute,PLATFORM,"4.120,00"\n';
    const out = await importInvoice(A, { format: 'csv', content: csv, now: NOW }, tx);
    assert.deepEqual([out.inserted, out.superseded], [1, 2]);
    const all = await env.rows(A, tx, "cost_kind = 'ESTIMATED'");
    assert.ok(all.every((r) => r.superseded_by), 'os dois dias estimados foram marcados como substituídos');
    const report = await readModel.report(A, { from: '2026-10-01', to: '2026-10-31' }, {}, tx);
    assert.equal(report.billed.totalCents, 412000);
    assert.equal(report.estimated.totalCents, 0, 'o estimado substituído deixa de somar');
  });
});

test('m9d860 nenhuma consulta devolve total que soma estimado com faturado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.record(A, [env.dayLine(A, '2026-09-10', { amountCents: 3000 }), env.dayLine(A, '2026-09-10', { costKind: 'BILLED', service: 'db', sourceRef: 'F-9', amountCents: 7000 })], tx);
    const report = await readModel.report(A, { from: '2026-09-01', to: '2026-09-30' }, {}, tx);
    assert.deepEqual(Object.keys(report).sort(), ['billed', 'estimated'], 'só as duas séries, sem total misto');
    assert.deepEqual([report.estimated.totalCents, report.billed.totalCents], [3000, 7000]);
    const overview = await finops.getOverview(A, tx, { now: new Date('2026-09-30T12:00:00Z') });
    assert.deepEqual(Object.keys(overview.custos).filter((k) => /total/i.test(k)), [], 'o health também não traz total misto');
    assert.deepEqual([overview.custos.estimado.totalCents, overview.custos.faturado.totalCents], [3000, 7000]);
    for (const line of report.estimated.lines) assert.equal(line.amountCents, 3000);
  });
});

test('m9d860 replay da fatura não duplica', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const json = JSON.stringify({ invoiceId: 'INV-RE', periodStart: '2026-08-01', periodEnd: '2026-08-31', lines: [{ category: 'PROVIDER', service: 'whatsapp', amountCents: 5000 }] });
    const first = await importInvoice(A, { format: 'json', content: json, now: NOW }, tx);
    const again = await importInvoice(A, { format: 'json', content: json, now: NOW }, tx);
    assert.deepEqual([first.inserted, first.replayed], [1, 0]);
    assert.deepEqual([again.inserted, again.replayed], [0, 1]);
    assert.equal((await env.rows(A, tx, "source_ref LIKE 'INV-RE#%'")).length, 1);
  });
});

test('m9d860 fatura de crédito BILLED negativa é aceita e CHARGE negativo é recusado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.record(A, [env.dayLine(A, '2026-10-10', { costKind: 'BILLED', lineType: 'CREDIT', amountCents: -5000, sourceRef: 'CR-1' })], tx);
    const [credit] = await env.rows(A, tx, "source_ref = 'CR-1'");
    assert.equal(credit.amount_cents, '-5000');
    for (const over of [{ costKind: 'BILLED', amountCents: -1 }, { costKind: 'ESTIMATED', lineType: 'CREDIT', amountCents: -1 }, { costKind: 'ESTIMATED', amountCents: -1 }]) {
      const err = await env.record(A, [env.dayLine(A, '2026-10-10', over)], tx).catch((e) => e);
      assert.equal(err.code, 'GOV_FINOPS_AMOUNT_INVALID');
      assert.equal(err.statusCode, 422);
      assert.equal(err.message, 'O valor do custo não pode ser negativo.');
    }
    const bad = await env.sequelize.transaction({ transaction: tx }, (sp) => env.sequelize.query(
      `INSERT INTO governance.cost_ledger (group_id, company_id, environment, domain, category, service, amount_cents, cost_kind, line_type, period_start, period_end, source_ref)
       VALUES (:g, :c, 'PROD', 'PLATFORM', 'AI', 'x', -1, 'ESTIMATED', 'CHARGE', now(), now(), 'direto')`, { transaction: sp, replacements: { g: A.groupId, c: A.companyId } }
    )).catch((e) => e.parent && e.parent.code);
    assert.equal(bad, '23514', 'o banco também recusa o negativo fora de CREDIT BILLED');
  });
});

test('m9d860 linhas de domínios diferentes da mesma fatura não colidem', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const shared = { costKind: 'BILLED', service: 'compute', sourceRef: 'INV-DOM#1' };
    await env.record(A, [env.dayLine(A, '2026-10-10', { ...shared, domain: 'CRM' }), env.dayLine(A, '2026-10-10', { ...shared, domain: 'FINANCEIRO' }),
      env.dayLine(A, '2026-10-10', { ...shared, domain: 'FINANCEIRO', companyId: null })], tx);
    assert.equal((await env.rows(A, tx, "source_ref = 'INV-DOM#1'")).length, 3, 'domínio e empresa (ou custo compartilhado) fazem parte da chave');
    await env.record(A, [env.dayLine(A, '2026-10-10', { ...shared, domain: 'CRM' })], tx);
    assert.equal((await env.rows(A, tx, "source_ref = 'INV-DOM#1'")).length, 3, 'a mesma chave continua única');
  });
});

test('m9d860 ESTIMATED por hora e por dia dentro do mês faturado são superseded', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    const hour = env.midnightSp('2026-10-12');
    await env.record(A, [
      env.dayLine(A, '2026-10-12', { sourceRef: 'dia' }),
      env.dayLine(A, '2026-10-12', { sourceRef: 'hora', periodEnd: env.addHours(hour, 1) }),
      env.dayLine(A, '2026-10-31', { sourceRef: 'ultimo-dia' }),
      env.dayLine(A, '2026-11-01', { sourceRef: 'proximo-mes' }),
      env.dayLine(A, '2026-10-31', { sourceRef: 'atravessa', periodEnd: env.addHours(env.midnightSp('2026-10-31'), 36) }),
      env.dayLine(A, '2026-10-12', { sourceRef: 'outro-servico', service: 'db' }),
    ], tx);
    const csv = 'invoice_id,period_start,period_end,category,service,domain,amount_cents\nINV-OUT,2026-10-01,2026-10-31,CLOUD_SERVICE,compute,PLATFORM,412000\n';
    await importInvoice(A, { format: 'csv', content: csv, now: NOW }, tx);
    const state = Object.fromEntries((await env.rows(A, tx, "cost_kind = 'ESTIMATED'")).map((r) => [r.source_ref, Boolean(r.superseded_by)]));
    assert.deepEqual(state, { dia: true, hora: true, 'ultimo-dia': true, 'proximo-mes': false, atravessa: false, 'outro-servico': false });
    // estimativa que chega depois da fatura já nasce substituída
    await env.record(A, [env.dayLine(A, '2026-10-20', { sourceRef: 'atrasada' })], tx);
    assert.ok((await env.rows(A, tx, "source_ref = 'atrasada'"))[0].superseded_by);
  });
});

test('m9d860 isolamento entre grupos e custo compartilhado só para administrador', { skip: skip() }, async () => {
  await run(async (tx) => {
    const A = tenants.A;
    await env.record(A, [env.dayLine(A, '2026-10-10', { sourceRef: 'so-da-a' }), env.dayLine(A, '2026-10-10', { sourceRef: 'compartilhada', companyId: null, service: 'bucket' })], tx);
    const visible = await readModel.report(A, { from: '2026-10-01', to: '2026-10-31' }, {}, tx);
    assert.equal(visible.estimated.totalCents, 1000, 'sem ser administrador, só a linha da empresa');
    const admin = await readModel.report(A, { from: '2026-10-01', to: '2026-10-31' }, { includeShared: true }, tx);
    assert.equal(admin.estimated.totalCents, 2000, 'o administrador também vê o compartilhado');
  });
  await run(async (tx) => {
    assert.equal((await env.rows(tenants.B, tx, "source_ref IN ('so-da-a', 'compartilhada')")).length, 0, 'o outro grupo não enxerga nada');
    const err = await env.sequelize.transaction({ transaction: tx }, (sp) => env.sequelize.query(
      `INSERT INTO governance.cost_ledger (group_id, company_id, environment, domain, category, service, amount_cents, cost_kind, period_start, period_end, source_ref)
       VALUES (:g, :c, 'PROD', 'PLATFORM', 'AI', 'x', 1, 'ESTIMATED', now(), now(), 'invasor')`, { transaction: sp, replacements: { g: tenants.A.groupId, c: tenants.A.companyId } }
    )).catch((e) => e.parent && e.parent.code);
    assert.equal(err, '42501', 'a RLS recusa gravar no grupo alheio');
  }, tenants.B);
});

test('m9d860 arredondamento half-even', () => {
  assert.equal(divHalfEven(250n, 100n), 2n, '2,5 vai ao par (2)');
  assert.equal(divHalfEven(350n, 100n), 4n, '3,5 vai ao par (4)');
  assert.equal(divHalfEven(120000000n, 31000000n), 4n);
  assert.equal(divHalfEven(1200n * 1000000n, 31n * 1000000n), 39n, '38,71 vira 39');
  assert.equal(divHalfEven(-250n, 100n), -2n);
});
