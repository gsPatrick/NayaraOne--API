'use strict';

// Caderno M4 §7 "Ledger DDL mínimo" (idempotency_key NOT NULL UNIQUE, amount > 0, created_by NOT NULL, source_event_id),
// §2 FIN-004 (baixa com chave idempotente), FIN-008 (sem float: nada vira 0,00) e §5 (finance.bank_transactions — extrato
// importado imutável). Verificação independente 11/11/2026, sondas P0, P1, P5 e P11. HTTP real + papel de runtime
// (nayara_runtime, sem BYPASSRLS) no banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4LR_DDL_HTTP_TEST_PORT || '28952';
require('../app');
const { uniqueSuffix, withTenantTransaction, withRollbackTenantTransaction, sequelize, createTestResultCenter } = require('./testHelpers');
const { createUser, tokenFor, client, isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const entriesSvc = require('../src/modules/finance/application/services/financial-entry.service');
const receipt = require('../src/modules/finance/application/services/receipt.service');
const bankAccounts = require('../src/modules/finance/application/services/bank-accounts.service');
const bankTx = require('../src/modules/finance/application/services/bank-transactions.service');
const { hasAtMostTwoDecimals } = require('../src/modules/finance/presentation/http/money-precision.middleware');
const { FinancialEntry } = require('../src/models');

let tenant;
let rc;
let http;
let token;

before(async () => {
  tenant = await isolatedTenant('m4lr-ddl');
  rc = await withTenantTransaction(tenant, async (t) => (await createTestResultCenter(tenant, t)).id);
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  token = tokenFor(tenant, (await createUser(tenant, 'm4lr-ddl')).id);
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  await closeIsolated();
  await sequelize.close();
  process.exit(0);
});

const tx = (fn) => withTenantTransaction(tenant, fn);
const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', resultCenterId: rc, description: `M4LR DDL ${uniqueSuffix()}`, dueAt: '2026-11-20' });
const recv = (amount) => tx((t) => entriesSvc.createFinancialEntry({ ...base(), amount }, tenant.userId, t));
const query = (sql, replacements) => tx((t) => sequelize.query(sql, { replacements, type: 'SELECT', transaction: t }));

test('M4-§7 (sonda P0): idempotency_key e created_by NOT NULL; CHECK amount > 0; chave do movimento única por empresa; a view tem source_event_id', async () => {
  const cols = await query(`SELECT column_name, is_nullable FROM information_schema.columns
                             WHERE table_schema = 'finance' AND table_name = 'financial_entries' AND column_name IN ('idempotency_key', 'created_by')`);
  assert.deepEqual(Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable])), { idempotency_key: 'NO', created_by: 'NO' });
  const checks = await query("SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'finance.financial_entries'::regclass AND contype = 'c'");
  const names = Object.fromEntries(checks.map((c) => [c.conname, c.convalidated]));
  assert.equal(names.financial_entries_amount_positive_ck, true, 'CHECK amount > 0 validado');
  assert.equal(names.financial_entries_bank_confirmed_account_ck, true, 'movimento confirmado pelo banco tem conta (Guia §7)');
  const [uk] = await query("SELECT indexdef FROM pg_indexes WHERE schemaname = 'finance' AND indexname = 'financial_entries_company_ledger_key_uk'");
  assert.match(uk.indexdef, /UNIQUE INDEX .*COALESCE\(settlement_idempotency_key, idempotency_key\)/);
  const viewCols = (await query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'ledger'")).map((c) => c.column_name);
  for (const col of ['company_id', 'bank_account_id', 'direction', 'amount', 'currency', 'idempotency_key', 'occurred_at', 'reverses_ledger_id', 'source_event_id', 'created_by']) {
    assert.ok(viewCols.includes(col), `finance.ledger.${col}`);
  }
});

test('M4-FIN-008 (sonda P1): "1e-3" e "4e-3" são recusados no filtro de centavos e no serviço — nenhum lançamento nem baixa de 0,00', async () => {
  assert.equal(hasAtMostTwoDecimals('1e-3'), false);
  assert.equal(hasAtMostTwoDecimals('4e-3'), false);
  assert.equal(hasAtMostTwoDecimals('0.30'), true);
  const http1 = await http('POST', '/finance/entries', token, { ...base(), amount: '1e-3' });
  assert.equal(http1.status, 400);
  assert.equal(http1.body.error.code, 'FINANCE_AMOUNT_FORMAT_INVALID');
  await assert.rejects(recv('1e-3'), (e) => e.code === 'FINANCE_ENTRY_VALIDATION');
  await assert.rejects(recv(0.004), (e) => e.code === 'FINANCE_ENTRY_VALIDATION', 'vira 0,00 no centavo');
  const e = await recv('0.30');
  const http2 = await http('POST', `/finance/entries/${e.id}/settle-partial`, token, { partialAmount: '4e-3', idempotencyKey: `m4lr-4e3-${uniqueSuffix()}` });
  assert.equal(http2.status, 400);
  assert.equal(http2.body.error.code, 'FINANCE_AMOUNT_FORMAT_INVALID');
  await assert.rejects(tx((t) => receipt.settleFinancialEntryPartial(e.id, '4e-3', tenant.userId, t, { idempotencyKey: `m4lr-s4e3-${uniqueSuffix()}` })), (err) => err.code === 'FINANCE_ENTRY_VALIDATION');
  const [zero] = await query('SELECT count(*)::int AS n FROM finance.financial_entries WHERE company_id = :c AND amount <= 0', { c: tenant.companyId });
  assert.equal(zero.n, 0);
  await assert.rejects(
    withRollbackTenantTransaction(tenant, (t) => sequelize.query(
      `INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, amount, status, result_center_id, created_at, updated_at)
       VALUES (gen_random_uuid(), :g, :c, 'CREDIT', 'RECEIVABLE', 0.00, 'PENDING', :rc, now(), now())`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, rc }, transaction: t })),
    (err) => /financial_entries_amount_positive_ck/.test(String(err.message) + String(err.parent && err.parent.message)),
    'o banco recusa 0,00 mesmo por SQL direto'
  );
});

test('M4-FIN-004 (sonda P5): baixa integral pela API exige chave; o movimento do ledger nunca fica sem chave nem sem autor', async () => {
  const e = await recv('12.34');
  const semChave = await http('POST', `/finance/entries/${e.id}/settle`, token, {});
  assert.equal(semChave.status, 400);
  assert.equal(semChave.body.error.code, 'FINANCE_IDEMPOTENCY_KEY_REQUIRED');
  const ok = await http('POST', `/finance/entries/${e.id}/settle`, token, { idempotencyKey: `m4lr-int-${uniqueSuffix()}` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const [row] = await query('SELECT idempotency_key, created_by, source_event_id FROM finance.ledger WHERE id = :id', { id: e.id });
  assert.match(row.idempotency_key, /^baixa-integral:[0-9a-f]{64}$/, 'a chave do cliente, derivada, é a chave do movimento');
  assert.ok(row.created_by);
  const [ev] = await query("SELECT id FROM integration.outbox_events WHERE idempotency_key = :k", { k: `finance.entry.settled:${e.id}` });
  assert.equal(row.source_event_id, ev.id, 'source_event_id = evento de domínio do movimento');

  const interno = await recv('5.00');
  await tx((t) => receipt.settleFinancialEntry(interno.id, tenant.userId, t, {})); // chamada interna (job, outro módulo)
  const [r2] = await query('SELECT idempotency_key FROM finance.ledger WHERE id = :id', { id: interno.id });
  assert.equal(r2.idempotency_key, `baixa-integral:interna:${interno.id}`);
  const [stats] = await query(
    'SELECT count(*)::int AS n, count(*) FILTER (WHERE idempotency_key IS NULL)::int AS sem_chave, count(*) FILTER (WHERE created_by IS NULL)::int AS sem_autor, count(*) FILTER (WHERE amount <= 0)::int AS zero FROM finance.ledger WHERE company_id = :c',
    { c: tenant.companyId });
  assert.ok(stats.n >= 2);
  assert.deepEqual({ sem_chave: stats.sem_chave, sem_autor: stats.sem_autor, zero: stats.zero }, { sem_chave: 0, sem_autor: 0, zero: 0 });
  const semChaveSql = await tx((t) => sequelize.query(
    `INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, amount, status, result_center_id, created_at, updated_at)
     VALUES (gen_random_uuid(), :g, :c, 'CREDIT', 'RECEIVABLE', 1.00, 'PENDING', :rc, now(), now()) RETURNING id, idempotency_key, created_by`,
    { replacements: { g: tenant.groupId, c: tenant.companyId, rc }, type: 'SELECT', transaction: t }));
  assert.equal(semChaveSql[0].idempotency_key, `lancamento:${semChaveSql[0].id}`, 'o banco dá chave ao lançamento gravado sem chave');
  assert.equal(semChaveSql[0].created_by, tenant.userId, 'o autor é o usuário do contexto');
  const entry = await tx((t) => FinancialEntry.findByPk(semChaveSql[0].id, { transaction: t }));
  assert.ok(entry);
});

test('M4-§5.8 (sonda P11): o papel de runtime não altera nem apaga linha do extrato importado (finance.bank_transactions)', async () => {
  const [who] = await query('SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass');
  assert.equal(who.bypass, false, 'roda como o papel de runtime, sem BYPASSRLS');
  const s = uniqueSuffix();
  const id = await tx(async (t) => {
    const acc = await bankAccounts.createBankAccount({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '748', agency: '0001', accountNumber: `M4LR-${s}` }, tenant.userId, t);
    return (await bankTx.createBankTransaction({ groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: acc.id, externalTransactionId: `M4LR-${s}`, amount: '0.30', transactionDate: '2026-11-10', description: 'extrato M4LR' }, tenant.userId, t)).id;
  });
  const errOf = (p) => p.then(() => null, (e) => String(e.message));
  const upd = await errOf(withRollbackTenantTransaction(tenant, (t) => sequelize.query('UPDATE finance.bank_transactions SET amount = 999.99 WHERE id = :id', { replacements: { id }, transaction: t })));
  const del = await errOf(withRollbackTenantTransaction(tenant, (t) => sequelize.query('DELETE FROM finance.bank_transactions WHERE id = :id', { replacements: { id }, transaction: t })));
  assert.match(upd || '', /imutável/, 'UPDATE recusado');
  assert.match(del || '', /imutável|permission denied|permissão negada/, 'DELETE recusado');
  const [row] = await query('SELECT amount::text AS amount FROM finance.bank_transactions WHERE id = :id', { id });
  assert.equal(row.amount, '0.30');
});

test('M4-§7 bank_account_id (DI-M4LR-1): pagamento confirmado pelo banco sempre tem conta (CHECK); com o parâmetro ligado, nenhuma baixa entra no ledger sem conta', async () => {
  const { upsertSetting } = require('../src/features/settings/settings.service');
  await assert.rejects(
    withRollbackTenantTransaction(tenant, (t) => sequelize.query(
      `INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, amount, status, settled_at, settlement_method, result_center_id, created_at, updated_at)
       VALUES (gen_random_uuid(), :g, :c, 'DEBIT', 'PAYABLE', 10.00, 'SETTLED', now(), 'BANK_CONFIRMED', :rc, now(), now())`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, rc }, transaction: t })),
    (err) => /financial_entries_bank_confirmed_account_ck/.test(String(err.message) + String(err.parent && err.parent.message))
  );
  const semConta = await recv('3.00');
  await tx((t) => upsertSetting('finance.ledger.conta_bancaria_obrigatoria_na_baixa', true, tenant, tenant.userId, t));
  try {
    const r = await http('POST', `/finance/entries/${semConta.id}/settle`, token, { idempotencyKey: `m4lr-conta-${uniqueSuffix()}` });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'FINANCE_LEDGER_BANK_ACCOUNT_REQUIRED');
    const p = await http('POST', `/finance/entries/${semConta.id}/settle-partial`, token, { partialAmount: '1.00', idempotencyKey: `m4lr-conta-p-${uniqueSuffix()}` });
    assert.equal(p.status, 409);
    assert.equal(p.body.error.code, 'FINANCE_LEDGER_BANK_ACCOUNT_REQUIRED');
    const account = await tx((t) => bankAccounts.createBankAccount({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '748', agency: '0001', accountNumber: `M4LR-C-${uniqueSuffix()}` }, tenant.userId, t));
    await tx(async (t) => { account.status = 'ACTIVE'; await account.save({ transaction: t }); });
    const comConta = await tx((t) => entriesSvc.createFinancialEntry({ ...base(), amount: '3.00', bankAccountId: account.id }, tenant.userId, t));
    const ok = await http('POST', `/finance/entries/${comConta.id}/settle`, token, { idempotencyKey: `m4lr-conta-ok-${uniqueSuffix()}` });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const [row] = await query('SELECT bank_account_id FROM finance.ledger WHERE id = :id', { id: comConta.id });
    assert.equal(row.bank_account_id, account.id);
  } finally {
    await tx((t) => upsertSetting('finance.ledger.conta_bancaria_obrigatoria_na_baixa', false, tenant, tenant.userId, t));
  }
});
