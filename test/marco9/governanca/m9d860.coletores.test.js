'use strict';

// M9-D860 — coletores de IA, mensageria, egress e storage (cálculo em centavos inteiros, consolidação por hora, idempotência, logs do dia).
//   node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d860.coletores.test.js"

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d860Env');
const { recordAiCall, collectAi } = require('../../../src/features/core-governance/finops/collectors/ai');
const { recordMessages, collectMessaging } = require('../../../src/features/core-governance/finops/collectors/messaging');
const { recordEgress, collectEgress } = require('../../../src/features/core-governance/finops/collectors/egress');
const { collectStorage } = require('../../../src/features/core-governance/finops/collectors/storage');
const { runHourly, flushAndCollectEgress } = require('../../../src/features/core-governance/finops/collectors');
const meter = require('../../../src/features/core-governance/finops/collectors/egress.meter');
const hooks = require('../../../src/features/core-governance/finops/finops.hooks');
const logVolume = require('../../../src/shared/log-volume/counter');

let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });
const run = (fn, tenant = tenants.A) => env.withRollbackTenantTransaction(tenant, fn);

// Tabela de preços do registry do provider (R$ por milhão de tokens): R$ 0,002 e R$ 0,008 por mil.
const registry = { classOf: (code) => (code === 'qa-prov' ? class { models() { return [{ model: 'qa-model', pricePerMTokIn: '2', pricePerMTokOut: '8' }]; } } : null) };
const HOUR = new Date('2026-10-10T14:00:00Z');
const LATER = new Date('2026-10-10T18:30:00Z');
const ai = (tokensIn, tokensOut, at = HOUR) => ({ providerCode: 'qa-prov', modelCode: 'qa-model', tokensIn, tokensOut, at, registry });
const ledgerOf = (tx, category) => env.rows(tenants.A, tx, 'category = :category', { category });

test('m9d860 chamada de IA vira custo ESTIMATED em centavos', { skip: skip() }, async () => {
  await run(async (tx) => {
    await recordAiCall(tenants.A, ai(1200000, 300000), tx);
    assert.equal(await collectAi(tenants.A, LATER, tx), 1);
    const [row] = await ledgerOf(tx, 'AI');
    assert.deepEqual([row.cost_kind, row.service, row.amount_cents, row.usage_quantity, row.currency], ['ESTIMATED', 'llm:qa-model', '480', '1500000.000000', 'BRL']);
    assert.equal(row.company_id, tenants.A.companyId);
    const unknown = await recordAiCall(tenants.A, { ...ai(10, 10), modelCode: 'inexistente' }, tx);
    assert.equal(unknown.recorded, false, 'modelo sem preço no registry não grava valor inventado');
  });
});

test('m9d860 chamadas de IA são consolidadas em uma linha inteira por hora', { skip: skip() }, async () => {
  await run(async (tx) => {
    // 1.200 + 300 tokens = R$ 0,0048 (0,48 centavo) por chamada: nenhuma grava sozinha.
    for (let i = 0; i < 10; i += 1) await recordAiCall(tenants.A, ai(1200, 300), tx);
    for (let i = 0; i < 3; i += 1) await recordAiCall(tenants.A, ai(1200, 300, new Date('2026-10-10T15:20:00Z')), tx);
    await recordAiCall(tenants.A, ai(1200, 300, new Date('2026-10-10T18:10:00Z')), tx); // hora ainda aberta às 18:30
    assert.equal(await collectAi(tenants.A, LATER, tx), 2, 'só as horas encerradas viram linha');
    const rows = await ledgerOf(tx, 'AI');
    assert.deepEqual(rows.map((r) => r.amount_cents), ['5', '1'], '4,8 centavos fecham em 5 e 1,44 em 1');
    assert.ok(rows.every((r) => Number.isInteger(Number(r.amount_cents))));
    assert.equal(new Date(rows[0].period_end) - new Date(rows[0].period_start), 3600000);
  });
});

test('m9d860 coletor de mensageria: 2.000 mensagens a R$ 0,05 viram 10.000 centavos ESTIMATED', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.setPrices(tenants.A, { whatsapp: 5, email: 0.2, sms: 10, storage_gb_mes: 10, logs_gb_mes: 10, egress_gb: 50 }, tx);
    await recordMessages(tenants.A, { channel: 'whatsapp', quantity: 2000, at: HOUR }, tx);
    await recordMessages(tenants.A, { channel: 'email', quantity: 500, at: HOUR }, tx);
    assert.equal(await collectMessaging(tenants.A, LATER, tx), 2);
    const byService = Object.fromEntries((await ledgerOf(tx, 'MESSAGING')).map((r) => [r.service, r]));
    assert.deepEqual([byService.whatsapp.amount_cents, byService.whatsapp.cost_kind, byService.whatsapp.usage_unit], ['10000', 'ESTIMATED', 'messages']);
    assert.equal(byService.email.amount_cents, '100', '500 e-mails a 0,2 centavo');
    await env.setPrices(tenants.A, { email: 1 }, tx);
    assert.equal((await recordMessages(tenants.A, { channel: 'whatsapp', quantity: 1, at: HOUR }, tx)).recorded, false, 'canal sem preço configurado não grava');
  });
});

test('m9d860 coletor de egress: 5 GB a R$ 0,50 por GB vira 250 centavos ESTIMATED', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.setPrices(tenants.A, { egress_gb: 50 }, tx);
    await recordEgress(tenants.A, { kind: 'exportacoes', bytes: (5n * env.GB).toString(), at: HOUR }, tx);
    assert.equal(await collectEgress(tenants.A, LATER, tx), 1);
    const [row] = await ledgerOf(tx, 'EGRESS');
    assert.deepEqual([row.amount_cents, row.usage_quantity, row.usage_unit, row.service], ['250', '5.000000', 'GB', 'egress:exportacoes']);
  });
});

test('m9d860 contador de bytes de download alimenta o egress da hora', { skip: skip() }, async () => {
  meter.reset();
  await run(async (tx) => {
    await env.setPrices(tenants.A, { egress_gb: 50 }, tx);
    meter.add(tenants.A, 'arquivos', Number(env.GB));
    meter.add(tenants.A, 'arquivos', Number(env.GB));
    meter.add(tenants.B, 'arquivos', 77);
    await flushAndCollectEgress(tenants.A, HOUR, tx); // o uso cai na hora corrente: ainda aberta
    assert.equal((await ledgerOf(tx, 'EGRESS')).length, 0);
    await flushAndCollectEgress(tenants.A, LATER, tx);
    assert.equal((await ledgerOf(tx, 'EGRESS'))[0].amount_cents, '100', '2 GB a 0,50');
  });
  assert.equal(meter.takeFor(tenants.B)[0].bytes, 77n, 'o contador de outra empresa não é tocado');
  meter.reset();
});

test('m9d860 coletor de storage: 120 GB a R$ 0,10 por GB-mês em 31 dias vira 39 centavos/dia ESTIMATED', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.setPrices(tenants.A, { storage_gb_mes: 10, logs_gb_mes: 10 }, tx);
    const now = new Date('2026-11-01T05:00:00Z'); // 02:00 de Brasília: mede o dia 31/10
    const measurements = [{ service: 'bucket', companyId: null, bytes: 120n * env.GB, unit: 'storage' }];
    assert.equal(await collectStorage(tenants.A, now, tx, { measurements }), 1);
    const [row] = await ledgerOf(tx, 'STORAGE');
    assert.deepEqual([row.amount_cents, row.cost_kind, row.usage_quantity, row.usage_unit, row.company_id, row.source_ref], ['39', 'ESTIMATED', '120.000000', 'GB', null, 'storage:bucket:2026-10-31']);
    assert.equal(new Date(row.period_start).toISOString(), '2026-10-31T03:00:00.000Z');
    assert.equal(new Date(row.period_end).toISOString(), '2026-11-01T03:00:00.000Z');
    // novembro tem 30 dias: 1200 / 30 = 40
    await collectStorage(tenants.A, new Date('2026-11-16T05:00:00Z'), tx, { measurements });
    assert.deepEqual((await ledgerOf(tx, 'STORAGE')).map((r) => r.amount_cents), ['39', '40']);
  });
});

test('m9d860 coletor de storage grava o volume de log do dia', { skip: skip() }, async () => {
  await run(async (tx) => {
    await env.setPrices(tenants.A, { storage_gb_mes: 10, logs_gb_mes: 20 }, tx);
    logVolume.reset();
    logVolume.add(Number(2n * env.GB), new Date('2026-10-31T15:00:00Z'));
    await collectStorage(tenants.A, new Date('2026-11-01T05:00:00Z'), tx);
    const logs = (await ledgerOf(tx, 'STORAGE')).find((r) => r.service === 'logs');
    assert.deepEqual([logs.usage_quantity, logs.usage_unit, logs.company_id, logs.amount_cents], ['2.000000', 'GB', null, '1'], '2 GB x 20 centavos / 31 dias = 1,29 centavo');
    logVolume.reset();
    await collectStorage(tenants.A, new Date('2026-11-02T05:00:00Z'), tx);
    assert.equal((await ledgerOf(tx, 'STORAGE')).filter((r) => r.service === 'logs').length, 1, 'dia que o processo não observou não vira linha');
  });
});

test('m9d860 cada coletor reexecutado no mesmo período não duplica a linha', { skip: skip() }, async () => {
  await run(async (tx) => {
    await recordAiCall(tenants.A, ai(1200000, 300000), tx);
    await recordMessages(tenants.A, { channel: 'whatsapp', quantity: 10, at: HOUR }, tx);
    await recordEgress(tenants.A, { kind: 'arquivos', bytes: Number(env.GB), at: HOUR }, tx);
    const measurements = [{ service: 'files:image', companyId: tenants.A.companyId, bytes: 5n * env.GB, unit: 'storage' }];
    const count = async () => (await env.rows(tenants.A, tx)).length;
    for (let i = 0; i < 3; i += 1) {
      await collectAi(tenants.A, LATER, tx); await collectMessaging(tenants.A, LATER, tx); await collectEgress(tenants.A, LATER, tx);
      await collectStorage(tenants.A, new Date('2026-11-01T05:00:00Z'), tx, { measurements });
    }
    assert.equal(await count(), 4, 'uma linha por coletor, mesmo rodando três vezes');
    // uso que chega depois do fechamento da hora atualiza a MESMA linha
    await recordAiCall(tenants.A, ai(1200000, 300000), tx);
    await collectAi(tenants.A, LATER, tx);
    const rows = await ledgerOf(tx, 'AI');
    assert.deepEqual([rows.length, rows[0].amount_cents], [1, '960']);
  });
});

test('m9d860 coletor com falha não inventa valor', { skip: skip() }, async () => {
  const { runCollector } = require('../../../src/features/core-governance/finops/collectors/run');
  await run(async (tx) => {
    const ok = await runCollector(tenants.A, 'storage', async () => { await env.record(tenants.A, [env.dayLine(tenants.A, '2026-10-10')], tx); return 1; }, tx);
    assert.equal(ok.ok, true);
    const before = (await env.rows(tenants.A, tx)).length;
    const failed = await runCollector(tenants.A, 'storage', async () => {
      await env.record(tenants.A, [env.dayLine(tenants.A, '2026-10-11')], tx);
      throw new Error('API da nuvem fora do ar');
    }, tx);
    assert.deepEqual([failed.ok, failed.code], [false, 'GOV_FINOPS_COLLECTOR_FAILED']);
    assert.equal((await env.rows(tenants.A, tx)).length, before, 'nada do lote que falhou ficou gravado');
    const [state] = await env.sequelize.query("SELECT * FROM governance.cost_collector_runs WHERE collector = 'storage'", { type: 'SELECT', transaction: tx });
    assert.deepEqual([state.last_status, state.last_error_code, state.consecutive_failures], ['FAILED', 'GOV_FINOPS_COLLECTOR_FAILED', 1]);
    assert.ok(state.last_success_at, 'o último sucesso continua à vista');
    const overview = await require('../../../src/features/core-governance/finops/finops.service').getOverview(tenants.A, tx);
    assert.equal(overview.coletores[0].situacao, 'FAILED');
    assert.ok(overview.coletores[0].ultimoSucesso);
  });
});

test('m9d860 ganchos de IA e mensageria registram o uso e nunca derrubam quem os chama', { skip: skip() }, async () => {
  await run(async (tx) => {
    const ctx = { groupId: tenants.A.groupId, companyId: tenants.A.companyId };
    await hooks.onDispatchConfirmed(ctx, { operation: 'sendText' }, tx);
    await hooks.onDispatchConfirmed(ctx, { operation: 'sendEmail' }, tx);
    await hooks.onDispatchConfirmed(ctx, { operation: 'getStatus' }, tx);
    const [{ n }] = await env.sequelize.query("SELECT sum(calls)::int AS n FROM governance.cost_accruals WHERE category = 'MESSAGING'", { type: 'SELECT', transaction: tx });
    assert.equal(n, 2, 'só as operações de envio contam');
    const final = ['COMPLETED', 'FAILED'];
    await hooks.onAiRunFinished(ctx, { status: 'COMPLETED', cached: true, tokensIn: 5, tokensOut: 5, providerCode: 'sandbox', modelCode: 'sandbox-1' }, final, tx);
    await hooks.onAiRunFinished(ctx, { status: 'RUNNING', tokensIn: 5, tokensOut: 5, providerCode: 'sandbox', modelCode: 'sandbox-1' }, final, tx);
    await hooks.onAiRunFinished(ctx, { status: 'COMPLETED', tokensIn: 5, tokensOut: 5, providerCode: 'nao-existe', modelCode: 'x' }, final, tx);
    const [{ ai: aiRows }] = await env.sequelize.query("SELECT count(*)::int AS ai FROM governance.cost_accruals WHERE category = 'AI'", { type: 'SELECT', transaction: tx });
    assert.equal(aiRows, 0, 'cache, run aberto e provider desconhecido não gravam');
    const results = await runHourly(tenants.A, LATER, tx);
    assert.deepEqual(results.map((r) => r.ok), [true, true, true, true]);
  });
});
