'use strict';

// NAY Financeira (Caderno Marco 4 §18; DoD "NAY sem permissão de execução financeira"; Guia §13).
// Postgres real, NODE_ENV=test. Os testes de serviço rodam numa empresa NOVA e real (dados
// determinísticos) dentro de transação com rollback; o teste HTTP sobe o app e usa JWT real.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.NAY_FIN_HTTP_TEST_PORT || '21641';

const app = require('../app'); // eslint-disable-line no-unused-vars
const {
  sequelize,
  getSeedTenant,
  withRollbackTenantTransaction,
  withTenantTransaction,
  uniqueSuffix,
  createTestCostCenter,
  createTestResultCenter,
} = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { Company } = require('../src/models');
const { createFinancialEntry } = require('../src/features/finance/financialEntries.service');
const { createBankAccount } = require('../src/features/finance/bankAccounts.service');
const { createBankTransaction } = require('../src/features/finance/bankTransactions.service');
const { getFinanceInsights } = require('../src/features/finance/financeNay.service');

let tenant;
let fresh; // empresa nova, mesmo grupo, sem nenhum dado financeiro
let baseUrl;

async function realCompany(groupId, name) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true)", { replacements: { g: groupId }, transaction });
    const [company] = await Company.findOrCreate({ where: { groupId, name }, defaults: { groupId, name }, transaction });
    return company;
  });
}

before(async () => {
  tenant = await getSeedTenant();
  const company = await realCompany(tenant.groupId, `NAY-FIN empresa de teste ${uniqueSuffix()}`);
  fresh = { groupId: tenant.groupId, companyId: company.id, userId: tenant.userId };
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

const DAY = 86400000;
const NATUREZAS = new Set(['REALIZADO', 'PREVISTO', 'ESTIMADO']);

function monthsAgo(n) {
  const d = new Date();
  d.setUTCDate(15);
  d.setUTCHours(15, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
}

async function entry(t, ctx, data) {
  return createFinancialEntry({ groupId: ctx.groupId, companyId: ctx.companyId, ...data }, ctx.userId, t);
}

// Marca como liquidado numa data escolhida (status/settled_at são colunas mutáveis e auditadas
// pelo trigger do ledger); o objetivo aqui é ter "realizado" em dois meses para a variação.
async function markSettled(t, id, when) {
  await sequelize.query("UPDATE finance.financial_entries SET status = 'SETTLED', settled_at = :w WHERE id = :id", {
    replacements: { w: when, id },
    transaction: t,
  });
}

async function seedScenario(t) {
  const ccA = await createTestCostCenter(fresh, t, `A${uniqueSuffix()}`);
  const ccB = await createTestCostCenter(fresh, t, `B${uniqueSuffix()}`);
  const rc = await createTestResultCenter(fresh, t);
  const now = new Date();
  // realizado: A 100 -> 300 (cresce 200); B 80 -> 50 (cai)
  const settled = [
    [ccA, 100, monthsAgo(1)],
    [ccA, 300, now],
    [ccB, 80, monthsAgo(1)],
    [ccB, 50, now],
  ];
  for (const [cc, amount, when] of settled) {
    const e = await entry(t, fresh, { entryType: 'DEBIT', nature: 'PAYABLE', amount, description: `NAY-FIN pago ${amount}`, dueAt: when, costCenterId: cc.id });
    await markSettled(t, e.id, when);
  }
  const r1 = await entry(t, fresh, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, description: 'NAY-FIN aluguel vencido 10d', dueAt: new Date(Date.now() - 10 * DAY), resultCenterId: rc.id });
  const r2 = await entry(t, fresh, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 500, description: 'NAY-FIN aluguel vencido 45d', dueAt: new Date(Date.now() - 45 * DAY), resultCenterId: rc.id });
  const p1 = await entry(t, fresh, { entryType: 'DEBIT', nature: 'PAYABLE', amount: 200, description: 'NAY-FIN fornecedor em 3d', dueAt: new Date(Date.now() + 3 * DAY), costCenterId: ccA.id });
  const p2 = await entry(t, fresh, { entryType: 'DEBIT', nature: 'PAYABLE', amount: 150, description: 'NAY-FIN fornecedor vencido', dueAt: new Date(Date.now() - 2 * DAY), costCenterId: ccB.id });
  return { ccA, ccB, r1, r2, p1, p2 };
}

async function fingerprint(t) {
  const [row] = await sequelize.query(
    `SELECT
       (SELECT md5(COALESCE(string_agg(id::text || status || amount::text || COALESCE(settled_at::text,'') || COALESCE(bank_account_id::text,''), ',' ORDER BY id), '')) FROM finance.financial_entries) AS entries,
       (SELECT COUNT(*) FROM finance.payment_intents)::int AS intents,
       (SELECT COUNT(*) FROM finance.period_closures)::int AS closures,
       (SELECT COUNT(*) FROM finance.bank_transactions)::int AS bank_tx,
       (SELECT COUNT(*) FROM finance.reconciliations)::int AS recs,
       (SELECT COUNT(*) FROM finance.approval_requests)::int AS approvals,
       (SELECT md5(COALESCE(string_agg(id::text || status || COALESCE(bank_code,'') || COALESCE(account_number,'') || COALESCE(pix_key,''), ',' ORDER BY id), '')) FROM finance.bank_accounts) AS accounts`,
    { transaction: t, type: sequelize.QueryTypes.SELECT }
  );
  return row;
}

test('NAY-FIN-01: explica fluxo de caixa, variação mês a mês, inadimplência, necessidade de capital e anomalias com natureza e fonte em cada número', async () => {
  await withRollbackTenantTransaction(fresh, async (t) => {
    await seedScenario(t);
    const out = await getFinanceInsights(fresh, fresh.userId, t);
    assert.equal(out.agente, 'NAY Financeira');
    assert.equal(out.metodo, 'RULE_BASED');
    for (const key of ['fluxoCaixa', 'variacoes', 'inadimplencia', 'necessidadeCapital', 'anomalias']) {
      const sec = out.explicacoes[key];
      assert.ok(sec && sec.texto && sec.numeros.length > 0, key);
      for (const n of sec.numeros) {
        assert.ok(NATUREZAS.has(n.natureza), `${key}.${n.indicador} natureza`);
        assert.ok(Array.isArray(n.fontes) && n.fontes.length > 0, `${key}.${n.indicador} fontes`);
      }
    }
    const byName = Object.fromEntries(out.explicacoes.variacoes.numeros.map((n) => [n.indicador, n.valor]));
    const pagos = Object.entries(byName).filter(([k]) => k.startsWith('pago_')).map(([, val]) => val);
    assert.deepEqual(pagos, [350, 180], 'pago no mês atual (300+50) e no anterior (100+80)');
    assert.equal(byName.variacaoResultado, -170);
    const inad = Object.fromEntries(out.explicacoes.inadimplencia.numeros.map((n) => [n.indicador, n]));
    assert.equal(inad.recebiveisVencidos.valor, 1500);
    assert.equal(inad.recebiveisVencidos.natureza, 'REALIZADO');
    assert.equal(out.explicacoes.necessidadeCapital.numeros[0].natureza, 'ESTIMADO');
    assert.equal(out.explicacoes.fluxoCaixa.numeros.find((n) => n.indicador === 'aPagar7d').natureza, 'PREVISTO');
    assert.equal(out.fontes.readModel, 'finance.weeklyHealthReport');
    assert.equal(out.fontes.sourceSnapshotAt, out.sourceSnapshotAt);
    assert.equal(out.fontes.regras[0].codigo, 'FIN-005');
    assert.ok(out.fontes.tabelas.includes('finance.financial_entries'));
    assert.match(out.limites, /não cria ledger, não paga, não altera favorecido, não fecha período/);
  });
});

test('NAY-FIN-02: sugere cobrança (até 30 dias) e renegociação (mais de 30 dias), redução de custo no centro que mais cresceu e prioriza pagáveis vencidos', async () => {
  await withRollbackTenantTransaction(fresh, async (t) => {
    const s = await seedScenario(t);
    const out = await getFinanceInsights(fresh, fresh.userId, t);
    assert.deepEqual(out.sugestoes.cobranca.map((x) => x.financialEntryId), [s.r1.id]);
    assert.equal(out.sugestoes.cobranca[0].diasEmAtraso, 10);
    assert.deepEqual(out.sugestoes.renegociacao.map((x) => x.financialEntryId), [s.r2.id]);
    assert.ok(out.sugestoes.renegociacao[0].diasEmAtraso >= 44);
    assert.equal(out.sugestoes.reducaoCusto.length, 1, 'só o centro A cresceu');
    assert.equal(out.sugestoes.reducaoCusto[0].costCenterId, s.ccA.id);
    assert.equal(out.sugestoes.reducaoCusto[0].crescimento, 200);
    assert.deepEqual(out.sugestoes.priorizacaoPagaveis.map((x) => x.financialEntryId), [s.p2.id, s.p1.id], 'vencido primeiro');
    assert.equal(out.sugestoes.priorizacaoPagaveis[0].vencido, true);
    for (const list of Object.values(out.sugestoes)) for (const item of list) assert.ok(item.razao && NATUREZAS.has(item.natureza));
  });
});

test('NAY-FIN-03: dados incompletos — sem conta, conta sem extrato do mês e extrato sem conciliação — dão conclusaoParcial=true com o motivo', async () => {
  await withRollbackTenantTransaction(fresh, async (t) => {
    const semConta = await getFinanceInsights(fresh, fresh.userId, t);
    assert.equal(semConta.conclusaoParcial, true);
    assert.ok(semConta.motivosParcial.some((m) => /Nenhuma conta bancária/.test(m)), JSON.stringify(semConta.motivosParcial));

    const acc = await createBankAccount({ groupId: fresh.groupId, companyId: fresh.companyId, bankCode: '748', agency: '0001', accountNumber: `9${Date.now() % 1000000}` }, fresh.userId, t);
    const semExtrato = await getFinanceInsights(fresh, fresh.userId, t);
    assert.equal(semExtrato.conclusaoParcial, true);
    assert.ok(semExtrato.motivosParcial.some((m) => /1 conta\(s\) bancária\(s\) em uso sem extrato importado/.test(m)), JSON.stringify(semExtrato.motivosParcial));

    await createBankTransaction({ groupId: fresh.groupId, companyId: fresh.companyId, bankAccountId: acc.id, externalTransactionId: `NAYFIN-${uniqueSuffix()}`, amount: 1234.56, transactionDate: new Date(), description: 'NAY-FIN extrato' }, fresh.userId, t);
    const comExtrato = await getFinanceInsights(fresh, fresh.userId, t);
    assert.ok(!comExtrato.motivosParcial.some((m) => /sem extrato importado/.test(m)), 'motivo de extrato some');
    assert.ok(comExtrato.motivosParcial.some((m) => /sem conciliação/.test(m)), 'extrato sem conciliação ainda torna parcial');
    assert.equal(comExtrato.explicacoes.fluxoCaixa.numeros.find((n) => n.indicador === 'caixaLivre').valor, 1234.56);
  });
});

test('NAY-FIN-04: não executa nada — lançamentos, intenções, fechamentos, extratos, conciliações, aprovações e contas bancárias idênticos depois de chamar a NAY; só ai_runs cresce', async () => {
  await withRollbackTenantTransaction(fresh, async (t) => {
    await seedScenario(t);
    const before = await fingerprint(t);
    const [{ runs: runsBefore }] = await sequelize.query("SELECT COUNT(*)::int AS runs FROM ai.ai_runs WHERE agent_name = 'NAY_FINANCEIRA'", { transaction: t, type: sequelize.QueryTypes.SELECT });
    await getFinanceInsights(fresh, fresh.userId, t);
    await getFinanceInsights(fresh, fresh.userId, t);
    const afterFp = await fingerprint(t);
    assert.deepEqual(afterFp, before);
    const [{ runs }] = await sequelize.query("SELECT COUNT(*)::int AS runs FROM ai.ai_runs WHERE agent_name = 'NAY_FINANCEIRA'", { transaction: t, type: sequelize.QueryTypes.SELECT });
    assert.equal(runs, runsBefore + 2, 'cada execução fica auditada em ai.ai_runs');
  });
});

test('NAY-FIN-05 (HTTP): GET /finance/nay/insights responde 200 com finance:read, 403 sem; outra empresa não vê os recebíveis da primeira', async () => {
  const marker = `NAY-FIN HTTP ${uniqueSuffix()}`;
  const created = await withTenantTransaction(tenant, async (t) => {
    const rc = await createTestResultCenter(tenant, t);
    return entry(t, tenant, { entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 987654.32, description: marker, dueAt: new Date(Date.now() - 5 * DAY), resultCenterId: rc.id });
  });
  const token = (ctx, permissions) =>
    signAccessToken({ sub: tenant.userId, group_id: ctx.groupId, company_id: ctx.companyId, roles: ['admin'], permissions });
  const call = async (tk) => {
    const res = await fetch(`${baseUrl}/finance/nay/insights`, { headers: { Authorization: `Bearer ${tk}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const ok = await call(token(tenant, ['finance:read']));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.agente, 'NAY Financeira');
  assert.ok(ok.body.data.sugestoes.cobranca.some((x) => x.financialEntryId === created.id), 'recebível vencido da própria empresa aparece');

  const denied = await call(token(tenant, ['legal:read']));
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'PERMISSION_DENIED');

  const other = await call(token(fresh, ['finance:read']));
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const all = [...other.body.data.sugestoes.cobranca, ...other.body.data.sugestoes.renegociacao];
  assert.ok(!all.some((x) => x.financialEntryId === created.id || x.descricao === marker), 'outra empresa não enxerga');
  assert.equal(other.body.data.explicacoes.inadimplencia.numeros[0].valor, 0);
});
