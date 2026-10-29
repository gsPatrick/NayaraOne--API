'use strict';

// M9-D624 — KPI fin.reconciliations_pending: reprodução a partir dos registros-fonte, qualidade (extrato antigo), fuso de São Paulo e parâmetros.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env624 = require('../_helpers/m9d624Env');
const { reconciliationsFromSource } = require('../_helpers/m9d624Oracle');

const { bankTx, reconcile, statementImport, refresh, kpis, readKpi, dayAt, healthRow, setSetting } = env624;
const CODE = 'fin.reconciliations_pending';
let env;
before(async () => { env = await env624.setup(); });
after(() => env624.teardown(env));

async function computeNow(t) {
  await refresh(t);
  return kpis(t);
}

test('m9d624 reproduz fin.reconciliations_pending a partir dos registros-fonte', async () => {
  const t = env.cX;
  const [a1, a2] = [env624.ledger.uuid(), env624.ledger.uuid()];
  const lines = [[a1, '1000.00', -1], [a1, '-2300.50', -3], [a1, '500.25', -6], [a2, '4000.00', -8], [a2, '-999.25', -2], [a2, '1500.00', -10]];
  const ids = [];
  for (const [account, amount, offset] of lines) ids.push(await bankTx(env, t, { account, amount, date: dayAt(offset), createdAt: dayAt(-1) }));
  await reconcile(env, t, ids[5]); // conciliada: não entra
  await bankTx(env, t, { account: a1, amount: '777.00', date: dayAt(3), createdAt: dayAt(-1) }); // depois da data-base: não entra
  await statementImport(env, t, { account: a1, createdAt: dayAt(-1) });
  await computeNow(t);
  const want = await reconciliationsFromSource(env, t, env.asOf);
  assert.equal(want.count, '5');
  const main = await readKpi(t, CODE);
  assert.equal(Number(main.value), Number(want.count), 'contagem');
  assert.equal(main.status, 'OK');
  assert.equal(main.unit, 'COUNT');
  assert.equal(main.version, 1);
  const amount = await readKpi(t, CODE, { dimensionKey: 'valor_brl' });
  assert.equal(Number(amount.value).toFixed(2), Number(want.amount).toFixed(2), 'soma dos valores absolutos, centavo a centavo');
  assert.equal(amount.unit, 'BRL');
  const age = await readKpi(t, CODE, { dimensionKey: 'mais_antiga_dias' });
  assert.equal(String(Number(age.value)), want.oldestDays);
  assert.equal(age.unit, 'DAYS');
  for (const [band, n] of Object.entries(want.bands)) assert.equal(String(Number((await readKpi(t, CODE, { dimensionKey: `faixa:${band}` })).value)), String(n), `faixa ${band}`);
  for (const [account, n] of Object.entries(want.accounts)) assert.equal(String(Number((await readKpi(t, CODE, { dimensionKey: `conta:${account}` })).value)), String(n), 'conta');
});

test('m9d624 exemplo do livro: 14 transações, 9.300,00 e a mais antiga com 6 dias', async () => {
  const t = env.cY;
  const account = env624.ledger.uuid();
  await statementImport(env, t, { account, createdAt: dayAt(-1) });
  const amounts = ['300.00', '300.00', '300.00', '300.00', '300.00', '300.00', '300.00', '300.00', '300.00', '300.00', '300.00', '300.00', '300.00', '5400.00'];
  for (const [i, amount] of amounts.entries()) await bankTx(env, t, { account, amount: i % 2 ? `-${amount}` : amount, date: dayAt(i === 0 ? -6 : -(i % 3)), createdAt: dayAt(-1) });
  await computeNow(t);
  const main = await readKpi(t, CODE);
  assert.equal(Number(main.value), 14);
  assert.equal(Number((await readKpi(t, CODE, { dimensionKey: 'valor_brl' })).value), 9300);
  assert.equal(Number((await readKpi(t, CODE, { dimensionKey: 'mais_antiga_dias' })).value), 6);
});

test('m9d624 fin.reconciliations_pending fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  const t = env.cX;
  const account = env624.ledger.uuid();
  await statementImport(env, t, { account, createdAt: dayAt(-1) });
  await refresh(t);
  await kpis(t);
  assert.equal((await readKpi(t, CODE)).status, 'OK', 'com extrato de 1 dia o KPI vale');
  // o extrato mais novo tem 5 dias e o limite padrão é 3: troca-se a fonte para uma empresa com importação antiga
  const old = env.cY;
  await env.admin.query("DELETE FROM finance.bank_statement_imports WHERE company_id = :c", { replacements: { c: old.companyId } }).catch(() => {});
  await env.admin.query("UPDATE finance.bank_transactions SET created_at = :d WHERE company_id = :c", { replacements: { c: old.companyId, d: dayAt(-5) } });
  await refresh(old);
  await kpis(old);
  const degraded = await readKpi(old, CODE);
  assert.equal(degraded.status, 'DEGRADED');
  assert.equal(degraded.value, null, 'valor nulo, nunca número enganoso');
  assert.ok(degraded.sourceSnapshotAt && degraded.refreshedAt && Array.isArray(degraded.sourceRefs));
});

test('m9d624 o limite de idade do extrato é parâmetro do administrador (analytics.qualidade.max_idade_extrato_dias)', async () => {
  const t = env.cY;
  assert.equal((await readKpi(t, CODE)).status, 'DEGRADED');
  await setSetting(env, t, 'analytics.qualidade.max_idade_extrato_dias', 7);
  await computeNow(t);
  const ok = await readKpi(t, CODE);
  assert.equal(ok.status, 'OK', 'com limite de 7 dias o extrato de 5 dias vale');
  assert.equal(Number(ok.value), 14);
  await setSetting(env, t, 'analytics.qualidade.max_idade_extrato_dias', 3);
  await computeNow(t);
  assert.equal((await readKpi(t, CODE)).status, 'DEGRADED');
  assert.ok((await readKpi(t, CODE)).revisionNo >= 3, 'cada mudança de estado entra como nova revisão, sem apagar a anterior');
});

test('m9d624 as faixas de idade são parâmetro (analytics.conciliacao.faixas_idade_dias)', async () => {
  const t = env.cY;
  await setSetting(env, t, 'analytics.qualidade.max_idade_extrato_dias', 7);
  await setSetting(env, t, 'analytics.conciliacao.faixas_idade_dias', '1,4');
  await computeNow(t);
  const want = await reconciliationsFromSource(env, t, env.asOf, [1, 4]);
  for (const [band, n] of Object.entries(want.bands)) assert.equal(String(Number((await readKpi(t, CODE, { dimensionKey: `faixa:${band}` })).value)), String(n), `faixa ${band}`);
  assert.deepEqual(Object.keys(want.bands).every((b) => /^(0-1|2-4|5\+)$/.test(b)), true);
});

test('m9d624 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cY;
  await setSetting(env, t, 'analytics.qualidade.max_idade_extrato_dias', 30);
  const before = Number((await readKpi(t, CODE)).value);
  const account = env624.ledger.uuid();
  await bankTx(env, t, { account, amount: '10.00', date: '2026-10-29T02:30:00Z', createdAt: dayAt(-1) }); // 23:30 de 28/10 em SP: entra na data-base 28
  await bankTx(env, t, { account, amount: '20.00', date: '2026-10-29T03:30:00Z', createdAt: dayAt(-1) }); // 00:30 de 29/10 em SP: só na data-base 29
  await computeNow(t);
  assert.equal(Number((await readKpi(t, CODE)).value), before + 1);
  assert.equal(Number((await readKpi(t, CODE, { dimensionKey: 'valor_brl' })).value), 9300 + 10);
  const want = await reconciliationsFromSource(env, t, env.asOf);
  assert.equal(want.count, String(before + 1));
});

test('m9d624 replay do mesmo evento não altera o valor e não cria revisão', async () => {
  const t = env.cY;
  const ev = env624.event(t);
  const apply = () => env624.inTx(t, { commit: true }, (tx) => require('../../../src/features/analytics/read-models').applyEvent(ev, tx, { now: env.now }));
  await apply();
  await kpis(t);
  const before = await readKpi(t, CODE);
  const rowBefore = await healthRow(env, t);
  const second = await apply();
  assert.equal(second.upserted, 0, 'a segunda entrega é ignorada');
  const written = await kpis(t);
  assert.equal(written.written, 0, 'nada novo para gravar');
  const after = await readKpi(t, CODE);
  assert.equal(after.value, before.value);
  assert.equal(after.revisionNo, before.revisionNo);
  assert.deepEqual(await healthRow(env, t), rowBefore);
});
