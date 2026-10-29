'use strict';

// M9-D621 — KPIs de contas a pagar e recebíveis em 7, 30 e 60 dias: reprodução a partir dos registros-fonte, qualidade (sem vencimento), terceiros
// fora das janelas e fuso de São Paulo.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const envK = require('../_helpers/finKpiEnv');
const money = require('../../../src/features/analytics/metrics/formulas/money');
const scenario = require('../_helpers/m9d621Scenario');
const { windowFromSource, withoutDueDate } = require('../_helpers/m9d621Oracle');
const { buildFinanceKpiEntries } = require('../../../src/features/analytics/metrics/kpis/finance.entries');
require('../../../src/features/analytics'); // entrada real do BI: liga os KPIs financeiros ao fim do refresh

const { refresh, kpis, readKpi, dayAt } = envK;
const NATURE = (code) => (code.startsWith('fin.payables') ? 'PAYABLE' : 'RECEIVABLE');
const DAYS = (code) => Number(/_(\d+)d$/.exec(code)[1]);
let env;
before(async () => {
  env = await envK.setup();
  await scenario.seed(env, env.cX);
  await refresh(env.cX);
  await kpis(env.cX);
});
after(() => envK.teardown(env));

for (const code of scenario.CODES) {
  test(`m9d621 reproduz ${code} a partir dos registros-fonte`, async () => {
    const want = await windowFromSource(env, env.cX, { nature: NATURE(code), asOf: env.asOf, days: DAYS(code) });
    const got = await readKpi(env.cX, code);
    assert.equal(money.cmp(got.value, want.value), 0, 'centavo a centavo igual ao recálculo só com as linhas do ledger');
    assert.equal(money.cmp(got.value, scenario.EXPECTED[code]), 0, 'exemplo do livro');
    assert.deepEqual([got.status, got.unit, got.version, got.valueNature], ['OK', 'BRL', 1, 'PLANNED']);
    assert.ok(got.sourceSnapshotAt && got.refreshedAt && got.sourceRefs.length === 1);
    assert.equal(got.sourceRefs[0].table, 'finance.financial_entries');
    assert.equal(got.sourceRefs[0].count, want.count, 'o sourceRefs conta as mesmas linhas do valor');
  });

  test(`m9d621 ${code} fica DEGRADED com valor nulo quando a regra de qualidade falha`, async () => {
    const t = env.cY;
    const nature = NATURE(code);
    const entry = { entry_type: nature === 'RECEIVABLE' ? 'CREDIT' : 'DEBIT', nature, status: 'PENDING', is_third_party_funds: false };
    const other = { entry_type: nature === 'RECEIVABLE' ? 'DEBIT' : 'CREDIT', nature: nature === 'RECEIVABLE' ? 'PAYABLE' : 'RECEIVABLE', status: 'PENDING', is_third_party_funds: false };
    const ids = [
      await envK.ledger.insert(env, 'financial_entries', t, { ...entry, amount: '10.00', due_at: dayAt(1) }),
      await envK.ledger.insert(env, 'financial_entries', t, { ...entry, amount: '20.00', due_at: null }),
      await envK.ledger.insert(env, 'financial_entries', t, { ...other, amount: '30.00', due_at: dayAt(1) }), // outra natureza com vencimento: não conta como sem vencimento
    ];
    await refresh(t);
    await kpis(t);
    const got = await readKpi(t, code);
    assert.equal(got.status, 'INCOMPLETE', 'lançamento sem vencimento -> INCOMPLETE');
    assert.equal(got.value, null, 'valor nulo, nunca número enganoso');
    const [[snap]] = await env.admin.query(
      `SELECT s.value_numeric FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
        WHERE s.company_id = :c AND d.metric_code = :code ORDER BY s.revision_no DESC LIMIT 1`, { replacements: { c: t.companyId, code } });
    assert.equal(snap.value_numeric, null);
    assert.equal(await withoutDueDate(env, t, nature), 1);
    const entries = await envK.inTx(t, {}, (tx) => buildFinanceKpiEntries({ companyId: t.companyId, groupId: t.groupId }, env.asOf, tx));
    const detail = entries.find((e) => e.code === code).result.details;
    assert.deepEqual([detail.withoutDueDate, detail.reason], ['1', 'LANCAMENTO_SEM_VENCIMENTO'], 'o contador sai em details.withoutDueDate');
    await env.admin.transaction(async (transaction) => {
      await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
      await env.admin.query('DELETE FROM finance.financial_entries WHERE id IN (:ids)', { replacements: { ids }, transaction });
    });
    await refresh(t);
    await kpis(t);
    assert.equal((await readKpi(t, code)).status, 'OK', 'sem o lançamento sem vencimento o indicador volta a ter valor');
  });
}

test('m9d621 dinheiro de terceiros PENDING (aluguel a repassar) não aparece em nenhuma das 6 janelas', async () => {
  const [[row]] = await env.admin.query('SELECT * FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = :d', { replacements: { c: env.cX.companyId, d: env.asOf } });
  const total = ['payables_7d', 'payables_30d', 'payables_60d', 'receivables_7d', 'receivables_30d', 'receivables_60d'].map((f) => row[f]);
  assert.deepEqual(total, ['15000.00', '22000.00', '40500.00', '18000.00', '65000.00', '112500.00']);
  for (const code of scenario.CODES) assert.notEqual((await readKpi(env.cX, code)).value, null);
});

test('m9d621 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cX;
  // 03/11 23:30 SP = 04/11 02:30Z (já no dia seguinte em UTC): pertence a 03/11, o último dia da janela de 7 dias (28/10 a 03/11)
  await envK.ledger.insert(env, 'financial_entries', t, { entry_type: 'DEBIT', nature: 'PAYABLE', amount: '1.11', status: 'PENDING', due_at: '2026-11-04T02:30:00.000Z', is_third_party_funds: false });
  // 04/11 00:30 SP = 04/11 03:30Z: já é 04/11, fora da janela de 7 dias
  await envK.ledger.insert(env, 'financial_entries', t, { entry_type: 'DEBIT', nature: 'PAYABLE', amount: '2.22', status: 'PENDING', due_at: '2026-11-04T03:30:00.000Z', is_third_party_funds: false });
  await refresh(t);
  await kpis(t);
  assert.equal(money.cmp((await readKpi(t, 'fin.payables_7d')).value, '15001.11'), 0);
  assert.equal(money.cmp((await readKpi(t, 'fin.payables_30d')).value, '22003.33'), 0);
  const want = await windowFromSource(env, t, { nature: 'PAYABLE', asOf: env.asOf, days: 7 });
  assert.equal(want.value, '15001.11', 'o recálculo independente, na mão, concorda');
});

test('m9d621 replay do mesmo evento não altera o valor', async () => {
  const t = env.cX;
  const asserts = require('../_helpers/readModelAsserts');
  const event = { ...envK.event(t, 'finance.entry.created'), payloadJson: { id: envK.ledger.uuid() } };
  const snapshots = async () => (await env.admin.query(
    `SELECT d.metric_code, s.revision_no, s.value_numeric::text AS value FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
      WHERE s.company_id = :c AND d.metric_code IN (:codes) ORDER BY 1, 2`, { replacements: { c: t.companyId, codes: scenario.CODES } }))[0];
  const read = async () => ({ health: (await envK.healthRow(env, t)), snapshots: await snapshots() });
  const stripped = async () => { const r = await read(); delete r.health.refreshed_at; delete r.health.source_snapshot_at; return r; };
  await asserts.assertReplayIdempotent({ applyEvent: () => envK.inTx(t, { commit: true }, (tx) => require('../../../src/features/analytics/read-models').applyEvent(event, tx, { now: envK.NOW })), readRow: stripped });
  const got = await readKpi(t, 'fin.payables_7d');
  assert.equal(money.cmp(got.value, '15001.11'), 0);
});
