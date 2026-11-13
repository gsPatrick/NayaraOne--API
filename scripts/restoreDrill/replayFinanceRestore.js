'use strict';

/**
 * Replay pós-restore e adulteração deliberada — drill de restore FINANCEIRO (Marco 4, M4-25
 * "Restore e replay financeiro sem duplicidade"). Processo filho com DATABASE_URL = banco
 * RESTAURADO (role de runtime): os replays passam pelos SERVIÇOS REAIS e são COMMITADOS — o
 * que se prova é que nada duplica de verdade no banco restaurado.
 *
 *   1. mesmo callback bancário CONFIRMED (mesmo corpo e assinatura HMAC) → nenhum lançamento novo;
 *   2. reimportação do mesmo extrato CSV → nenhuma bank_transaction nova (fingerprint/id externo);
 *   3. lançamento com idempotencyKey já existente → recusado pelo serviço E pelo índice UNIQUE;
 *   4. mesma baixa parcial do recebível de R$ 0,30 (mesma chave) → nenhuma filha nova;
 *   5. mesma comissão (mesma idempotencyKey) → nenhuma comissão nova;
 *   6. período CLOSED restaurado recusa lançamento novo no mês;
 *   7. adulteração deliberada de um valor no destino (com os triggers desligados pelo
 *      superusuário) → o hash canônico origem × destino passa a divergir.
 * Argumentos: --fixtures, --source-url, --target-url (superusuário), --target-app-url, --report.
 */
const fs = require('fs');
const { Client } = require('pg');
const { assertDrillDatabase } = require('./drillGuard');
const L = require('./financeDrillLib');

const args = {};
process.argv.slice(2).forEach((a, i, all) => { if (a.startsWith('--') && all[i + 1]) args[a.slice(2)] = all[i + 1]; });
for (const r of ['fixtures', 'source-url', 'target-url', 'target-app-url', 'report']) if (!args[r]) throw new Error(`Argumento obrigatório ausente: --${r}`);
for (const url of [process.env.DATABASE_URL, args['source-url'], args['target-url'], args['target-app-url']]) assertDrillDatabase(url, 'replayFinanceRestore');

const { sequelize } = require('../../src/models');
const financialEntries = require('../../src/modules/finance/application/services/financial-entry.service');
const receiptService = require('../../src/modules/finance/application/services/receipt.service');
const bankTransactions = require('../../src/modules/finance/application/services/bank-transactions.service');
const commissions = require('../../src/modules/finance/application/services/commission.service');
const financeController = require('../../src/modules/finance/presentation/http/finance.controller');

const rec = L.createRecorder();
const replays = [];

async function inTenant(tenant, fn) {
  return sequelize.transaction(async (t) => {
    for (const [k, v] of [['app.group_id', tenant.groupId], ['app.company_id', tenant.companyId], ['app.user_id', tenant.userId]]) {
      await sequelize.query('SELECT set_config(:k, :v, true)', { replacements: { k, v }, transaction: t });
    }
    return fn(t);
  });
}

async function attempt(fn) {
  try { return { value: await fn() }; } catch (err) { return { error: err }; }
}

async function count(client, sql, params) {
  return (await client.query(sql, params)).rows[0].n;
}

async function main() {
  const fx = JSON.parse(fs.readFileSync(args.fixtures, 'utf8'));
  const A = fx.tenantA;
  const W = (fields) => ({ groupId: A.groupId, companyId: A.companyId, ...fields });
  const target = new Client({ connectionString: args['target-url'] });
  const source = new Client({ connectionString: args['source-url'] });
  await Promise.all([target.connect(), source.connect()]);
  const nEntries = () => count(target, 'SELECT count(*)::int AS n FROM finance.financial_entries');
  try {
    console.log('\n--- Replay 1: mesmo callback bancário CONFIRMED contra o banco restaurado ---');
    const p = A.payment;
    const before1 = { entries: await nEntries(), lock: (await target.query('SELECT lock_version FROM finance.financial_entries WHERE id = $1', [p.financialEntryId])).rows[0].lock_version };
    const rawBody = Buffer.from(JSON.stringify(p.webhookBody));
    const outcomes = [];
    for (let i = 1; i <= 2; i += 1) {
      const r = await attempt(() => sequelize.transaction((t) => financeController.processBankPaymentWebhook({ body: p.webhookBody, rawBody, headers: { 'x-webhook-signature': p.webhookSignature } }, t)));
      outcomes.push(r.error ? `erro ${r.error.code}` : JSON.stringify(r.value));
    }
    const intent = (await target.query('SELECT status FROM finance.payment_intents WHERE id = $1', [p.paymentIntentId])).rows[0];
    const after1 = { entries: await nEntries(), lock: (await target.query('SELECT lock_version FROM finance.financial_entries WHERE id = $1', [p.financialEntryId])).rows[0].lock_version, children: await count(target, 'SELECT count(*)::int AS n FROM finance.financial_entries WHERE parent_entry_id = $1', [p.financialEntryId]) };
    rec.check('replay callback bancário', `2 entregas do mesmo callback: ${outcomes.join(' | ')}`, outcomes.every((o) => !o.startsWith('erro') && /"processed":false/.test(o)));
    rec.check('replay callback bancário', `intenção segue ${intent.status}; lançamentos ${before1.entries} → ${after1.entries}; filhos ${after1.children}; lock_version ${before1.lock} → ${after1.lock}`,
      intent.status === 'EXECUTED' && before1.entries === after1.entries && after1.children === 0 && before1.lock === after1.lock);
    replays.push({ replay: 'callback bancário CONFIRMED (2 entregas)', resultado: outcomes, lancamentosAntes: before1.entries, lancamentosDepois: after1.entries });

    console.log('\n--- Replay 2: reimportação do mesmo extrato ---');
    const tx0 = await count(target, 'SELECT count(*)::int AS n FROM finance.bank_transactions');
    const re = await inTenant(A, (t) => bankTransactions.importBankStatement(W({ bankAccountId: A.bankAccountId, csvText: A.statement.csvText }), A.userId, t));
    const tx1 = await count(target, 'SELECT count(*)::int AS n FROM finance.bank_transactions');
    rec.check('replay extrato', `reimportação: importadas ${re.imported.length}, duplicadas ${re.duplicates.length}; bank_transactions ${tx0} → ${tx1}`, re.imported.length === 0 && re.duplicates.length === 1 && tx0 === tx1);
    replays.push({ replay: 'reimportação do mesmo extrato CSV', importadas: re.imported.length, duplicadas: re.duplicates.length, antes: tx0, depois: tx1 });

    console.log('\n--- Replay 3: lançamento com idempotencyKey já existente ---');
    const e0 = await nEntries();
    const dup = await attempt(() => inTenant(A, (t) => financialEntries.createFinancialEntry(
      W({ entryType: 'DEBIT', nature: 'PAYABLE', amount: '1234.56', description: 'DRILL replay do mesmo pagamento', costCenterId: A.costCenterId, bankAccountId: A.bankAccountId, idempotencyKey: p.idempotencyKey }), A.userId, t
    )));
    const cols = (await target.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'finance' AND table_name = 'financial_entries' AND column_name <> 'id' ORDER BY ordinal_position")).rows.map((r) => `"${r.column_name}"`).join(', ');
    const app = new Client({ connectionString: args['target-app-url'] });
    await app.connect();
    await L.beginTenant(app, A);
    const raw = await L.sqlError(app, `INSERT INTO finance.financial_entries (id, ${cols}) SELECT gen_random_uuid(), ${cols} FROM finance.financial_entries WHERE id = $1`, [p.financialEntryId]);
    await app.query('ROLLBACK');
    const e1 = await nEntries();
    rec.check('replay idempotencyKey', `serviço recusou: ${dup.error ? dup.error.code : 'ACEITOU (errado)'}`, dup.error && dup.error.code === 'FINANCE_DUPLICATE_PAYMENT');
    rec.check('replay idempotencyKey', `INSERT direto com a mesma chave recusado pelo banco: ${raw ? `${raw.code} ${raw.message.slice(0, 80)}` : 'ACEITO (errado)'}`, raw && raw.code === '23505');
    rec.check('replay idempotencyKey', `lançamentos ${e0} → ${e1}`, e0 === e1);
    replays.push({ replay: 'lançamento com idempotencyKey existente', servico: dup.error ? dup.error.code : 'aceito', banco: raw ? raw.code : 'aceito', antes: e0, depois: e1 });

    console.log('\n--- Replay 4: mesma baixa parcial do recebível de R$ 0,30 (mesma chave) ---');
    const step2 = A.receivable030.steps[1];
    const keyStored = (await target.query('SELECT idempotency_key FROM finance.financial_entries WHERE id = $1', [step2.settlementEntryId])).rows[0].idempotency_key;
    const kids0 = await count(target, 'SELECT count(*)::int AS n FROM finance.financial_entries WHERE parent_entry_id = $1', [A.receivable030.parentId]);
    const sp = await attempt(() => inTenant(A, (t) => receiptService.settleFinancialEntryPartial(A.receivable030.parentId, step2.amount, A.userId, t, { idempotencyKey: step2.idempotencyKey })));
    const kids1 = await count(target, 'SELECT count(*)::int AS n FROM finance.financial_entries WHERE parent_entry_id = $1', [A.receivable030.parentId]);
    const supported = Boolean(keyStored);
    const spResult = sp.error ? `recusada ${sp.error.code}` : `devolvida a baixa original ${(sp.value.settlement || {}).id === step2.settlementEntryId ? '(mesmo id)' : '(id diferente)'}${sp.value.idempotentReplay ? ' idempotentReplay=true' : ''}`;
    rec.check('replay baixa parcial', `chave idempotente gravada na baixa restaurada: ${supported ? 'sim' : 'NÃO (baixa parcial ainda sem chave neste commit)'}; replay → ${spResult}`,
      supported ? (!sp.error && sp.value.settlement && sp.value.settlement.id === step2.settlementEntryId) : Boolean(sp.error));
    rec.check('replay baixa parcial', `filhas do recebível ${kids0} → ${kids1} (nenhuma baixa nova)`, kids0 === kids1 && kids1 === 2);
    replays.push({ replay: 'mesma baixa parcial (mesma chave)', chaveGravada: supported, resultado: spResult, filhasAntes: kids0, filhasDepois: kids1 });

    console.log('\n--- Replay 5: mesma comissão (mesma idempotencyKey) ---');
    const c0 = await count(target, 'SELECT count(*)::int AS n FROM finance.commissions');
    const key = (await target.query('SELECT idempotency_key FROM finance.commissions WHERE id = $1', [A.commission.id])).rows[0].idempotency_key;
    const cr = await attempt(() => inTenant(A, (t) => commissions.createCommission(W({ beneficiaryUserId: A.userId, sourceEntryId: A.commission.sourceEntryId, component: 'BROKER', installmentsCount: 2, idempotencyKey: key }), A.userId, t)));
    const c1 = await count(target, 'SELECT count(*)::int AS n FROM finance.commissions');
    const crResult = cr.error ? `recusada ${cr.error.code}` : `devolvida a comissão ${cr.value.commission && cr.value.commission.id === A.commission.id ? 'original (mesmo id)' : 'DIFERENTE'}`;
    rec.check('replay comissão', `replay → ${crResult}; comissões ${c0} → ${c1}`, c0 === c1 && (cr.error || (cr.value.commission && cr.value.commission.id === A.commission.id)));
    replays.push({ replay: 'mesma comissão (mesma idempotencyKey)', resultado: crResult, antes: c0, depois: c1 });

    console.log('\n--- Período CLOSED restaurado ---');
    const cp = await attempt(() => inTenant(A, (t) => financialEntries.createFinancialEntry(
      W({ entryType: 'CREDIT', nature: 'RECEIVABLE', amount: '10.00', resultCenterId: A.resultCenterId, description: 'DRILL lançamento novo no mês fechado', competenceMonth: A.closedPeriod.referenceMonth }), A.userId, t
    )));
    const ed = await attempt(() => inTenant(A, (t) => financialEntries.updateFinancialEntry(A.closedPeriod.insideEntryId, { description: 'edição no mês fechado' }, A.userId, t)));
    rec.check('período fechado (destino)', `lançamento novo em ${A.closedPeriod.referenceMonth}: ${cp.error ? cp.error.code : 'ACEITO (errado)'}`, cp.error && cp.error.code === 'FINANCE_PERIOD_CLOSED');
    rec.check('período fechado (destino)', `edição de lançamento do mês fechado: ${ed.error ? ed.error.code : 'ACEITA (errado)'}`, ed.error && ed.error.code === 'FINANCE_PERIOD_CLOSED');
    await app.end();

    console.log('\n--- Adulteração deliberada no destino (superusuário, triggers desligados) ---');
    const spec = { name: 'finance.financial_entries', sql: 'SELECT * FROM finance.financial_entries' };
    const clean = await L.compareObject(L.createRecorder(), source, target, spec);
    await target.query('BEGIN');
    await target.query('SET LOCAL session_replication_role = replica');
    await target.query('UPDATE finance.financial_entries SET amount = amount + 1000 WHERE id = $1', [p.financialEntryId]);
    await target.query('COMMIT');
    console.log('  (comparação com a adulteração — os ❌ abaixo são o esperado)');
    const tampered = await L.compareObject(L.createRecorder(), source, target, spec);
    rec.check('adulteração', `antes da adulteração: hash origem = destino (${clean.hashSource.slice(0, 16)}…)`, clean.hashEqual);
    rec.check('adulteração', `valor do pagamento alterado no destino (1234.56 → 2234.56): divergência de campo detectada (${tampered.failures}) e hash diverge (${tampered.hashSource.slice(0, 16)}… ≠ ${tampered.hashTarget.slice(0, 16)}…)`,
      tampered.failures >= 1 && !tampered.hashEqual);
    replays.push({ replay: 'adulteração deliberada de 1 valor no destino', hashAntes: clean.hashTarget, hashDepois: tampered.hashTarget, divergenciasDeCampo: tampered.failures, detectada: !tampered.hashEqual });
  } finally {
    await Promise.all([target.end(), source.end()]);
    await sequelize.close();
  }
  const ok = rec.results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${rec.results.length} checagens aprovadas (replay e adulteração).`);
  fs.writeFileSync(args.report, JSON.stringify({ replays, checks: rec.results, approved: ok, total: rec.results.length }, null, 2));
  process.exit(ok === rec.results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error(`❌ replay interrompido: ${err.stack || err.message}`);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
