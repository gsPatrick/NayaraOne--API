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
 *   Evidência complementar (28/10/2026): [E] tabelas de empréstimo, manutenção, perda, contagem
 *   (+ itens e propostas de ajuste) e sinistro (+ eventos), com contagem mínima > 0, invariantes
 *   próprios e anexos (--target-uploads/--source-uploads, --storage-report) abertos e conferidos.
 *   As URLs de origem/destino precisam de uma credencial com BYPASSRLS (a de DDL/migração), como
 *   o pg_dump; a de runtime entra só no bloco C.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

function parseArgs(argv) {
  const out = {};
  const map = { '--source-url': 'sourceUrl', '--target-url': 'targetUrl', '--target-app-url': 'targetAppUrl', '--fixtures': 'fixtures', '--report': 'report', '--source-uploads': 'sourceUploads', '--target-uploads': 'targetUploads', '--storage-report': 'storageReport' };
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
      LEFT JOIN (
        -- O excedente de um recebimento (OVER_RECEIPT) fica fora do item do pedido até a divergência ser ACEITA (correção B1).
        SELECT gri.purchase_order_item_id,
               SUM(CASE WHEN o.id IS NULL OR o.status = 'ACCEPTED' THEN gri.received_quantity ELSE GREATEST(o.expected_value, 0) END) AS soma
          FROM procurement.goods_receipt_items gri
          LEFT JOIN procurement.receipt_discrepancies o ON o.goods_receipt_item_id = gri.id AND o.discrepancy_type = 'OVER_RECEIPT'
         GROUP BY 1) g
        ON g.purchase_order_item_id = poi.id`);
  check(`${label}: recebido por item de pedido = soma dos itens de recebimento (excedente só depois de aceito)`, Number(poq.divergentes) === 0, `${poq.itens} itens de pedido, ${poq.divergentes} divergente(s)`);

  const gr = await one(c, `
    SELECT COUNT(*) AS confirmados,
           COUNT(*) FILTER (WHERE gr.inventory_receipt_id IS NOT NULL AND (r.id IS NULL OR r.status <> 'COMPLETED')) AS recibo_estoque_invalido,
           COUNT(*) FILTER (WHERE gr.financial_entry_id IS NOT NULL AND fe.id IS NULL) AS payable_ausente,
           COUNT(*) FILTER (WHERE fe.id IS NOT NULL AND (fe.nature <> 'PAYABLE' OR fe.entry_type <> 'DEBIT')) AS payable_tipo_errado,
           COUNT(*) FILTER (WHERE fe.id IS NOT NULL AND ABS(fe.amount - GREATEST(ROUND(COALESCE(t.base, 0) + COALESCE(t.aceito, 0)
               + CASE WHEN COALESCE(pm.aceita, false) AND gr.invoice_total_amount IS NOT NULL THEN gr.invoice_total_amount - COALESCE(t.cheio, 0) ELSE 0 END, 2), 0)) >= 0.005) AS payable_valor_divergente,
           COUNT(*) FILTER (WHERE gr.financial_entry_id IS NOT NULL) AS com_payable
      FROM procurement.goods_receipts gr
      LEFT JOIN inventory.receipts r ON r.id = gr.inventory_receipt_id
      LEFT JOIN finance.financial_entries fe ON fe.id = gr.financial_entry_id
      -- Valor devido do payable, pela mesma regra do serviço de Compras: o excedente só entra se aceito e a diferença de
      -- preço só entra se a divergência de preço foi aceita; antes disso o payable fica no valor capado ao saldo do pedido.
      LEFT JOIN (
        SELECT gri.goods_receipt_id AS gr_id,
               SUM(GREATEST(COALESCE(o.expected_value, gri.received_quantity), 0) * poi.unit_price) AS base,
               SUM(CASE WHEN o.status = 'ACCEPTED' THEN (gri.received_quantity - GREATEST(o.expected_value, 0)) * poi.unit_price ELSE 0 END) AS aceito,
               SUM(gri.received_quantity * poi.unit_price) AS cheio
          FROM procurement.goods_receipt_items gri
          JOIN procurement.purchase_order_items poi ON poi.id = gri.purchase_order_item_id
          LEFT JOIN procurement.receipt_discrepancies o ON o.goods_receipt_item_id = gri.id AND o.discrepancy_type = 'OVER_RECEIPT'
         GROUP BY 1) t ON t.gr_id = gr.id
      LEFT JOIN (
        SELECT gri.goods_receipt_id AS gr_id, bool_or(d.status = 'ACCEPTED') AS aceita
          FROM procurement.receipt_discrepancies d
          JOIN procurement.goods_receipt_items gri ON gri.id = d.goods_receipt_item_id
         WHERE d.discrepancy_type = 'PRICE_MISMATCH'
         GROUP BY 1) pm ON pm.gr_id = gr.id
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
  await complementInvariants(c, label);
  return { soma_saldos: lb.soma_saldos, saldos: lb.saldos };
}

// Evidência complementar: empréstimos, manutenção, perdas, contagens, propostas de ajuste e sinistros.
async function complementInvariants(c, label) {
  const loans = await one(c, `
    SELECT COUNT(*) AS n,
           COUNT(*) FILTER (WHERE l.status IN ('OPEN', 'OVERDUE')) AS abertos,
           COUNT(*) FILTER (WHERE l.status IN ('OPEN', 'OVERDUE') AND (l.person_user_id IS NULL OR l.due_at IS NULL OR l.destination_location_id IS NULL OR u.id IS NULL)) AS aberto_sem_responsavel_ou_prazo,
           COUNT(*) FILTER (WHERE l.status IN ('OPEN', 'OVERDUE') AND (a.id IS NULL OR a.status <> 'LOANED')) AS aberto_com_ativo_fora_de_emprestimo,
           COUNT(*) FILTER (WHERE l.status = 'RETURNED' AND (l.returned_at IS NULL OR l.condition_code IS NULL)) AS devolvido_sem_data_ou_condicao,
           COUNT(*) FILTER (WHERE a.id IS NULL) AS sem_ativo
      FROM inventory.tool_loans l
      LEFT JOIN inventory.assets a ON a.id = l.asset_id
      LEFT JOIN core.users u ON u.id = l.person_user_id`);
  check(`${label}: empréstimos — aberto tem responsável, destino e prazo e o ativo está emprestado; devolvido tem data e condição`,
    Number(loans.n) > 0 && Number(loans.abertos) > 0 && Number(loans.aberto_sem_responsavel_ou_prazo) + Number(loans.aberto_com_ativo_fora_de_emprestimo) + Number(loans.devolvido_sem_data_ou_condicao) + Number(loans.sem_ativo) === 0,
    `${loans.n} empréstimo(s), ${loans.abertos} aberto(s); sem responsável/prazo ${loans.aberto_sem_responsavel_ou_prazo}, ativo fora de empréstimo ${loans.aberto_com_ativo_fora_de_emprestimo}, devolvido incompleto ${loans.devolvido_sem_data_ou_condicao}, sem ativo ${loans.sem_ativo}`);

  const mo = await one(c, `
    SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE m.status = 'OPEN') AS abertas,
           COUNT(*) FILTER (WHERE a.id IS NULL) AS sem_ativo,
           COUNT(*) FILTER (WHERE m.status = 'OPEN' AND a.status <> 'MAINTENANCE') AS aberta_com_ativo_fora_de_manutencao,
           COUNT(*) FILTER (WHERE m.source_tool_loan_id IS NOT NULL AND (l.id IS NULL OR l.asset_id <> m.asset_id OR l.condition_code <> 'DAMAGED')) AS origem_invalida
      FROM inventory.maintenance_orders m
      LEFT JOIN inventory.assets a ON a.id = m.asset_id
      LEFT JOIN inventory.tool_loans l ON l.id = m.source_tool_loan_id`);
  check(`${label}: ordens de manutenção — ligadas a ativo existente; aberta mantém o ativo em manutenção; origem = devolução danificada do mesmo ativo`,
    Number(mo.n) > 0 && Number(mo.abertas) > 0 && Number(mo.sem_ativo) + Number(mo.aberta_com_ativo_fora_de_manutencao) + Number(mo.origem_invalida) === 0,
    `${mo.n} ordem(ns), ${mo.abertas} aberta(s); sem ativo ${mo.sem_ativo}, ativo fora de manutenção ${mo.aberta_com_ativo_fora_de_manutencao}, origem inválida ${mo.origem_invalida}`);

  const loss = await one(c, `
    SELECT COUNT(*) AS n,
           COUNT(*) FILTER (WHERE lc.status IN ('OPEN', 'PENDING_APPROVAL')) AS em_analise,
           COUNT(*) FILTER (WHERE lc.status = 'APPROVED') AS decididas,
           COUNT(*) FILTER (WHERE lc.status IN ('OPEN', 'PENDING_APPROVAL') AND (lc.resulting_movement_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM inventory.inventory_movements m WHERE m.source_type = 'LOSS_CASE' AND m.source_id = lc.id))) AS em_analise_que_baixou_saldo,
           COUNT(*) FILTER (WHERE lc.status = 'APPROVED' AND lc.inventory_item_id IS NOT NULL AND (mv.id IS NULL OR mv.movement_type <> 'LOSS' OR mv.quantity <> lc.quantity)) AS aprovada_sem_movimento_correto,
           COUNT(*) FILTER (WHERE cardinality(lc.evidence_file_ids) = 0
               OR EXISTS (SELECT 1 FROM unnest(lc.evidence_file_ids) e WHERE NOT EXISTS (SELECT 1 FROM people.files f WHERE f.id = e))) AS evidencia_ausente
      FROM inventory.loss_cases lc
      LEFT JOIN inventory.inventory_movements mv ON mv.id = lc.resulting_movement_id`);
  check(`${label}: perdas — em análise não baixou saldo; aprovada tem o movimento LOSS da mesma quantidade; toda perda tem arquivo de evidência existente`,
    Number(loss.em_analise) > 0 && Number(loss.decididas) > 0 && Number(loss.em_analise_que_baixou_saldo) + Number(loss.aprovada_sem_movimento_correto) + Number(loss.evidencia_ausente) === 0,
    `${loss.n} caso(s): ${loss.em_analise} em análise, ${loss.decididas} aprovado(s); em análise que baixou saldo ${loss.em_analise_que_baixou_saldo}, aprovada sem movimento correto ${loss.aprovada_sem_movimento_correto}, evidência ausente ${loss.evidencia_ausente}`);

  const cnt = await one(c, `
    SELECT (SELECT COUNT(*) FROM inventory.counts) AS contagens,
           (SELECT COUNT(*) FROM inventory.counts WHERE status = 'COMPLETED') AS fechadas,
           (SELECT COUNT(*) FROM inventory.counts WHERE status = 'OPEN') AS abertas,
           (SELECT COUNT(*) FROM inventory.count_items) AS itens,
           (SELECT COUNT(*) FROM inventory.count_items ci JOIN inventory.counts k ON k.id = ci.count_id
             WHERE k.status = 'COMPLETED' AND (ci.expected_quantity IS NULL OR ci.divergence IS NULL OR ci.divergence <> ci.counted_quantity - ci.expected_quantity)) AS itens_fechados_inconsistentes,
           (SELECT COUNT(*) FROM inventory.count_items ci WHERE ci.divergence <> 0) AS itens_com_divergencia,
           (SELECT COUNT(*) FROM inventory.counts k WHERE k.status = 'COMPLETED' AND EXISTS (
              SELECT 1 FROM inventory.inventory_movements m WHERE m.source_type = 'COUNT' AND m.source_id = k.id
                AND NOT EXISTS (SELECT 1 FROM inventory.count_items ci WHERE ci.adjustment_movement_id = m.id))) AS fechada_que_alterou_saldo_sem_ajuste_aprovado,
           (SELECT COUNT(*) FROM inventory.count_items ci JOIN inventory.counts k ON k.id = ci.count_id
             WHERE k.status = 'OPEN' AND ci.adjustment_movement_id IS NOT NULL) AS aberta_com_ajuste`);
  check(`${label}: contagens — fechada tem esperado/divergência coerentes e não alterou saldo sem ajuste aprovado; aberta não tem ajuste`,
    Number(cnt.fechadas) > 0 && Number(cnt.abertas) > 0 && Number(cnt.itens_com_divergencia) > 0 && Number(cnt.itens_fechados_inconsistentes) + Number(cnt.fechada_que_alterou_saldo_sem_ajuste_aprovado) + Number(cnt.aberta_com_ajuste) === 0,
    `${cnt.contagens} contagem(ns) (${cnt.fechadas} fechada(s), ${cnt.abertas} aberta(s)), ${cnt.itens} item(ns), ${cnt.itens_com_divergencia} com divergência; incoerentes ${cnt.itens_fechados_inconsistentes}, saldo alterado sem ajuste ${cnt.fechada_que_alterou_saldo_sem_ajuste_aprovado}, aberta com ajuste ${cnt.aberta_com_ajuste}`);

  const prop = await one(c, `
    SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'PENDING') AS pendentes,
           COUNT(*) FILTER (WHERE status = 'PENDING' AND (resulting_movement_id IS NOT NULL OR EXISTS (SELECT 1 FROM inventory.inventory_movements m WHERE m.source_type = 'ADJUSTMENT_PROPOSAL' AND m.source_id = p.id))) AS pendente_que_moveu_saldo,
           COUNT(*) FILTER (WHERE status = 'APPROVED' AND resulting_movement_id IS NULL) AS aprovada_sem_movimento
      FROM inventory.adjustment_proposals p`);
  check(`${label}: propostas de ajuste — pendente não moveu saldo; aprovada tem o movimento`,
    Number(prop.pendentes) > 0 && Number(prop.pendente_que_moveu_saldo) + Number(prop.aprovada_sem_movimento) === 0,
    `${prop.n} proposta(s), ${prop.pendentes} pendente(s); pendente que moveu saldo ${prop.pendente_que_moveu_saldo}, aprovada sem movimento ${prop.aprovada_sem_movimento}`);

  const cl = await one(c, `
    SELECT COUNT(*) AS n,
           COUNT(*) FILTER (WHERE k.status = 'OPEN') AS abertos,
           COUNT(*) FILTER (WHERE k.status = 'SUBMITTED') AS submetidos,
           COUNT(*) FILTER (WHERE k.status = 'SETTLED') AS liquidados,
           COUNT(*) FILTER (WHERE k.status = 'SETTLED' AND (fe.id IS NULL OR fe.amount <> k.settled_amount OR fe.entry_type <> 'CREDIT' OR fe.nature <> 'RECEIVABLE')) AS liquidado_sem_lancamento_correto,
           COUNT(*) FILTER (WHERE k.status <> 'SETTLED' AND k.financial_entry_id IS NOT NULL) AS lancamento_sem_liquidar,
           COUNT(*) FILTER (WHERE k.status IN ('SUBMITTED', 'SETTLED') AND NOT EXISTS (SELECT 1 FROM procurement.insurance_provider_submissions s WHERE s.claim_id = k.id)) AS submetido_sem_envio,
           COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM procurement.insurance_claim_events e WHERE e.claim_id = k.id AND e.event_type = 'OPENED')) AS sem_evento_abertura,
           COUNT(*) FILTER (WHERE k.status = 'SETTLED' AND NOT EXISTS (SELECT 1 FROM procurement.insurance_claim_events e WHERE e.claim_id = k.id AND e.event_type = 'SETTLED')) AS liquidado_sem_evento
      FROM procurement.insurance_claims k
      LEFT JOIN finance.financial_entries fe ON fe.id = k.financial_entry_id`);
  check(`${label}: sinistros — liquidado tem lançamento no Financeiro do mesmo valor (a receber); submetido tem envio; todo sinistro tem evento de abertura`,
    Number(cl.abertos) > 0 && Number(cl.submetidos) > 0 && Number(cl.liquidados) > 0
      && Number(cl.liquidado_sem_lancamento_correto) + Number(cl.lancamento_sem_liquidar) + Number(cl.submetido_sem_envio) + Number(cl.sem_evento_abertura) + Number(cl.liquidado_sem_evento) === 0,
    `${cl.n} sinistro(s): ${cl.abertos} aberto(s), ${cl.submetidos} submetido(s), ${cl.liquidados} liquidado(s); liquidado sem lançamento correto ${cl.liquidado_sem_lancamento_correto}, lançamento sem liquidar ${cl.lancamento_sem_liquidar}, submetido sem envio ${cl.submetido_sem_envio}, sem evento de abertura ${cl.sem_evento_abertura}, liquidado sem evento ${cl.liquidado_sem_evento}`);
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

// Tabelas da evidência complementar: precisam ter linhas (a amostra anterior as tinha vazias) e ser
// idênticas na origem e no destino. Algumas são recortes (lançamentos do sinistro, arquivos anexados).
const COMPLEMENT_TABLES = [
  ['inventory.tool_loans', 'SELECT * FROM inventory.tool_loans'],
  ['inventory.maintenance_orders', 'SELECT * FROM inventory.maintenance_orders'],
  ['inventory.loss_cases', 'SELECT * FROM inventory.loss_cases'],
  ['inventory.counts', 'SELECT * FROM inventory.counts'],
  ['inventory.count_items', 'SELECT * FROM inventory.count_items'],
  ['inventory.adjustment_proposals', 'SELECT * FROM inventory.adjustment_proposals'],
  ['procurement.insurance_claims', 'SELECT * FROM procurement.insurance_claims'],
  ['procurement.insurance_claim_events', 'SELECT * FROM procurement.insurance_claim_events'],
  ['procurement.insurance_provider_submissions (sinistros)', "SELECT * FROM procurement.insurance_provider_submissions WHERE claim_id IS NOT NULL"],
  ['finance.financial_entries (indenizações de sinistro)', 'SELECT fe.* FROM finance.financial_entries fe JOIN procurement.insurance_claims k ON k.financial_entry_id = fe.id'],
  ['procurement.supplier_qualifications', 'SELECT * FROM procurement.supplier_qualifications'],
  ['people.files (anexos do Marco 7)', 'SELECT f.* FROM people.files f WHERE f.id IN (SELECT id FROM ({ATTACHMENTS}) a)'],
  ['people.file_links (anexos do Marco 7)', "SELECT * FROM people.file_links WHERE related_entity_type IN ('InsuranceClaim', 'InsurancePolicy')"],
];

// Arquivos ligados aos registros do Marco 7: evidência de perda, documento de qualificação de
// fornecedor, evidência de movimento/proposta e vínculos de apólice/sinistro.
const ATTACHMENT_IDS_SQL = `
  SELECT DISTINCT id FROM (
    SELECT unnest(evidence_file_ids) AS id FROM inventory.loss_cases
    UNION ALL SELECT (jsonb_array_elements_text(document_file_ids))::uuid FROM procurement.supplier_qualifications
    UNION ALL SELECT evidence_file_id FROM inventory.inventory_movements WHERE evidence_file_id IS NOT NULL
    UNION ALL SELECT evidence_file_id FROM inventory.adjustment_proposals WHERE evidence_file_id IS NOT NULL
    UNION ALL SELECT file_id FROM people.file_links WHERE related_entity_type IN ('InsuranceClaim', 'InsurancePolicy')
  ) x WHERE id IS NOT NULL`;

async function complementFingerprint(c, sql) {
  const { rows } = await c.query(`SELECT row_to_json(x)::text AS j FROM (${sql.replace('{ATTACHMENTS}', ATTACHMENT_IDS_SQL)}) x ORDER BY j`);
  const h = crypto.createHash('sha256');
  for (const r of rows) h.update(`${r.j}\n`);
  return { rows: rows.length, sha256: h.digest('hex') };
}

async function complementComparison(source, target) {
  console.log('\n[E] Evidência complementar — origem × destino (contagem > 0 e SHA-256 do conteúdo)');
  const out = {};
  for (const [name, sql] of COMPLEMENT_TABLES) {
    const [a, b] = [await complementFingerprint(source, sql), await complementFingerprint(target, sql)];
    out[name] = { origem: a, destino: b };
    check(`${name}: ${b.rows} linha(s) na origem e no destino, conteúdo idêntico`, a.rows > 0 && a.rows === b.rows && a.sha256 === b.sha256,
      `origem ${a.rows} (${a.sha256.slice(0, 12)}…), destino ${b.rows} (${b.sha256.slice(0, 12)}…)`);
  }
  return out;
}

// Abre cada anexo no storage RESTAURADO (decifra com a chave) e confere SHA-256 e tamanho contra o
// cadastro (mesma lógica de scripts/restoreDrill/storageRestoreDrill.js).
function openRestored(uploadsDir, storageKey, keyOverride) {
  const { decryptFileBuffer } = require('../src/utils/fileCrypto');
  const previous = process.env.FILES_ENCRYPTION_KEY;
  try {
    if (keyOverride === null) delete process.env.FILES_ENCRYPTION_KEY;
    else if (keyOverride) process.env.FILES_ENCRYPTION_KEY = keyOverride;
    const buf = decryptFileBuffer(fs.readFileSync(path.join(uploadsDir, storageKey)));
    return { ok: true, sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
  } catch (e) {
    return { ok: false, codigo: e.code || e.name, mensagem: String(e.message).slice(0, 120) };
  } finally {
    if (previous === undefined) delete process.env.FILES_ENCRYPTION_KEY; else process.env.FILES_ENCRYPTION_KEY = previous;
  }
}

async function attachmentChecks(source, target, args, fixtures) {
  console.log('\n[F] Anexos vinculados aos registros do Marco 7 (abertos no storage restaurado)');
  const q = `SELECT f.id, f.file_name, f.mime_type, f.storage_key, f.checksum_sha256, f.size_bytes, f.encrypted_at_rest FROM people.files f WHERE f.id IN (${ATTACHMENT_IDS_SQL}) ORDER BY f.file_name, f.id`;
  const rows = (await target.query(q)).rows;
  const srcRows = (await source.query(q)).rows;
  const linksSql = `SELECT 'perda' AS vinculo, id AS registro, unnest(evidence_file_ids) AS file_id FROM inventory.loss_cases
    UNION ALL SELECT 'qualificação de fornecedor', id, (jsonb_array_elements_text(document_file_ids))::uuid FROM procurement.supplier_qualifications
    UNION ALL SELECT 'movimento (evidência)', id, evidence_file_id FROM inventory.inventory_movements WHERE evidence_file_id IS NOT NULL
    UNION ALL SELECT 'proposta de ajuste (evidência)', id, evidence_file_id FROM inventory.adjustment_proposals WHERE evidence_file_id IS NOT NULL
    UNION ALL SELECT 'sinistro/apólice (' || related_entity_type || ')', related_entity_id, file_id FROM people.file_links WHERE related_entity_type IN ('InsuranceClaim', 'InsurancePolicy')`;
  const links = (await target.query(linksSql)).rows;
  const vinculosPorArquivo = new Map();
  for (const l of links) vinculosPorArquivo.set(l.file_id, [...(vinculosPorArquivo.get(l.file_id) || []), l.vinculo]);
  const expected = new Map(((fixtures && fixtures.complement && fixtures.complement.attachments) || []).map((a) => [a.id, a]));

  const arquivos = rows.map((r) => {
    const aberto = openRestored(args.targetUploads, r.storage_key);
    const blobOrigem = fs.existsSync(path.join(args.sourceUploads || '', r.storage_key)) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(args.sourceUploads, r.storage_key))).digest('hex') : null;
    const blobDestino = fs.existsSync(path.join(args.targetUploads, r.storage_key)) ? crypto.createHash('sha256').update(fs.readFileSync(path.join(args.targetUploads, r.storage_key))).digest('hex') : null;
    const esp = expected.get(r.id);
    return {
      arquivo: r.file_name, tipo: r.mime_type, vinculos: [...new Set(vinculosPorArquivo.get(r.id) || [])],
      bytesDoCadastro: Number(r.size_bytes), bytesAbertos: aberto.bytes ?? null, abriu: aberto.ok,
      sha256Confere: aberto.ok && aberto.sha256 === r.checksum_sha256, tamanhoConfere: aberto.ok && aberto.bytes === Number(r.size_bytes),
      sha256IndependenteConfere: esp ? esp.expectedSha256 === r.checksum_sha256 && esp.expectedBytes === Number(r.size_bytes) : null,
      blobCifradoIgualOrigemDestino: blobOrigem !== null && blobOrigem === blobDestino, sha256: r.checksum_sha256, _storageKey: r.storage_key,
    };
  });
  const bons = arquivos.filter((a) => a.abriu && a.sha256Confere && a.tamanhoConfere && a.blobCifradoIgualOrigemDestino && a.sha256IndependenteConfere !== false).length;
  const tipos = new Set(arquivos.flatMap((a) => a.vinculos).map((v) => v.split(' (')[0]));
  check(`${arquivos.length} anexo(s) vinculados (${[...tipos].join(', ')}) abertos no storage restaurado, com SHA-256 e tamanho iguais ao cadastro`,
    arquivos.length >= 5 && bons === arquivos.length && ['perda', 'qualificação de fornecedor', 'sinistro/apólice'].every((t) => tipos.has(t)),
    `${bons}/${arquivos.length} conferem; vínculos: ${[...tipos].join(', ')}`);
  check('cadastro dos anexos (people.files) idêntico na origem e no destino', JSON.stringify(srcRows) === JSON.stringify(rows), `${rows.length} arquivo(s)`);
  const orfaos = links.filter((l) => !rows.some((r) => r.id === l.file_id)).length;
  check('todo vínculo de anexo aponta para um arquivo existente', orfaos === 0, `${links.length} vínculo(s), ${orfaos} órfão(s)`);

  // Provas negativas do storage: chave ausente, chave errada, blob adulterado.
  const first = arquivos[0];
  const semChave = openRestored(args.targetUploads, first._storageKey, null);
  const chaveErrada = openRestored(args.targetUploads, first._storageKey, crypto.randomBytes(32).toString('hex'));
  const blobPath = path.join(args.targetUploads, first._storageKey);
  const original = fs.readFileSync(blobPath);
  const adulterado = Buffer.from(original);
  adulterado[adulterado.length - 1] ^= 0xff;
  fs.writeFileSync(blobPath, adulterado);
  const blobAdulterado = openRestored(args.targetUploads, first._storageKey);
  fs.writeFileSync(blobPath, original);
  check('sem a chave, com chave errada e com blob adulterado o anexo NÃO abre', !semChave.ok && !chaveErrada.ok && !blobAdulterado.ok,
    `sem chave: ${semChave.codigo}; chave errada: ${chaveErrada.codigo}; adulterado: ${blobAdulterado.codigo}`);

  const resultado = {
    executadoEm: new Date().toISOString(),
    escopo: 'Anexos vinculados a perdas, qualificação de fornecedor, apólice e sinistro do Marco 7 (drill de restore em banco/storage descartáveis)',
    arquivosTestados: arquivos.map(({ _storageKey, ...rest }) => rest),
    todosAbriramEConferem: bons === arquivos.length,
    semChave: { recusou: !semChave.ok, codigo: semChave.codigo },
    chaveErrada: { recusou: !chaveErrada.ok, codigo: chaveErrada.codigo },
    blobAdulterado: { recusou: !blobAdulterado.ok, codigo: blobAdulterado.codigo },
    observacao: 'A chave FILES_ENCRYPTION_KEY não vai dentro do backup. Sem a mesma chave os arquivos restaurados não abrem.',
  };
  if (args.storageReport) fs.writeFileSync(args.storageReport, JSON.stringify(resultado, null, 2));
  return resultado;
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
  const cx = fixtures.complement;
  if (!cx) return;
  const loanRows = (await c.query('SELECT id, status, condition_code FROM inventory.tool_loans WHERE id = ANY($1::uuid[])', [Object.values(cx.toolLoans)])).rows;
  const st = (id) => (loanRows.find((r) => r.id === id) || {});
  check('empréstimos restaurados: 1 aberto, 1 devolvido OK, 1 devolvido danificado',
    st(cx.toolLoans.openId).status === 'OPEN' && st(cx.toolLoans.returnedId).status === 'RETURNED' && st(cx.toolLoans.returnedId).condition_code === 'OK' && st(cx.toolLoans.damagedId).condition_code === 'DAMAGED',
    loanRows.map((r) => `${r.status}/${r.condition_code || '-'}`).join(', '));
  const os = await one(c, 'SELECT status, source_tool_loan_id FROM inventory.maintenance_orders WHERE id = $1', [cx.maintenanceOrderId]);
  check('ordem de manutenção aberta pela devolução danificada restaurada', os && os.status === 'OPEN' && os.source_tool_loan_id === cx.toolLoans.damagedId, os ? `${os.status}, empréstimo de origem ${os.source_tool_loan_id === cx.toolLoans.damagedId ? 'confere' : 'DIFERENTE'}` : 'ausente');
  const lc = (await c.query('SELECT id, status, resulting_movement_id FROM inventory.loss_cases WHERE id = ANY($1::uuid[])', [[cx.lossCases.analysisId, cx.lossCases.decidedId]])).rows;
  const lcA = lc.find((r) => r.id === cx.lossCases.analysisId) || {};
  const lcD = lc.find((r) => r.id === cx.lossCases.decidedId) || {};
  check('casos de perda restaurados: 1 em análise sem movimento, 1 aprovado com o movimento LOSS',
    ['OPEN', 'PENDING_APPROVAL'].includes(lcA.status) && !lcA.resulting_movement_id && lcD.status === 'APPROVED' && lcD.resulting_movement_id === cx.lossCases.decidedMovementId,
    `${lcA.status} / ${lcD.status}`);
  const kc = (await c.query('SELECT id, status FROM inventory.counts WHERE id = ANY($1::uuid[])', [[cx.counts.closedId, cx.counts.openId]])).rows;
  const div = await one(c, 'SELECT COUNT(*) FILTER (WHERE divergence <> 0) AS div FROM inventory.count_items WHERE count_id = $1', [cx.counts.closedId]);
  check('contagens restauradas: 1 fechada com divergência, 1 aberta; proposta de ajuste pendente',
    kc.find((r) => r.id === cx.counts.closedId)?.status === 'COMPLETED' && kc.find((r) => r.id === cx.counts.openId)?.status === 'OPEN' && Number(div.div) === cx.counts.divergentItems
      && (await one(c, 'SELECT status FROM inventory.adjustment_proposals WHERE id = $1', [cx.adjustmentProposalId]))?.status === 'PENDING',
    `${div.div} item(ns) divergente(s)`);
  const cl = (await c.query('SELECT id, status, settled_amount, financial_entry_id FROM procurement.insurance_claims WHERE id = ANY($1::uuid[])', [[cx.claims.openId, cx.claims.submittedId, cx.claims.settledId]])).rows;
  const clS = cl.find((r) => r.id === cx.claims.settledId) || {};
  check('sinistros restaurados: aberto, submetido e liquidado com o lançamento do Financeiro',
    cl.find((r) => r.id === cx.claims.openId)?.status === 'OPEN' && cl.find((r) => r.id === cx.claims.submittedId)?.status === 'SUBMITTED'
      && clS.status === 'SETTLED' && Number(clS.settled_amount) === cx.claims.settledAmount && clS.financial_entry_id === cx.claims.settledFinancialEntryId,
    cl.map((r) => r.status).join(', '));
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
  let extra = {};
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
    let complement = null;
    let storage = null;
    if (source) complement = await complementComparison(source, target);
    if (source && args.targetUploads) storage = await attachmentChecks(source, target, args, fixtures);
    if (args.targetAppUrl && fixtures) await rlsCheck(args.targetAppUrl, fixtures.tenant, (await one(target, 'SELECT COUNT(*) AS n FROM inventory.stock_balances WHERE company_id = $1', [fixtures.tenant.companyId])).n);
    if (fixtures) await fixtureChecks(target, fixtures);
    extra = { complement, storage };
  } finally {
    await target.end();
    if (source) await source.end();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nResultado: ${results.length - failed}/${results.length} checagens OK${failed ? ` — ${failed} FALHA(S)` : ''}.`);
  if (args.report) fs.writeFileSync(args.report, JSON.stringify({ checks: results, tables, complementoOrigemDestino: extra.complement || null, anexos: extra.storage || null }, null, 2));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`verifyRestoreInventoryProcurementData falhou: ${err.message}`);
  process.exit(1);
});
