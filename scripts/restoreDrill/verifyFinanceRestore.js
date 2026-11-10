'use strict';

/**
 * Verificação pós-restore do drill FINANCEIRO (Marco 4). Processo filho com:
 *   DATABASE_URL = banco RESTAURADO (role de runtime, sem BYPASSRLS)
 *   UPLOADS_DIR  = storage RESTAURADO (scripts/restoreStorage.js)
 * Argumentos: --fixtures, --source-url/--target-url (superusuário: conteúdo bruto, sem RLS),
 * --target-app-url (role de runtime: invariantes e RLS), --source-uploads, --report.
 *
 * 1. Origem × destino campo a campo + hash canônico SHA-256 por objeto: TODAS as tabelas e
 *    views do schema finance, trilha de auditoria financeira (audit.audit_log finance.*), outbox
 *    e eventos de domínio finance.*, versões da regra de comissão e metadados dos comprovantes.
 * 2. Bytes dos comprovantes (storage cifrado) = SHA-256 calculado nas fixtures.
 * 3. Invariantes no destino: saldo do recebível 0,30 − Σ filhas SETTLED = 0,00; ledger
 *    append-only (UPDATE/DELETE recusados pelo trigger restaurado); RLS do tenant B.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { assertDrillDatabase } = require('./drillGuard');
const L = require('./financeDrillLib');

const args = {};
process.argv.slice(2).forEach((a, i, all) => { if (a.startsWith('--') && all[i + 1]) args[a.slice(2)] = all[i + 1]; });
for (const r of ['fixtures', 'source-url', 'target-url', 'target-app-url', 'source-uploads', 'report']) {
  if (!args[r]) throw new Error(`Argumento obrigatório ausente: --${r}`);
}
for (const url of [process.env.DATABASE_URL, args['source-url'], args['target-url'], args['target-app-url']]) assertDrillDatabase(url, 'verifyFinanceRestore');

const { decryptFileBuffer } = require('../../src/utils/fileCrypto');

// Mínimo de registros exigido por objeto (o que as fixtures criam com certeza).
const MIN = {
  'finance.financial_entries': 14, 'finance.ledger': 8, 'finance.payment_intents': 1, 'finance.bank_payment_provider_routing': 1,
  'finance.approval_requests': 2, 'finance.approval_steps': 2, 'finance.bank_transactions': 1, 'finance.reconciliations': 1,
  'finance.owner_repasses': 1, 'finance.commissions': 1, 'finance.commission_installments': 2, 'finance.intercompany_transfers': 1,
  'finance.period_closures': 1, 'finance.anomaly_cases': 1, 'finance.entry_installments': 3, 'finance.security_deposits': 1,
  'finance.closing_periods': 1, 'finance.bank_accounts': 2, 'finance.cost_centers': 1, 'finance.result_centers': 2,
};

async function connect(url) {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

async function main() {
  const fx = JSON.parse(fs.readFileSync(args.fixtures, 'utf8'));
  const A = fx.tenantA;
  const B = fx.tenantB;
  const rec = L.createRecorder();
  const objectSummary = [];
  const source = await connect(args['source-url']);
  const target = await connect(args['target-url']);
  const app = await connect(args['target-app-url']);
  try {
    console.log('=== Drill de restore financeiro — comparação origem × destino restaurado ===');
    console.log(`Tenant A: company=${A.companyId}  |  Tenant B (isolamento): company=${B.companyId}`);

    const rels = (await source.query(
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'finance' ORDER BY table_name"
    )).rows;
    rec.check('schema finance', `objetos do schema finance na origem: ${rels.length} (tabelas e views)`, rels.length >= 20);
    const targetRels = (await target.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'finance'")).rows[0].n;
    rec.check('schema finance', `mesmos objetos no destino (${targetRels})`, targetRels === rels.length);
    const specs = rels.map((r) => ({ name: `finance.${r.table_name}`, sql: `SELECT * FROM finance."${r.table_name}"`, minRecords: MIN[`finance.${r.table_name}`] || 0 }));
    specs.push(
      { name: 'audit.audit_log (ações finance.*)', sql: "SELECT * FROM audit.audit_log WHERE action LIKE 'finance.%'", minRecords: 20 },
      { name: 'integration.outbox_events (finance.*)', sql: "SELECT * FROM integration.outbox_events WHERE event_type LIKE 'finance.%'", minRecords: 1 },
      { name: 'integration.domain_events (finance.*)', sql: "SELECT * FROM integration.domain_events WHERE event_type LIKE 'finance.%'", minRecords: 0 },
      { name: 'core.rule_versions (regra de comissão)', sql: 'SELECT * FROM core.rule_versions WHERE rule_id = (SELECT rule_id FROM core.rule_versions WHERE id = $1)', params: [A.commission.ruleVersionId], minRecords: 1 },
      { name: 'people.files (comprovantes financeiros)', sql: 'SELECT * FROM people.files WHERE id = ANY($1::uuid[])', params: [Object.keys(A.files)], minRecords: Object.keys(A.files).length },
    );
    for (const spec of specs) objectSummary.push(await L.compareObject(rec, source, target, spec));

    console.log('\n--- Bytes dos comprovantes (storage cifrado restaurado) ---');
    const files = (await target.query('SELECT id, storage_key, size_bytes, checksum_sha256 FROM people.files WHERE id = ANY($1::uuid[]) ORDER BY id', [Object.keys(A.files)])).rows;
    for (const f of files) {
      const srcBlob = fs.readFileSync(path.join(args['source-uploads'], f.storage_key));
      const tgtBlob = fs.readFileSync(path.join(process.env.UPLOADS_DIR, f.storage_key));
      const plain = decryptFileBuffer(tgtBlob);
      const digest = crypto.createHash('sha256').update(plain).digest('hex');
      rec.check('arquivos (bytes)', `${f.id.slice(0, 8)}: blob cifrado idêntico (${tgtBlob.length} bytes)`, srcBlob.equals(tgtBlob));
      rec.check('arquivos (bytes)', `${f.id.slice(0, 8)}: SHA-256 decifrado = SHA-256 calculado nas fixtures (${digest.slice(0, 16)}…)`, digest === A.files[f.id] && digest === f.checksum_sha256);
      rec.check('arquivos (bytes)', `${f.id.slice(0, 8)}: não vazio e do tamanho gravado (${plain.length} bytes)`, plain.length > 0 && plain.length === Number(f.size_bytes));
    }

    console.log('\n--- Invariantes no destino (role de runtime, contexto do tenant A) ---');
    await L.beginTenant(app, A);
    const r030 = A.receivable030;
    const parent = (await app.query('SELECT amount, status FROM finance.financial_entries WHERE id = $1', [r030.parentId])).rows[0];
    const kids = (await app.query("SELECT id, amount, status FROM finance.financial_entries WHERE parent_entry_id = $1 AND nature <> 'PENDING_CLASSIFICATION' ORDER BY amount", [r030.parentId])).rows;
    const settledCents = kids.filter((k) => k.status === 'SETTLED').reduce((s, k) => s + Math.round(Number(k.amount) * 100), 0);
    const remaining = ((Math.round(Number(parent.amount) * 100) - settledCents) / 100).toFixed(2);
    rec.check('recebível R$ 0,30', `pai restaurado: valor ${parent.amount}, status ${parent.status}`, parent.amount === '0.30' && parent.status === 'SETTLED');
    rec.check('recebível R$ 0,30', `filhas SETTLED restauradas: ${kids.map((k) => k.amount).join(' + ')} = ${(settledCents / 100).toFixed(2)}`, kids.length === 2 && kids[0].amount === '0.10' && kids[1].amount === '0.20' && kids.every((k) => k.status === 'SETTLED'));
    rec.check('recebível R$ 0,30', `saldo = 0,30 − Σ filhas SETTLED = ${remaining}`, remaining === '0.00');
    rec.check('recebível R$ 0,30', `saldos registrados antes do backup: ${r030.steps.map((s) => `após ${s.amount} → ${s.remainingAmount} (${s.parentStatus})`).join('; ')}`,
      r030.steps[0].remainingAmount === '0.20' && r030.steps[0].parentStatus === 'PARTIALLY_SETTLED' && r030.steps[1].remainingAmount === '0.00' && r030.steps[1].parentStatus === 'SETTLED');
    const ledgerRows = (await app.query('SELECT movement_type, direction, amount FROM finance.ledger WHERE financial_entry_id = $1 ORDER BY amount', [r030.parentId])).rows;
    rec.check('recebível R$ 0,30', `finance.ledger: ${ledgerRows.map((l) => `${l.movement_type}/${l.direction} ${l.amount}`).join(', ')}`, ledgerRows.length === 2 && ledgerRows.every((l) => l.direction === 'CREDIT'));

    const child = kids[0].id;
    for (const [label, sql] of [
      ['UPDATE do valor de um movimento liquidado', 'UPDATE finance.financial_entries SET amount = amount + 1 WHERE id = $1'],
      ['UPDATE da chave idempotente de um movimento liquidado', "UPDATE finance.financial_entries SET idempotency_key = 'adulterado' WHERE id = $1"],
      ['DELETE de um movimento liquidado', 'DELETE FROM finance.financial_entries WHERE id = $1'],
    ]) {
      const err = await L.sqlError(app, sql, [child]);
      rec.check('ledger append-only (destino)', `${label} recusado pelo banco restaurado`, Boolean(err), err ? err.message.slice(0, 110) : 'ACEITO (errado)');
    }
    const viewWrite = await L.sqlError(app, "UPDATE finance.ledger SET amount = 1 WHERE id = $1", [child]);
    rec.check('ledger append-only (destino)', 'escrita na view finance.ledger recusada', Boolean(viewWrite), viewWrite ? viewWrite.message.slice(0, 110) : 'ACEITA (errado)');
    const closure = (await app.query('SELECT status FROM finance.period_closures WHERE company_id = $1 AND reference_month = $2', [A.companyId, A.closedPeriod.referenceMonth])).rows[0];
    rec.check('período fechado (destino)', `período ${A.closedPeriod.referenceMonth} restaurado com status ${closure && closure.status}`, closure && closure.status === 'CLOSED');
    await app.query('ROLLBACK');

    console.log('\n--- RLS no destino: tenant B não lê nada do tenant A ---');
    const tablesA = ['financial_entries', 'ledger', 'payment_intents', 'approval_requests', 'bank_transactions', 'reconciliations', 'owner_repasses', 'commissions', 'commission_installments', 'intercompany_transfers', 'period_closures', 'anomaly_cases', 'bank_accounts'];
    await L.beginTenant(app, B);
    const seen = {};
    for (const t of tablesA) seen[t] = (await app.query(`SELECT count(*)::int AS n FROM finance."${t}" WHERE company_id = $1`, [A.companyId])).rows[0].n;
    rec.check('RLS (destino)', `tenant B vê 0 linhas do A em ${tablesA.length} objetos`, Object.values(seen).every((n) => n === 0), JSON.stringify(seen));
    const own = (await app.query('SELECT count(*)::int AS n FROM finance.financial_entries WHERE id = $1', [B.entryId])).rows[0].n;
    rec.check('RLS (destino)', `controle positivo: tenant B vê o próprio lançamento (${own})`, own === 1);
    const upd = await app.query('UPDATE finance.anomaly_cases SET reason = $2 WHERE id = $1', [A.anomalyCaseId, 'invasão do tenant B']);
    rec.check('RLS (destino)', `tenant B alterando anomalia do A → ${upd.rowCount} linha(s) afetada(s)`, upd.rowCount === 0);
    await app.query('ROLLBACK');
    await L.beginTenant(app, null);
    const noCtx = (await app.query('SELECT count(*)::int AS n FROM finance.financial_entries')).rows[0].n;
    rec.check('RLS (destino)', `sem contexto de tenant a role de runtime vê ${noCtx} lançamentos (fail-closed)`, noCtx === 0);
    await app.query('ROLLBACK');
    const attrs = (await target.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nayara_runtime'")).rows[0];
    rec.check('RLS (destino)', `role nayara_runtime no destino: superuser=${attrs.rolsuper}, bypassrls=${attrs.rolbypassrls}`, !attrs.rolsuper && !attrs.rolbypassrls);
  } finally {
    await Promise.all([source.end(), target.end(), app.end()]);
  }

  const ok = rec.results.filter((r) => r.ok).length;
  console.log('\n=== Resumo por objeto ===');
  for (const o of objectSummary) console.log(`  ${o.failures === 0 && o.hashEqual ? '✅' : '❌'} ${o.objectName}: ${o.records} registro(s), ${o.comparedWithValue} comparações, hash ${o.hashSource.slice(0, 16)}…`);
  console.log(`\n${ok}/${rec.results.length} checagens aprovadas (verificação).`);
  fs.writeFileSync(args.report, JSON.stringify({ objectSummary, checks: rec.results, approved: ok, total: rec.results.length }, null, 2));
  process.exit(ok === rec.results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(`❌ verificação interrompida: ${err.stack || err.message}`);
  process.exit(1);
});
