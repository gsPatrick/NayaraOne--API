'use strict';

/**
 * Teste de carga de Estoque / Compras (Marco 7, Guia §1/§14 "testes/carga/falhas", E8 "Carga,
 * concorrência, segurança"). Mesmo espírito de loadTestConstruction.js (operações reais pela
 * camada de serviço, mesma transação/RLS da aplicação — SET LOCAL app.group_id/company_id/user_id
 * — e p50/p95/p99 reais), mas medindo ESCRITA CONCORRENTE, que é onde Estoque/Compras quebram:
 *
 *   - movimentações concorrentes (IN, OUT, TRANSFER) disputando poucos itens "quentes", com
 *     saídas que tentariam passar do saldo (precisam ser recusadas, nunca deixar saldo negativo);
 *   - recebimentos de compra concorrentes no MESMO pedido (lock do pedido) + replays da mesma
 *     idempotencyKey/NF disparados em paralelo (não podem duplicar recebimento nem payable);
 *   - requisições de material criadas, aprovadas por outra pessoa e entregues em paralelo;
 *   - leituras (saldos por item e histórico de movimentos) concorrendo com as escritas.
 *
 * Gates (o script sai com código 1 se algum falhar):
 *   zero saldo negativo; saldo de cada item/local = soma do ledger; zero duplicidade (chave de
 *   idempotência de movimento/recebimento, NF por empresa, payable por recebimento); recebido
 *   por item de pedido = soma dos recebimentos; zero erro inesperado (só recusas de negócio
 *   esperadas, como saldo insuficiente); p95 de cada operação abaixo do limite (--p95-ms,
 *   padrão 300 ms — meta do contrato §16).
 *
 * SÓ roda em banco descartável: scripts/withDisposableDb.js (DISPOSABLE_DB=1) ou no Postgres
 * efêmero do CI (CI=true). Uso:
 *   node scripts/withDisposableDb.js -- node scripts/loadTestInventoryProcurement.js [--light] [--concurrency 16] [--json <arquivo>]
 */

process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '24';
require('dotenv').config();

if (!process.env.DISPOSABLE_DB && !process.env.CI) {
  console.error('loadTestInventoryProcurement: recusado — commita volume de dados; rode via scripts/withDisposableDb.js ou no CI.');
  process.exit(2);
}

const fs = require('fs');
const fx = require('./lib/inventoryFixtures');

const argv = process.argv.slice(2);
const argValue = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const LIGHT = argv.includes('--light');
const CONCURRENCY = Number(argValue('--concurrency')) || 16;
const P95_GATE_MS = Number(argValue('--p95-ms')) || 300;
const JSON_OUT = argValue('--json');

const SIZE = LIGHT
  ? { items: 6, hotItems: 2, movements: 300, orders: 6, receiptsPerOrder: 4, replays: 20, requisitions: 20, reads: 60 }
  : { items: 30, hotItems: 4, movements: 2400, orders: 30, receiptsPerOrder: 5, replays: 120, requisitions: 150, reads: 400 };

const EXPECTED_BUSINESS_CODES = new Set(['INVENTORY_INSUFFICIENT_BALANCE']);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}

const stats = {};
function record(op, ms, outcome) {
  if (!stats[op]) stats[op] = { samples: [], ok: 0, business: {}, unexpected: {} };
  const s = stats[op];
  s.samples.push(ms);
  if (outcome === 'ok') s.ok += 1;
  else if (EXPECTED_BUSINESS_CODES.has(outcome)) s.business[outcome] = (s.business[outcome] || 0) + 1;
  else s.unexpected[outcome] = (s.unexpected[outcome] || 0) + 1;
}

async function timed(op, fn) {
  const t0 = process.hrtime.bigint();
  let outcome = 'ok';
  try {
    await fn();
  } catch (err) {
    outcome = err.code || err.parent?.code || err.original?.code || err.name || 'ERRO';
    if (!EXPECTED_BUSINESS_CODES.has(outcome) && !stats[op]?.firstError) {
      stats[op] = stats[op] || { samples: [], ok: 0, business: {}, unexpected: {} };
      stats[op].firstError = `${outcome}: ${err.message}`;
    }
  }
  record(op, Number(process.hrtime.bigint() - t0) / 1e6, outcome);
}

async function runPool(tasks, concurrency) {
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) {
      const task = tasks[i];
      i += 1;
      // eslint-disable-next-line no-await-in-loop
      await task();
    }
  });
  await Promise.all(workers);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function main() {
  const startedAt = Date.now();
  const ctx = fx.load();
  const tenant = await fx.getSeedTenant(ctx);
  const approver = await fx.createUser(ctx, 'Aprovador Carga');
  const T = (fn, userId) => fx.inTenant(ctx, tenant, fn, userId);
  const run = fx.suffix();

  console.log(`# Carga Estoque/Compras — ${LIGHT ? 'LEVE (CI)' : 'COMPLETA'}; concorrência ${CONCURRENCY}; pool ${process.env.DB_POOL_MAX}`);
  console.log('--- SETUP (serviços reais, commitado) ---');
  const setup = await T(async (t) => {
    const items = [];
    for (let i = 0; i < SIZE.items; i += 1) items.push(await fx.createItem(ctx, tenant, t, `Carga item ${run}-${i}`));
    const whs = [];
    for (let i = 0; i < 3; i += 1) whs.push(await fx.createWarehouse(ctx, tenant, t, `Carga depósito ${run}-${i}`));
    const resp = await fx.createPerson(ctx, tenant, t, `Carga encarregado ${run}`, 'PF');
    const supplier = await fx.createPerson(ctx, tenant, t, `Carga fornecedor ${run}`);
    for (const [idx, it] of items.entries()) {
      // Itens "quentes" começam com pouco saldo, para as saídas concorrentes esbarrarem no zero.
      await fx.move(ctx, tenant, t, { inventoryItemId: it.id, movementType: 'IN', quantity: idx < SIZE.hotItems ? 40 : 5000, destinationLocationId: whs[0].id, reason: 'saldo inicial carga' });
    }
    const orders = [];
    for (let i = 0; i < SIZE.orders; i += 1) {
      orders.push(await fx.createOpenPurchaseOrder(ctx, tenant, t, { supplierPersonId: supplier.id, approverId: approver.id, lines: [{ inventoryItemId: items[i % items.length].id, description: `Material ${i}`, quantity: 10 * SIZE.receiptsPerOrder, unitPrice: 17.35 }] }));
    }
    return { items, whs, resp, supplier, orders };
  });
  console.log(`  ${setup.items.length} itens (${SIZE.hotItems} quentes com saldo 40), 3 depósitos, ${setup.orders.length} pedidos abertos.`);

  const actor = { userId: tenant.userId, canApprove: false };
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const tasks = [];

  // Movimentações: 50% nos itens quentes (OUT de 3 a 7 un. — muitas precisam ser recusadas).
  for (let i = 0; i < SIZE.movements; i += 1) {
    const hot = i % 2 === 0;
    const item = hot ? setup.items[i % SIZE.hotItems] : pick(setup.items.slice(SIZE.hotItems));
    const kind = hot ? (i % 6 === 0 ? 'TRANSFER' : 'OUT') : pick(['IN', 'OUT', 'TRANSFER']);
    const key = `carga-${run}-mov-${i}`;
    const fields = { inventoryItemId: item.id, movementType: kind, quantity: hot ? 3 + (i % 5) : 1 + (i % 9), idempotencyKey: key, reason: 'carga' };
    if (kind === 'IN') fields.destinationLocationId = pick(setup.whs).id;
    if (kind === 'OUT') Object.assign(fields, { sourceLocationId: setup.whs[0].id, responsiblePersonId: setup.resp.id });
    if (kind === 'TRANSFER') Object.assign(fields, { sourceLocationId: setup.whs[0].id, destinationLocationId: setup.whs[1 + (i % 2)].id, responsiblePersonId: setup.resp.id });
    tasks.push(() => timed(`movimento ${kind}`, () => T((t) => fx.move(ctx, tenant, t, fields))));
    // Replays da mesma chave em paralelo (retry de rede): não podem duplicar.
    if (i % Math.ceil(SIZE.movements / SIZE.replays) === 0) tasks.push(() => timed('replay de movimento', () => T((t) => fx.move(ctx, tenant, t, fields))));
  }

  // Recebimentos: vários no MESMO pedido ao mesmo tempo + replays da mesma chave/NF.
  setup.orders.forEach((po, o) => {
    for (let r = 0; r < SIZE.receiptsPerOrder; r += 1) {
      const payload = { destinationLocationId: setup.whs[0].id, invoiceFingerprint: `CARGA-${run}-${o}-${r}`, invoiceTotalAmount: 10 * 17.35, idempotencyKey: `carga-${run}-gr-${o}-${r}`, items: [{ purchaseOrderItemId: po.items[0].id, receivedQuantity: 10 }] };
      const receive = () => T((t) => ctx.procurementService.confirmGoodsReceipt(po.order.id, tenant.groupId, tenant.companyId, payload, actor, t));
      tasks.push(() => timed('recebimento de compra', receive));
      if (r === 0) tasks.push(() => timed('replay de recebimento', receive));
    }
  });

  // Requisições de material: criar → aprovar (outra pessoa) → entregar.
  for (let i = 0; i < SIZE.requisitions; i += 1) {
    const item = pick(setup.items.slice(SIZE.hotItems));
    tasks.push(async () => {
      let reqId = null;
      await timed('requisição: criar', async () => {
        reqId = (await T((t) => ctx.requisitionsService.createRequisition({ groupId: tenant.groupId, companyId: tenant.companyId, warehouseLocationId: setup.whs[0].id, items: [{ inventoryItemId: item.id, quantity: 2 }] }, tenant.userId, t))).id;
      });
      if (!reqId) return;
      await timed('requisição: aprovar', () => T((t) => ctx.requisitionsService.decideRequisition(reqId, 'APPROVED', approver.id, tenant.groupId, tenant.companyId, t), approver.id));
      await timed('requisição: entregar', () => T((t) => ctx.requisitionsService.issueRequisition(reqId, { userId: tenant.userId, canApprove: true }, tenant.groupId, tenant.companyId, t)));
    });
  }

  // Leituras concorrendo com as escritas.
  for (let i = 0; i < SIZE.reads; i += 1) {
    const item = pick(setup.items);
    tasks.push(() => timed('leitura: saldos do item', () => T((t) => ctx.movementsService.listBalancesByItem(item.id, tenant.groupId, tenant.companyId, t))));
    tasks.push(() => timed('leitura: histórico de movimentos', () => T((t) => ctx.movementsService.listMovements({ inventoryItemId: item.id, limit: 50 }, tenant.groupId, tenant.companyId, t))));
  }

  shuffle(tasks);
  console.log(`--- CARGA: ${tasks.length} tarefas, ${CONCURRENCY} em paralelo ---`);
  const loadStart = Date.now();
  await runPool(tasks, CONCURRENCY);
  const loadSeconds = (Date.now() - loadStart) / 1000;

  // ------------------------------------------------------------------ resultados
  const rows = Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)).map(([op, s]) => {
    const sorted = [...s.samples].sort((a, b) => a - b);
    return { op, n: sorted.length, ok: s.ok, recusasNegocio: s.business, inesperados: s.unexpected, firstError: s.firstError, p50: percentile(sorted, 50), p95: percentile(sorted, 95), p99: percentile(sorted, 99), max: sorted[sorted.length - 1] };
  });
  const totalOps = rows.reduce((a, r) => a + r.n, 0);
  console.log(`\n${totalOps} operações em ${loadSeconds.toFixed(1)} s (${(totalOps / loadSeconds).toFixed(0)} op/s)\n`);
  console.log('| Operação | n | ok | recusas de negócio | inesperados | p50 ms | p95 ms | p99 ms | máx ms |');
  console.log('|---|---:|---:|---|---|---:|---:|---:|---:|');
  const fmt = (o) => (Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(', ') : '—');
  for (const r of rows) console.log(`| ${r.op} | ${r.n} | ${r.ok} | ${fmt(r.recusasNegocio)} | ${fmt(r.inesperados)} | ${r.p50.toFixed(1)} | ${r.p95.toFixed(1)} | ${r.p99.toFixed(1)} | ${r.max.toFixed(1)} |`);
  for (const r of rows) if (r.firstError) console.log(`  primeiro erro inesperado em "${r.op}": ${r.firstError}`);

  // ------------------------------------------------------------------ invariantes (SQL direto, com RLS do tenant)
  const inv = await T(async (t) => {
    const q = async (sql) => (await ctx.sequelize.query(sql, { type: ctx.sequelize.QueryTypes.SELECT, transaction: t }))[0];
    return {
      negativos: Number((await q('SELECT COUNT(*) AS n FROM inventory.stock_balances WHERE quantity_on_hand < 0')).n),
      ledgerDivergente: Number((await q(`
        WITH f AS (SELECT inventory_item_id i, destination_location_id l, quantity q FROM inventory.inventory_movements WHERE destination_location_id IS NOT NULL
                   UNION ALL SELECT inventory_item_id, source_location_id, -quantity FROM inventory.inventory_movements WHERE source_location_id IS NOT NULL),
             g AS (SELECT i, l, SUM(q) s FROM f GROUP BY 1, 2)
        SELECT COUNT(*) AS n FROM g FULL JOIN inventory.stock_balances b ON b.inventory_item_id = g.i AND b.location_id = g.l
         WHERE COALESCE(b.quantity_on_hand, 0) <> COALESCE(g.s, 0)`)).n),
      movimentoDuplicado: Number((await q('SELECT COUNT(*) AS n FROM (SELECT idempotency_key FROM inventory.inventory_movements WHERE idempotency_key IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1) d')).n),
      recebimentoDuplicado: Number((await q('SELECT COUNT(*) AS n FROM (SELECT idempotency_key FROM procurement.goods_receipts WHERE idempotency_key IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1) d')).n),
      nfDuplicada: Number((await q('SELECT COUNT(*) AS n FROM (SELECT invoice_fingerprint FROM procurement.goods_receipts WHERE invoice_fingerprint IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1) d')).n),
      payableDuplicado: Number((await q("SELECT COUNT(*) AS n FROM (SELECT idempotency_key FROM finance.financial_entries WHERE idempotency_key LIKE 'goods-receipt:%' GROUP BY 1 HAVING COUNT(*) > 1) d")).n),
      recebimentoSemPayable: Number((await q("SELECT COUNT(*) AS n FROM procurement.goods_receipts WHERE status = 'CONFIRMED' AND financial_entry_id IS NULL")).n),
      pedidoDivergente: Number((await q(`SELECT COUNT(*) AS n FROM procurement.purchase_order_items poi
         LEFT JOIN (SELECT purchase_order_item_id, SUM(received_quantity) s FROM procurement.goods_receipt_items GROUP BY 1) g ON g.purchase_order_item_id = poi.id
         WHERE poi.received_quantity <> COALESCE(g.s, 0)`)).n),
      recebimentos: Number((await q(`SELECT COUNT(*) AS n FROM procurement.goods_receipts WHERE idempotency_key LIKE 'carga-${run}-%'`)).n),
      movimentos: Number((await q('SELECT COUNT(*) AS n FROM inventory.inventory_movements')).n),
    };
  });
  const expectedReceipts = SIZE.orders * SIZE.receiptsPerOrder;
  const gates = [
    ['zero saldo negativo', inv.negativos === 0, `${inv.negativos}`],
    ['saldo = soma do ledger em todo item/local', inv.ledgerDivergente === 0, `${inv.ledgerDivergente} divergente(s)`],
    ['zero movimento duplicado (idempotencyKey)', inv.movimentoDuplicado === 0, `${inv.movimentoDuplicado}`],
    ['zero recebimento duplicado (chave e NF)', inv.recebimentoDuplicado + inv.nfDuplicada === 0, `chave ${inv.recebimentoDuplicado}, NF ${inv.nfDuplicada}`],
    ['zero payable duplicado / recebimento sem payable', inv.payableDuplicado + inv.recebimentoSemPayable === 0, `duplicado ${inv.payableDuplicado}, sem payable ${inv.recebimentoSemPayable}`],
    [`recebimentos gravados = ${expectedReceipts} (replays não somam)`, inv.recebimentos === expectedReceipts, `${inv.recebimentos}`],
    ['recebido por item de pedido = soma dos recebimentos', inv.pedidoDivergente === 0, `${inv.pedidoDivergente}`],
    ['zero erro inesperado', rows.every((r) => !Object.keys(r.inesperados).length), rows.filter((r) => Object.keys(r.inesperados).length).map((r) => `${r.op}: ${fmt(r.inesperados)}`).join('; ') || '0'],
    [`p95 < ${P95_GATE_MS} ms em todas as operações`, rows.every((r) => r.p95 < P95_GATE_MS), `maior p95: ${Math.max(...rows.map((r) => r.p95)).toFixed(1)} ms`],
  ];
  console.log('\n--- GATES ---');
  for (const [name, ok, detail] of gates) console.log(`  ${ok ? '✅' : '❌'} ${name} — ${detail}`);
  console.log(`\n${inv.movimentos} movimentos no ledger ao final. Duração total ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);

  const failed = gates.filter(([, ok]) => !ok).length;
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ date: new Date().toISOString(), mode: LIGHT ? 'light' : 'full', concurrency: CONCURRENCY, pool: Number(process.env.DB_POOL_MAX), totalOps, loadSeconds, ops: rows, invariants: inv, gates: gates.map(([name, ok, detail]) => ({ name, ok, detail })) }, null, 2));
  await ctx.sequelize.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`loadTestInventoryProcurement falhou: ${err.code || ''} ${err.message}`);
  process.exit(1);
});
