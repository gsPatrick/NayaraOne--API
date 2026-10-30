'use strict';

// M9-D860 — importação de fatura da nuvem (CSV/JSON) como BILLED de período fechado.
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d860.fatura.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d860Env');
const { importInvoice, collectBilling } = require('../../../src/features/core-governance/finops/collectors/billing');
const { parseInvoice, brlToCents } = require('../../../src/features/core-governance/finops/collectors/billing.parse');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn) => env.withRollbackTenantTransaction(tenants.A, fn);
const NOW = new Date('2026-11-05T12:00:00Z');
const CSV = 'invoice_id,period_start,period_end,category,service,domain,amount_brl,usage_quantity,usage_unit,line_type\n'
  + 'INV-10,2026-10-01,2026-10-31,CLOUD_SERVICE,compute,PLATFORM,"4.120,00",720,hours,CHARGE\n'
  + 'INV-10,2026-10-01,2026-10-31,CLOUD_SERVICE,compute,PLATFORM,"-150,50",0,hours,CREDIT\n';

test('m9d860 importação de fatura de cloud em CSV vira BILLED por período fechado', { skip: skip() }, async () => {
  await run(async (tx) => {
    const out = await importInvoice(tenants.A, { format: 'csv', content: CSV, now: NOW }, tx);
    assert.deepEqual([out.invoiceId, out.inserted], ['INV-10', 2]);
    const rows = await env.rows(tenants.A, tx, "cost_kind = 'BILLED'");
    assert.deepEqual(rows.map((r) => [r.line_type, r.amount_cents]).sort(), [['CHARGE', '412000'], ['CREDIT', '-15050']]);
    assert.equal(new Date(rows[0].period_start).toISOString(), '2026-10-01T03:00:00.000Z');
    assert.equal(new Date(rows[0].period_end).toISOString(), '2026-11-01T03:00:00.000Z');
    const replay = await importInvoice(tenants.A, { format: 'csv', content: CSV, now: NOW }, tx);
    assert.deepEqual([replay.inserted, replay.replayed], [0, 2]);
    assert.equal((await env.rows(tenants.A, tx, "cost_kind = 'BILLED'")).length, 2);
  });
});

test('m9d860 fatura de período aberto ou inválida é recusada sem gravar nada', { skip: skip() }, async () => {
  await run(async (tx) => {
    const open = CSV.replace(/2026-10-31/g, '2026-11-30');
    assert.equal(await env.codeOf(importInvoice(tenants.A, { format: 'csv', content: open, now: NOW }, tx)), 'GOV_FINOPS_PERIOD_OPEN');
    assert.equal(await env.codeOf(importInvoice(tenants.A, { format: 'csv', content: 'invoice_id,period_start\n', now: NOW }, tx)), 'GOV_FINOPS_INVOICE_INVALID');
    assert.equal(await env.codeOf(importInvoice(tenants.A, { format: 'xml', content: '<a/>', now: NOW }, tx)), 'GOV_FINOPS_INVOICE_INVALID');
    const negativeCharge = CSV.replace('CREDIT', 'CHARGE');
    assert.equal(await env.codeOf(importInvoice(tenants.A, { format: 'csv', content: negativeCharge, now: NOW }, tx)), 'GOV_FINOPS_AMOUNT_INVALID');
    assert.equal((await env.rows(tenants.A, tx)).length, 0);
  });
});

test('m9d860 coletor de fatura importa da fonte configurada e é idempotente', { skip: skip() }, async () => {
  await run(async (tx) => {
    const source = async () => [{ format: 'json', content: JSON.stringify({ invoiceId: 'INV-J', periodStart: '2026-09-01', periodEnd: '2026-09-30', lines: [{ category: 'PROVIDER', service: 'sms', amountCents: 900 }] }) }];
    assert.equal(await collectBilling(tenants.A, NOW, tx, { source }), 1);
    assert.equal(await collectBilling(tenants.A, NOW, tx, { source }), 1);
    assert.equal((await env.rows(tenants.A, tx, "source_ref LIKE 'INV-J#%'")).length, 1);
    assert.equal(await collectBilling(tenants.A, NOW, tx), 0, 'sem fonte não há o que importar');
  });
});

test('m9d860 leitura de valores em reais e do CSV', () => {
  assert.equal(brlToCents('4.120,00'), 412000);
  assert.equal(brlToCents('4120.00'), 412000);
  assert.equal(brlToCents('-0,05'), -5);
  assert.equal(brlToCents('abc'), null);
  assert.equal(parseInvoice('csv', CSV).lines.length, 2);
});
