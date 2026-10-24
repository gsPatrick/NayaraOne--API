'use strict';

/**
 * Verificação pós-restore de Estoque / Compras / Seguros / Patrimônio (Marco 7, DoD "restore
 * verdes"). Complementa verifyRestoreConstructionData.js (Obras) e
 * verifyRestoreFinanceLegalData.js (Financeiro/Jurídico), que não olhavam os schemas
 * `inventory` e `procurement`.
 *
 * Três blocos de checagem:
 *   A. INVARIANTES no banco restaurado (e na origem, para comparar):
 *      - saldo de cada item/local (inventory.stock_balances) = soma dos movimentos do ledger
 *        (entradas no destino − saídas da origem), sem saldo órfão e sem saldo negativo;
 *      - chave de idempotência de movimento/recebimento sem duplicidade;
 *      - quantidade recebida de cada item de pedido = soma dos itens de recebimento;
 *      - todo recebimento CONFIRMED aponta para um recibo de estoque COMPLETED e para um payable
 *        existente (finance.financial_entries, DEBIT/PAYABLE) com o valor da NF (ou o esperado);
 *      - toda divergência aponta para um item de recebimento existente;
 *      - apólice ACTIVE: soma das parcelas = prêmio, cada parcela com seu lançamento financeiro
 *        do mesmo valor;
 *      - ativo com local/item apontando para registros existentes.
 *   B. ORIGEM × DESTINO: para cada uma das tabelas dos schemas inventory/procurement, mesma
 *      contagem de linhas e mesmo hash SHA-256 do conteúdo (linhas ordenadas por id, JSON de
 *      todas as colunas) — prova que o restore não perdeu nem alterou nenhum campo.
 *   C. RLS no destino (opcional, --target-app-url com a role de runtime): sem contexto de tenant
 *      a role de runtime não enxerga nenhum saldo; com o SET LOCAL do tenant enxerga os mesmos
 *      saldos que a origem.
 *
 * Uso:
 *   node scripts/verifyRestoreInventoryProcurementData.js --source-url <url> --target-url <url>
 *        [--target-app-url <url-role-runtime>] [--fixtures <fixtures.json>] [--report <json>]
 *   As URLs de origem/destino precisam de uma credencial com BYPASSRLS (a de DDL/migração), como
 *   o pg_dump; a de runtime entra só no bloco C.
 */

const fs = require('fs');
const crypto = require('crypto');
const { Client } = require('pg');

function parseArgs(argv) {
  const out = {};
  const map = { '--source-url': 'sourceUrl', '--target-url': 'targetUrl', '--target-app-url': 'targetAppUrl', '--fixtures': 'fixtures', '--report': 'report' };
  for (let i = 0; i < argv.length; i += 1) {
    if (map[argv[i]] && argv[i + 1]) { out[map[argv[i]]] = argv[i + 1]; i += 1; }
  }
  return out;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function connect(url) {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

const one = async (c, sql, params) => (await c.query(sql, params)).rows[0];

// Saldo derivado do ledger × saldo gravado, por (empresa, item, local).
const LEDGER_VS_BALANCE_SQL = `
  WITH flows AS (
    SELECT company_id, inventory_item_id, destination_location_id AS location_id, quantity AS q
      FROM inventory.inventory_movements WHERE destination_location_id IS NOT NULL
    UNION ALL
    SELECT company_id, inventory_item_id, source_location_id, -quantity
      FROM inventory.inventory_movements WHERE source_location_id IS NOT NULL
  ), ledger AS (
    SELECT company_id, inventory_item_id, location_id, SUM(q) AS ledger_qty FROM flows GROUP BY 1, 2, 3
  )
  SELECT COUNT(*) FILTER (WHERE b.id IS NULL AND l.ledger_qty <> 0) AS ledger_sem_saldo,
         COUNT(*) FILTER (WHERE l.inventory_item_id IS NULL AND b.quantity_on_hand <> 0) AS saldo_sem_ledger,
         COUNT(*) FILTER (WHERE b.id IS NOT NULL AND l.inventory_item_id IS NOT NULL AND b.quantity_on_hand <> l.ledger_qty) AS divergentes,
         COUNT(*) FILTER (WHERE b.id IS NOT NULL) AS saldos,
         COALESCE(SUM(b.quantity_on_hand), 0)::text AS soma_saldos
    FROM ledger l
    FULL OUTER JOIN inventory.stock_balances b
      ON b.company_id = l.company_id AND b.inventory_item_id = l.inventory_item_id AND b.location_id = l.location_id`;

async function invariants(c, label) {
  console.log(`\n[A] Invariantes — ${label}`);
  const lb = await one(c, LEDGER_VS_BALANCE_SQL);
  check(`${label}: saldo por item/local = soma dos movimentos do ledger`, Number(lb.divergentes) === 0 && Number(lb.ledger_sem_saldo) === 0 && Number(lb.saldo_sem_ledger) === 0,
    `${lb.saldos} saldos (soma ${lb.soma_saldos}); divergentes ${lb.divergentes}, ledger sem saldo ${lb.ledger_sem_saldo}, saldo sem ledger ${lb.saldo_sem_ledger}`);
  const neg = await one(c, 'SELECT COUNT(*) AS n FROM inventory.stock_balances WHERE quantity_on_hand < 0');
  check(`${label}: nenhum saldo negativo`, Number(neg.n) === 0, `${neg.n} negativo(s)`);
  const dupMov = await one(c, 'SELECT COUNT(*) AS n FROM (SELECT company_id, idempotency_key FROM inventory.inventory_movements WHERE idempotency_key IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1) d');
  const dupGr = await one(c, 'SELECT COUNT(*) AS n FROM (SELECT company_id, idempotency_key FROM procurement.goods_receipts WHERE idempotency_key IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1) d');
  const dupNf = await one(c, 'SELECT COUNT(*) AS n FROM (SELECT company_id, invoice_fingerprint FROM procurement.goods_receipts WHERE invoice_fingerprint IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1) d');
  check(`${label}: sem duplicidade (idempotência de movimento/recebimento, NF por empresa)`, Number(dupMov.n) + Number(dupGr.n) + Number(dupNf.n) === 0, `movimentos ${dupMov.n}, recebimentos ${dupGr.n}, NF ${dupNf.n}`);

  const poq = await one(c, `
    SELECT COUNT(*) AS itens,
           COUNT(*) FILTER (WHERE poi.received_quantity <> COALESCE(g.soma, 0)) AS divergentes
      FROM procurement.purchase_order_items poi
      LEFT JOIN (SELECT purchase_order_item_id, SUM(received_quantity) AS soma FROM procurement.goods_receipt_items GROUP BY 1) g
        ON g.purchase_order_item_id = poi.id`);
  check(`${label}: recebido por item de pedido = soma dos itens de recebimento`, Number(poq.divergentes) === 0, `${poq.itens} itens de pedido, ${poq.divergentes} divergente(s)`);

  const gr = await one(c, `
    SELECT COUNT(*) AS confirmados,
           COUNT(*) FILTER (WHERE gr.inventory_receipt_id IS NOT NULL AND (r.id IS NULL OR r.status <> 'COMPLETED')) AS recibo_estoque_invalido,
           COUNT(*) FILTER (WHERE gr.financial_entry_id IS NOT NULL AND fe.id IS NULL) AS payable_ausente,
           COUNT(*) FILTER (WHERE fe.id IS NOT NULL AND (fe.nature <> 'PAYABLE' OR fe.entry_type <> 'DEBIT')) AS payable_tipo_errado,
           COUNT(*) FILTER (WHERE fe.id IS NOT NULL AND gr.invoice_total_amount IS NOT NULL AND fe.amount <> gr.invoice_total_amount) AS payable_valor_divergente,
           COUNT(*) FILTER (WHERE gr.financial_entry_id IS NOT NULL) AS com_payable
      FROM procurement.goods_receipts gr
      LEFT JOIN inventory.receipts r ON r.id = gr.inventory_receipt_id
      LEFT JOIN finance.financial_entries fe ON fe.id = gr.financial_entry_id
     WHERE gr.status = 'CONFIRMED'`);
  check(`${label}: recebimentos confirmados com recibo de estoque COMPLETED e payable íntegro`,
    Number(gr.recibo_estoque_invalido) + Number(gr.payable_ausente) + Number(gr.payable_tipo_errado) + Number(gr.payable_valor_divergente) === 0,
    `${gr.confirmados} confirmados, ${gr.com_payable} com payable; recibo inválido ${gr.recibo_estoque_invalido}, payable ausente ${gr.payable_ausente}, tipo errado ${gr.payable_tipo_errado}, valor divergente ${gr.payable_valor_divergente}`);

  const disc = await one(c, `
    SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE gri.id IS NULL) AS orfas,
           COUNT(*) FILTER (WHERE d.status = 'OPEN') AS abertas
      FROM procurement.receipt_discrepancies d LEFT JOIN procurement.goods_receipt_items gri ON gri.id = d.goods_receipt_item_id`);
  check(`${label}: divergências ligadas a itens de recebimento existentes`, Number(disc.orfas) === 0, `${disc.n} divergência(s), ${disc.abertas} aberta(s), ${disc.orfas} órfã(s)`);

  const ins = await one(c, `
    WITH p AS (
      SELECT pol.id, pol.premium_amount, COALESCE(SUM(i.amount), 0) AS soma, COUNT(i.id) AS parcelas,
             COUNT(i.id) FILTER (WHERE fe.id IS NULL OR fe.amount <> i.amount) AS parcela_sem_lancamento
        FROM procurement.insurance_policies pol
        LEFT JOIN procurement.insurance_installments i ON i.policy_id = pol.id
        LEFT JOIN finance.financial_entries fe ON fe.id = i.financial_entry_id
       WHERE pol.status = 'ACTIVE'
       GROUP BY pol.id, pol.premium_amount)
    SELECT COUNT(*) AS apolices, COALESCE(SUM(parcelas), 0) AS parcelas,
           COUNT(*) FILTER (WHERE parcelas > 0 AND soma <> premium_amount) AS soma_divergente,
           COALESCE(SUM(parcela_sem_lancamento), 0) AS parcela_sem_lancamento
      FROM p`);
  check(`${label}: apólices ativas — soma das parcelas = prêmio, cada parcela com lançamento do mesmo valor`,
    Number(ins.soma_divergente) === 0 && Number(ins.parcela_sem_lancamento) === 0,
    `${ins.apolices} apólice(s), ${ins.parcelas} parcela(s); soma divergente ${ins.soma_divergente}, parcela sem lançamento ${ins.parcela_sem_lancamento}`);

  const ast = await one(c, `
    SELECT COUNT(*) AS n,
           COUNT(*) FILTER (WHERE a.current_location_id IS NOT NULL AND l.id IS NULL) AS local_orfao,
           COUNT(*) FILTER (WHERE a.inventory_item_id IS NOT NULL AND it.id IS NULL) AS item_orfao,
           COALESCE(SUM(a.acquisition_value), 0)::text AS valor
      FROM inventory.assets a
      LEFT JOIN inventory.locations l ON l.id = a.current_location_id
      LEFT JOIN inventory.inventory_items it ON it.id = a.inventory_item_id
     WHERE a.deleted_at IS NULL`);
  check(`${label}: ativos de patrimônio com local/item existentes`, Number(ast.local_orfao) + Number(ast.item_orfao) === 0, `${ast.n} ativo(s), valor de aquisição total ${ast.valor}`);
  return { soma_saldos: lb.soma_saldos, saldos: lb.saldos };
}

async function tableFingerprints(c) {
  const { rows: tables } = await c.query(`
    SELECT table_schema, table_name FROM information_schema.tables
     WHERE table_schema IN ('inventory', 'procurement') AND table_type = 'BASE TABLE' ORDER BY 1, 2`);
  const out = {};
  for (const { table_schema: s, table_name: t } of tables) {
    const { rows } = await c.query(`SELECT row_to_json(x)::text AS j FROM "${s}"."${t}" x ORDER BY x.id`);
    const h = crypto.createHash('sha256');
    for (const r of rows) h.update(`${r.j}\n`);
    out[`${s}.${t}`] = { rows: rows.length, sha256: h.digest('hex') };
  }
  return out;
}

async function rlsCheck(appUrl, tenant, expectedBalances) {
  console.log('\n[C] RLS no destino com a role de runtime');
  const c = await connect(appUrl);
  try {
    const role = await one(c, 'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    check('role de runtime sem SUPERUSER/BYPASSRLS', !role.rolsuper && !role.rolbypassrls, `superuser=${role.rolsuper} bypassrls=${role.rolbypassrls}`);
    await c.query('BEGIN');
    const blind = await one(c, 'SELECT COUNT(*) AS n FROM inventory.stock_balances');
    await c.query('ROLLBACK');
    check('sem contexto de tenant a role de runtime não vê nenhum saldo', Number(blind.n) === 0, `${blind.n} linha(s) visíveis`);
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.group_id', $1, true), set_config('app.company_id', $2, true)", [tenant.groupId, tenant.companyId]);
    const seen = await one(c, 'SELECT COUNT(*) AS n FROM inventory.stock_balances');
    await c.query('ROLLBACK');
    check('com o SET LOCAL do tenant vê os saldos restaurados', Number(seen.n) === Number(expectedBalances), `${seen.n} de ${expectedBalances}`);
  } finally {
    await c.end();
  }
}

async function fixtureChecks(c, fixtures) {
  console.log('\n[D] Fixtures do drill no destino');
  const po = await one(c, 'SELECT status FROM procurement.purchase_orders WHERE id = $1', [fixtures.purchaseOrderId]);
  check('pedido de compra restaurado', po && po.status === 'OPEN', po ? `status ${po.status}` : 'ausente');
  const grs = await one(c, "SELECT COUNT(*) AS n, COUNT(financial_entry_id) AS pay FROM procurement.goods_receipts WHERE id = ANY($1::uuid[]) AND status = 'CONFIRMED'", [fixtures.goodsReceiptIds]);
  check('2 recebimentos confirmados com payable', Number(grs.n) === 2 && Number(grs.pay) === 2, `${grs.n} recebimentos, ${grs.pay} payables`);
  const d = await c.query('SELECT discrepancy_type FROM procurement.receipt_discrepancies d JOIN procurement.goods_receipt_items i ON i.id = d.goods_receipt_item_id WHERE i.goods_receipt_id = ANY($1::uuid[]) ORDER BY 1', [fixtures.goodsReceiptIds]);
  const types = d.rows.map((r) => r.discrepancy_type);
  check('divergências do recebimento restauradas', JSON.stringify(types) === JSON.stringify(fixtures.discrepancyTypes), types.join(', '));
  const req = await one(c, 'SELECT status FROM inventory.requisitions WHERE id = $1', [fixtures.requisitionId]);
  check('requisição de material restaurada', req && req.status === 'ISSUED', req ? `status ${req.status}` : 'ausente');
  const pol = await one(c, 'SELECT p.status, COUNT(i.id) AS parcelas FROM procurement.insurance_policies p LEFT JOIN procurement.insurance_installments i ON i.policy_id = p.id WHERE p.id = $1 GROUP BY p.status', [fixtures.policyId]);
  check('apólice e parcelas restauradas', pol && pol.status === 'ACTIVE' && Number(pol.parcelas) > 0, pol ? `${pol.status}, ${pol.parcelas} parcela(s)` : 'ausente');
  const as = await one(c, 'SELECT COUNT(*) AS n FROM inventory.assets WHERE id = ANY($1::uuid[])', [fixtures.assetIds]);
  check('ativos de patrimônio restaurados', Number(as.n) === fixtures.assetIds.length, `${as.n}/${fixtures.assetIds.length}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.targetUrl) {
    console.error('Uso: --target-url <url> [--source-url <url>] [--target-app-url <url>] [--fixtures <json>] [--report <json>]');
    process.exit(2);
  }
  const target = await connect(args.targetUrl);
  const source = args.sourceUrl ? await connect(args.sourceUrl) : null;
  const fixtures = args.fixtures ? JSON.parse(fs.readFileSync(args.fixtures, 'utf8')) : null;
  let tables = {};
  try {
    if (source) await invariants(source, 'origem');
    await invariants(target, 'destino');

    if (source) {
      console.log('\n[B] Origem × destino (contagem + SHA-256 do conteúdo, tabelas inventory.* e procurement.*)');
      const [a, b] = await Promise.all([tableFingerprints(source), tableFingerprints(target)]);
      tables = b;
      const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      let totalRows = 0;
      const diff = [];
      for (const n of names) {
        totalRows += (b[n] && b[n].rows) || 0;
        if (!a[n] || !b[n] || a[n].rows !== b[n].rows || a[n].sha256 !== b[n].sha256) diff.push(n);
      }
      check(`${names.length} tabelas idênticas na origem e no destino`, diff.length === 0, diff.length ? `diferentes: ${diff.join(', ')}` : `${totalRows} linhas no total`);
    }
    if (args.targetAppUrl && fixtures) await rlsCheck(args.targetAppUrl, fixtures.tenant, (await one(target, 'SELECT COUNT(*) AS n FROM inventory.stock_balances WHERE company_id = $1', [fixtures.tenant.companyId])).n);
    if (fixtures) await fixtureChecks(target, fixtures);
  } finally {
    await target.end();
    if (source) await source.end();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nResultado: ${results.length - failed}/${results.length} checagens OK${failed ? ` — ${failed} FALHA(S)` : ''}.`);
  if (args.report) fs.writeFileSync(args.report, JSON.stringify({ checks: results, tables }, null, 2));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`verifyRestoreInventoryProcurementData falhou: ${err.message}`);
  process.exit(1);
});
