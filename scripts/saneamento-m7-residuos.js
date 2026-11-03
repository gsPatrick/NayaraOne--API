'use strict';

/**
 * M7 (19/10/2026) — saneamento dos 3 resíduos de dados de homologação anteriores às correções
 * do Marco 7, PELA APLICAÇÃO e com trilha em audit.audit_log (append-only). Nenhuma linha do ledger
 * (inventory.inventory_movements) nem do audit_log sofre UPDATE/DELETE.
 *
 *  1. Saldo materializado divergente do ledger (antes de f267aa9): o ajuste com origem E destino
 *     de 15/10 gravou −2 na origem no ledger, mas o código antigo só creditava o destino — o
 *     saldo materializado da origem ficou 2 acima da soma dos movimentos. O LEDGER está certo;
 *     um movimento compensatório mudaria o ledger e manteria a diferença. Por isso o saldo
 *     materializado é recalculado a partir dos movimentos (SELECT ... FOR UPDATE), com auditoria
 *     'inventory.stock_balance.recalculated_from_ledger' (antes/depois).
 *  2. SKU repetido (antes de 0d6cb39): o item mais recente vira "<SKU>-DUP" via
 *     items.service.updateItem (mesma checagem de duplicidade da tela) + auditoria.
 *  3. Divergências de recebimento decididas por quem registrou o recebimento (antes de 0ab0e7b):
 *     a decisão NÃO é apagada (não existe fluxo de re-decisão — resolveDiscrepancy só aceita OPEN).
 *     Anotação visível em resolution_notes ("[SANEAMENTO M7 ...]") + auditoria
 *     'procurement.divergence.legacy_segregation_annotated', assinada por um usuário diferente de
 *     quem registrou o recebimento.
 *
 * Idempotente: cada passo só age se o problema ainda existir / a anotação ainda não existir.
 * Uso: node scripts/saneamento-m7-residuos.js            (dry-run, só relata)
 *      node scripts/saneamento-m7-residuos.js --apply    (aplica)
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.migration.local') });
const { Client } = require('pg');
const { sequelize, InventoryStockBalance, ReceiptDiscrepancy } = require('../src/models');
const itemsService = require('../src/features/inventory/items.service');
const { registrarAuditoria } = require('../src/engines/audit/auditLog.service');

const APPLY = process.argv.includes('--apply');
const MOTIVO_SALDO = 'Saneamento de dado de homologação anterior à correção f267aa9';
const MOTIVO_SKU = 'Saneamento de dado de homologação anterior à correção 0d6cb39 (SKU repetido)';
const MOTIVO_DIV = 'Saneamento: decisão anterior à regra de segregação 0ab0e7b (quem registra o recebimento não decide a própria divergência). Decisão preservada; anotada.';
const MARCA_DIV = '[SANEAMENTO M7 19/10/2026: decisão anterior à regra de segregação 0ab0e7b — tomada por quem registrou o recebimento; preservada e anotada]';

function migrationClient() {
  return new Client({
    host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME,
    user: process.env.DB_MIGRATION_USER, password: process.env.DB_MIGRATION_PASSWORD,
  });
}

// core.users tem RLS por tenant; a leitura do id dos atores usa a credencial de migration (só SELECT).
async function scanUsers(emails) {
  const c = migrationClient();
  await c.connect();
  try {
    const { rows } = await c.query('SELECT id, email FROM core.users WHERE email = ANY($1)', [emails]);
    return emails.map((e) => rows.find((r) => r.email === e));
  } finally {
    await c.end();
  }
}

async function scan() {
  const c = migrationClient();
  await c.connect();
  try {
    const { rows: balances } = await c.query(`
      WITH mv AS (
        SELECT inventory_item_id, destination_location_id AS loc, quantity AS q FROM inventory.inventory_movements WHERE destination_location_id IS NOT NULL
        UNION ALL
        SELECT inventory_item_id, source_location_id, -quantity FROM inventory.inventory_movements WHERE source_location_id IS NOT NULL),
      s AS (SELECT inventory_item_id, loc, SUM(q) soma FROM mv GROUP BY 1, 2)
      SELECT b.id, b.group_id, b.company_id, b.inventory_item_id, b.location_id, i.sku,
             b.quantity_on_hand::numeric AS saldo, COALESCE(s.soma, 0)::numeric AS soma
        FROM inventory.stock_balances b
        JOIN inventory.inventory_items i ON i.id = b.inventory_item_id
        LEFT JOIN s ON s.inventory_item_id = b.inventory_item_id AND s.loc = b.location_id
       WHERE abs(b.quantity_on_hand - COALESCE(s.soma, 0)) > 0.000001`);
    const { rows: skus } = await c.query(`
      SELECT i.id, i.group_id, i.company_id, i.sku, i.created_at,
             row_number() OVER (PARTITION BY i.company_id, lower(i.sku) ORDER BY i.created_at) AS ordem
        FROM inventory.inventory_items i
       WHERE i.deleted_at IS NULL AND i.sku IS NOT NULL
         AND (i.company_id, lower(i.sku)) IN (SELECT company_id, lower(sku) FROM inventory.inventory_items
                                              WHERE deleted_at IS NULL AND sku IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1)
       ORDER BY i.company_id, lower(i.sku), i.created_at`);
    const { rows: divs } = await c.query(`
      SELECT d.id, d.group_id, d.company_id, d.status, d.resolved_at, d.resolution_notes, gr.created_by AS receipt_created_by
        FROM procurement.receipt_discrepancies d
        JOIN procurement.goods_receipt_items gi ON gi.id = d.goods_receipt_item_id
        JOIN procurement.goods_receipts gr ON gr.id = gi.goods_receipt_id
       WHERE d.resolved_by_user_id = gr.created_by
       ORDER BY d.resolved_at`);
    return { balances, skus: skus.filter((r) => Number(r.ordem) > 1), divs };
  } finally {
    await c.end();
  }
}

async function inTenant(row, actorUserId, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: row.group_id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: row.company_id }, transaction });
    await sequelize.query('SET LOCAL app.user_id = :u', { replacements: { u: actorUserId }, transaction });
    return fn(transaction);
  });
}

async function main() {
  const users = await scanUsers([process.env.ACTOR_EMAIL || 'admin@nayaraone.dev', 'homo-qa-aprovador@nayaraone.dev']);
  const [admin, segundo] = users;
  if (!admin || !segundo) throw new Error('Usuários de saneamento não encontrados.');
  console.log(`Modo: ${APPLY ? 'APLICAR' : 'dry-run (use --apply)'}`);

  const antes = await scan();
  console.log('\nANTES:');
  console.log(' saldos divergentes:', antes.balances.map((b) => ({ id: b.id, sku: b.sku, saldo: b.saldo, soma: b.soma })));
  console.log(' SKUs repetidos (cópias mais recentes):', antes.skus.map((s) => ({ id: s.id, sku: s.sku })));
  const divsPendentes = antes.divs.filter((d) => !(d.resolution_notes || '').includes('[SANEAMENTO M7'));
  console.log(' divergências autodecididas:', antes.divs.length, '— sem anotação:', divsPendentes.map((d) => d.id));

  const auditIds = [];
  if (APPLY) {
    for (const b of antes.balances) {
      await inTenant(b, admin.id, async (t) => {
        const bal = await InventoryStockBalance.findOne({ where: { id: b.id }, transaction: t, lock: t.LOCK.UPDATE });
        const [[{ soma }]] = await sequelize.query(
          `SELECT COALESCE(SUM(CASE WHEN destination_location_id = :loc THEN quantity ELSE 0 END)
                         - SUM(CASE WHEN source_location_id = :loc THEN quantity ELSE 0 END), 0) AS soma
             FROM inventory.inventory_movements WHERE inventory_item_id = :item`,
          { replacements: { loc: bal.locationId, item: bal.inventoryItemId }, transaction: t });
        const before = Number(bal.quantityOnHand);
        if (Math.abs(before - Number(soma)) < 1e-6) return;
        bal.quantityOnHand = Number(soma);
        await bal.save({ transaction: t });
        const a = await registrarAuditoria({
          groupId: b.group_id, companyId: b.company_id, actorUserId: admin.id,
          action: 'inventory.stock_balance.recalculated_from_ledger', entityType: 'InventoryStockBalance', entityId: b.id,
          beforeJson: { quantityOnHand: before }, afterJson: { quantityOnHand: Number(soma), ledgerSum: Number(soma) },
          reason: `${MOTIVO_SALDO}. Causa: ajuste com origem e destino (15/10) registrou −2 na origem no ledger, mas o código antigo só creditou o destino; o saldo materializado foi recalculado a partir dos movimentos (ledger intacto).`,
        }, t);
        auditIds.push(a.id);
      });
    }
    for (const s of antes.skus) {
      await inTenant(s, admin.id, async (t) => {
        const novo = `${s.sku.toUpperCase()}-DUP`;
        await itemsService.updateItem(s.id, { sku: novo }, admin.id, s.group_id, s.company_id, t);
        const a = await registrarAuditoria({
          groupId: s.group_id, companyId: s.company_id, actorUserId: admin.id,
          action: 'inventory.item.sku_deduplicated', entityType: 'InventoryItem', entityId: s.id,
          beforeJson: { sku: s.sku }, afterJson: { sku: novo }, reason: MOTIVO_SKU,
        }, t);
        auditIds.push(a.id);
      });
    }
    for (const d of divsPendentes) {
      const ator = d.receipt_created_by === segundo.id ? admin : segundo;
      await inTenant(d, ator.id, async (t) => {
        const div = await ReceiptDiscrepancy.findOne({ where: { id: d.id }, transaction: t, lock: t.LOCK.UPDATE });
        if ((div.resolutionNotes || '').includes('[SANEAMENTO M7')) return;
        const beforeNotes = div.resolutionNotes;
        div.resolutionNotes = `${beforeNotes ? `${beforeNotes} ` : ''}${MARCA_DIV}`;
        await div.save({ transaction: t });
        const a = await registrarAuditoria({
          groupId: d.group_id, companyId: d.company_id, actorUserId: ator.id,
          action: 'procurement.divergence.legacy_segregation_annotated', entityType: 'ReceiptDiscrepancy', entityId: d.id,
          beforeJson: { status: div.status, resolutionNotes: beforeNotes, receiptCreatedBy: d.receipt_created_by },
          afterJson: { status: div.status, resolutionNotes: div.resolutionNotes, legacySegregation: true },
          reason: MOTIVO_DIV,
        }, t);
        auditIds.push(a.id);
      });
    }
  }

  const depois = await scan();
  console.log('\nDEPOIS:');
  console.log(' saldos divergentes:', depois.balances.length);
  console.log(' SKUs repetidos:', depois.skus.length);
  console.log(' divergências autodecididas sem anotação:', depois.divs.filter((d) => !(d.resolution_notes || '').includes('[SANEAMENTO M7')).length,
    `(autodecididas totais, preservadas: ${depois.divs.length})`);
  if (auditIds.length) console.log('\nIDs de auditoria criados:', auditIds);
  await sequelize.close();
}

main().catch(async (e) => { console.error(e); await sequelize.close().catch(() => {}); process.exit(1); });
