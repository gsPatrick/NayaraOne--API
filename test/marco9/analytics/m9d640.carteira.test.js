'use strict';

// M9-D640 — rent.active_contracts, rent.vacancy e rent.delinquency: reprodução a partir dos registros-fonte (exemplos do livro), regras de qualidade, parâmetros do administrador,
// fuso de São Paulo e a consistência da inadimplência da locação com a do Financeiro (fin.overdue_receivables, M9-D622).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d640Env');
const sc = require('../_helpers/m9d640Scenario');
const oracle = require('../_helpers/m9d640Oracle');
const money = require('../../../src/features/analytics/metrics/formulas/money');

const ACTIVE = 'rent.active_contracts';
const VACANCY = 'rent.vacancy';
const DELINQ = 'rent.delinquency';
const same = (a, b, msg) => assert.equal(money.cmp(a, b), 0, `${msg}: ${a} x ${b}`);
const dim = (t, code, key) => kit.dimension(t, code, key);
const result = async (t, code) => (await kit.kpis(t)).rent.kpis[code];
let env;
let cart;
before(async () => {
  env = await kit.setup();
  cart = await sc.carteira(env, env.cX);
  await sc.inadimplencia(env, env.cX, cart);
  await kit.rebuild(env.cX);
  await kit.kpis(env.cX);
});
after(() => kit.teardown(env));

test('m9d640 reproduz rent.active_contracts a partir dos registros-fonte', async () => {
  const t = env.cX;
  const want = await oracle.activeFromSource(env, t);
  assert.deepEqual([want.count, want.rent, want.suspended], [85, '212500.00', 1], 'exemplo do livro: 85 contratos, aluguel mensal 212.500,00; o suspenso fica à parte');
  const got = await kit.readKpi(t, ACTIVE);
  assert.deepEqual([got.status, got.unit, got.version, got.valueNature], ['OK', 'COUNT', 1, 'ACTUAL']);
  assert.equal(Number(got.value), want.count);
  same(await dim(t, ACTIVE, 'aluguel_mensal_brl'), want.rent, 'aluguel mensal vigente');
  assert.equal(Number(await dim(t, ACTIVE, 'suspensos_qtd')), want.suspended);
  assert.deepEqual(['ate_2000', '2001-5000', '5001-10000', 'acima_10000'].map((l) => `faixa_valor:${l}`), ['faixa_valor:ate_2000', 'faixa_valor:2001-5000', 'faixa_valor:5001-10000', 'faixa_valor:acima_10000']);
  assert.deepEqual([await dim(t, ACTIVE, 'faixa_valor:ate_2000'), await dim(t, ACTIVE, 'faixa_valor:2001-5000'), await dim(t, ACTIVE, 'faixa_valor:5001-10000'), await dim(t, ACTIVE, 'faixa_valor:acima_10000')].map(Number), [20, 60, 5, 0]);
  assert.equal(Number(await dim(t, ACTIVE, `imovel:${cart.props[0]}`)), 1, 'por imóvel');
  same(await dim(t, ACTIVE, `imovel:${cart.props[80]}:aluguel_brl`), '6500.00', 'aluguel do imóvel');
  assert.equal(Number(await dim(t, ACTIVE, `proprietario:${cart.o1}`)), 40, 'por proprietário (o de 100% de 40 imóveis)');
  assert.equal(Number(await dim(t, ACTIVE, `proprietario:${cart.o3}`)), 5, 'o proprietário principal é o de maior participação');
  assert.equal(got.sourceRefs[0].table, 'legal.contracts');
  assert.equal(got.sourceRefs[0].count, want.count, 'o filtro da origem reproduz o mesmo número');
});

test('m9d640 rent.active_contracts fica DEGRADED com valor nulo quando a regra de qualidade falha (contrato ACTIVE sem valor de aluguel)', async () => {
  const t = env.cY;
  await sc.contract(env, t, { value: '2000.00', property: await sc.property(env, t) });
  await sc.contract(env, t, { value: null, property: await sc.property(env, t) });
  await kit.rebuild(t);
  const out = await result(t, ACTIVE);
  assert.deepEqual([out.status, out.value, out.details.reason, out.details.withoutRent], ['DEGRADED', null, 'CONTRATO_SEM_VALOR_DE_ALUGUEL', '1']);
  assert.equal((await kit.readKpi(t, ACTIVE)).value, null, 'nunca um número enganoso');
});

test('m9d640 as faixas de valor do aluguel vêm do administrador (analytics.locacao.faixas_valor_aluguel)', async () => {
  const t = env.cX;
  await kit.setSetting(env, t, 'analytics.locacao.faixas_valor_aluguel', '1500,3000');
  const out = await result(t, ACTIVE);
  const bands = Object.fromEntries(out.dimensions.filter((d) => d.key.startsWith('faixa_valor:')).map((d) => [d.key, d.value]));
  assert.deepEqual(bands, { 'faixa_valor:ate_1500': '20', 'faixa_valor:1501-3000': '60', 'faixa_valor:acima_3000': '5' });
  await kit.setSetting(env, t, 'analytics.locacao.faixas_valor_aluguel', '2000,5000,10000');
});

test('m9d640 reproduz rent.vacancy a partir dos registros-fonte', async () => {
  const t = env.cX;
  const want = await oracle.vacancyFromSource(env, t);
  assert.deepEqual([want.rentable, want.rented, want.vacant, want.pct], [91, 85, 6, '6.59'], 'exemplo do livro: 91 locáveis, 85 alugados, 6 vagos => 6,59%');
  const got = await kit.readKpi(t, VACANCY);
  assert.deepEqual([got.status, got.unit, got.version], ['OK', 'PERCENT', 1]);
  same(got.value, want.pct, 'vacância');
  assert.deepEqual([await dim(t, VACANCY, 'locaveis_qtd'), await dim(t, VACANCY, 'alugados_qtd'), await dim(t, VACANCY, 'suspensos_qtd'), await dim(t, VACANCY, 'vagos_qtd')].map(Number), [91, 85, 1, 5]);
  same(await dim(t, VACANCY, 'bairro:Centro'), '0.00', 'os 60 imóveis do Centro estão alugados');
  same(await dim(t, VACANCY, 'bairro:Jardins'), money.percent(6, 31).value, 'Jardins: 31 locáveis e 6 sem contrato ativo');
  same(await dim(t, VACANCY, 'tipo:COMMERCIAL'), money.percent(30 - 30, 30).value || '0.00', 'tipo');
  assert.equal(got.sourceRefs[0].table, 'real_estate.properties');
  assert.equal(got.sourceRefs[0].count, want.rentable, 'o filtro da origem conta os mesmos locáveis');
});

test('m9d640 rent.vacancy fica DEGRADED com valor nulo quando a regra de qualidade falha (imóvel locável sem situação definida)', async () => {
  const t = env.cY;
  const c = await sc.property(env, t, { status: 'RENTED' });
  await sc.contract(env, t, { property: c, value: '1000.00' });
  await sc.offer(env, t, await sc.property(env, t));
  await kit.rebuild(t);
  const ok = await result(t, VACANCY);
  const want = await oracle.vacancyFromSource(env, t);
  assert.deepEqual([ok.status, ok.value, want.pct], ['OK', '25.00', '25.00'], '3 contratos ativos em 4 locáveis (os dois da prova anterior ficam na empresa) e a vacância refeita na fonte concorda');
  await sc.offer(env, t, await sc.property(env, t, { status: 'XYZ' })); // oferta de locação e situação desconhecida
  await kit.rebuild(t);
  const bad = await result(t, VACANCY);
  assert.deepEqual([bad.status, bad.value, bad.details.reason, bad.details.statusUndefined], ['DEGRADED', null, 'IMOVEL_SEM_SITUACAO', '1']);
  assert.equal((await oracle.vacancyFromSource(env, t)).undefinedStatus, 1);
});

test('m9d640 rent.vacancy com total locável zero fica INCOMPLETE e sem valor', async () => {
  const out = (await kit.kpis(env.cY));
  assert.ok(out);
  const t = (await kit.newCompany(env, 'Z'));
  await kit.rebuild(t);
  const r = (await kit.kpis(t)).rent.kpis[VACANCY];
  assert.deepEqual([r.status, r.value, r.details.reason], ['INCOMPLETE', null, 'TOTAL_LOCAVEL_ZERO']);
});

test('m9d640 reproduz rent.delinquency a partir dos registros-fonte', async () => {
  const t = env.cX;
  const want = await oracle.delinquencyFromSource(env, t, env.asOf);
  assert.deepEqual([want.inWindow, want.billed, want.rate, want.outside, want.overdue], ['8200.00', '200000.00', '4.10', '700.00', '8900.00'], 'exemplo do livro: vencido 8.200,00; cobrado 200.000,00 => 4,10%');
  const got = await kit.readKpi(t, DELINQ);
  assert.deepEqual([got.status, got.unit, got.version, got.valueNature], ['OK', 'PERCENT', 1, 'ACTUAL']);
  same(got.value, want.rate, 'taxa');
  same(await dim(t, DELINQ, 'vencido_brl'), want.overdue, 'valor vencido absoluto');
  same(await dim(t, DELINQ, 'vencido_janela_brl'), want.inWindow, 'vencido na janela');
  same(await dim(t, DELINQ, 'cobrado_brl'), want.billed, 'cobrado');
  same(await dim(t, DELINQ, 'fora_janela_brl'), want.outside, 'details.overdueOutsideWindow');
  same(await dim(t, DELINQ, 'faixa:1-30'), '2.60', 'faixa 1-30');
  same(await dim(t, DELINQ, 'faixa:31-60'), '1.50', 'faixa 31-60');
  same(await dim(t, DELINQ, `contrato:${cart.contracts[0]}`), '2.60', 'contrato');
  same(await dim(t, DELINQ, `imovel:${cart.props[1]}`), '1.50', 'imóvel');
  assert.equal(got.sourceRefs[0].table, 'finance.financial_entries');
  assert.equal(got.sourceRefs[0].count, 3, 'a base da taxa: o vencido de 5.200,00, o de 3.000,00 e o pago de 191.800,00');
});

test('m9d640 rent.delinquency: cobrança sem contrato de locação fica só no Financeiro e entra em details.unlinked (não rebaixa o KPI)', async () => {
  // DI-D640-3: a regra de qualidade do texto manda "fica só no KPI financeiro e entra em details.unlinked", sem rebaixar; o que se prova é o que a regra manda
  const t = env.cX;
  const want = await oracle.delinquencyFromSource(env, t, env.asOf);
  assert.deepEqual([want.unlinked, want.unlinkedCount], ['4200.00', 2]);
  const out = await result(t, DELINQ);
  assert.equal(out.status, 'OK');
  assert.deepEqual([out.details.unlinked.amount, out.details.unlinked.count], ['4200.00', '2']);
  same(await dim(t, DELINQ, 'nao_vinculado_brl'), '4200.00', 'não vinculado');
  assert.equal(Number(await dim(t, DELINQ, 'nao_vinculado_qtd')), 2);
});

test('m9d640 rent.delinquency fica INCOMPLETE com valor nulo quando a regra de qualidade falha (cobrança de locação sem vencimento ou cobrado zero)', async () => {
  const t = env.cY;
  const r0 = await result(t, DELINQ);
  assert.deepEqual([r0.status, r0.value, r0.details.reason], ['INCOMPLETE', null, 'BASE_ZERO'], 'sem nada cobrado a base é zero');
  const contractId = (await env.admin.query("SELECT id FROM legal.contracts WHERE company_id = :c AND contract_type = 'LEASE' LIMIT 1", { replacements: { c: t.companyId } }))[0][0].id;
  await sc.entry(env, t, { amount: '100.00', due: sc.dayAt(-3), contract: contractId });
  await sc.entry(env, t, { amount: '50.00', due: null, contract: contractId });
  await kit.rebuild(t);
  const r1 = await result(t, DELINQ);
  assert.deepEqual([r1.status, r1.value, r1.details.reason, r1.details.withoutDueDate], ['INCOMPLETE', null, 'LANCAMENTO_SEM_VENCIMENTO', '1']);
  assert.equal((await kit.readKpi(t, DELINQ)).value, null);
});

test('m9d640 a inadimplência da locação é consistente com a do Financeiro: vencido da locação + não vinculado = vencido do Financeiro e nunca passa dele', async () => {
  const t = env.cX;
  const [[fin]] = await env.admin.query("SELECT overdue_amount::text AS overdue, overdue_amount_in_window_90d::text AS in_window, receivables_base_90d::text AS base FROM analytics.rm_finance_health WHERE company_id = :c AND as_of_date = :d", { replacements: { c: t.companyId, d: env.asOf } });
  const [[rent]] = await env.admin.query("SELECT overdue_amount::text AS overdue, overdue_amount_in_window_90d::text AS in_window, billed_90d::text AS billed, unlinked_amount::text AS unlinked FROM analytics.rm_rental_arrears WHERE company_id = :c AND as_of_date = :d", { replacements: { c: t.companyId, d: env.asOf } });
  same(fin.overdue, await oracle.financeOverdueFromSource(env, t, env.asOf), 'o Financeiro refeito na fonte');
  same(money.add(rent.overdue, rent.unlinked), fin.overdue, 'o mesmo lançamento a receber está nos dois, com recortes diferentes');
  assert.ok(money.cmp(rent.overdue, fin.overdue) <= 0, 'o vencido de locação nunca passa do vencido do Financeiro');
  assert.ok(money.cmp(rent.in_window, fin.in_window) <= 0 && money.cmp(rent.billed, fin.base) <= 0);
  const finRate = money.percent(fin.in_window, fin.base).value;
  same(money.sub(finRate, (await kit.readKpi(t, DELINQ)).value), money.sub(money.percent(fin.in_window, fin.base).value, '4.10'), 'a diferença entre as duas taxas é a do recorte');
  assert.ok(money.cmp(finRate, '4.10') > 0, 'a taxa do Financeiro é maior: inclui a cobrança que não é de locação');
});

test('m9d640 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  const t = env.cY;
  const contractId = (await env.admin.query("SELECT id FROM legal.contracts WHERE company_id = :c AND contract_type = 'LEASE' LIMIT 1", { replacements: { c: t.companyId } }))[0][0].id;
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await env.admin.query('DELETE FROM finance.financial_entries WHERE company_id = :c AND due_at IS NULL', { replacements: { c: t.companyId }, transaction });
  });
  const before = (await oracle.delinquencyFromSource(env, t, env.asOf)).overdue; // os 100,00 vencidos da prova anterior
  // 27/10 23:30 SP (28/10 02:30Z) venceu em 27/10: está vencido; 28/10 00:30 SP (03:30Z) e 28/10 23:30 SP (29/10 02:30Z) vencem hoje
  await sc.entry(env, t, { amount: '1.11', due: '2026-10-28T02:30:00.000Z', contract: contractId });
  await sc.entry(env, t, { amount: '2.22', due: '2026-10-28T03:30:00.000Z', contract: contractId });
  await sc.entry(env, t, { amount: '4.44', due: '2026-10-29T02:30:00.000Z', contract: contractId });
  await kit.rebuild(t);
  const want = await oracle.delinquencyFromSource(env, t, env.asOf);
  same(money.sub(want.overdue, before), '1.11', 'o recálculo independente, na mão: só o que venceu em 27/10 entrou no vencido');
  const out = await result(t, DELINQ);
  same(out.dimensions.find((d) => d.key === 'vencido_brl').value, want.overdue, 'o KPI concorda com o recálculo');
});

test('m9d640 isolamento entre empresas no KPI', async () => {
  const [x, y] = [env.cX, env.cY];
  for (const code of kit.CODES) {
    await assert.rejects(kit.sup ? Promise.resolve() : require('../../analytics.m9d603.support').inTx(y, {}, (tx) => kit.registry.readMetricAsOf(kit.ctxOf(y), { metricCode: code, scopeType: 'COMPANY', scopeId: x.companyId, asOfDate: env.asOf }, tx)),
      (e) => e.statusCode === 404, 'o escopo de outra empresa não devolve nada (RLS)');
  }
  assert.equal(Number((await kit.readKpi(x, ACTIVE)).value), 85);
});
