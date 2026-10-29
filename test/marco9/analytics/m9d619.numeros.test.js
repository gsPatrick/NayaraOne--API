'use strict';

// M9-D619 — os números de cada read model contra o cálculo independente, pelos eventos reais aplicados pelo worker do BI.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biObrasJuridicoEnv');
const sc = require('../_helpers/m9d619Scenario');
const o = require('../_helpers/m9d618Oracle');

let env;
before(async () => {
  env = await bi.setup(sc.MODELS);
  await sc.applyAll(env.tenantA, await sc.seedAll(env, env.tenantA));
});
after(() => bi.teardown(env));

const rows = (model) => bi.rowsOf(env, model, env.tenantA);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

test('m9d619 prazos em faixas disjuntas do calendário de São Paulo', async () => {
  const [d] = await rows('rm_legal_deadlines');
  assert.equal(iso(d.as_of_date), '2026-10-28');
  assert.deepEqual(o.pick(d, ['due_next_7d', 'due_7_to_29d', 'overdue', 'oldest_overdue_days', 'open_total']),
    { due_next_7d: 3, due_7_to_29d: 2, overdue: 2, oldest_overdue_days: 10, open_total: 8 },
    'hoje, hoje+6 e hoje+6 às 23:59:59 (3); hoje+7 à meia-noite e hoje+29 (2); vencidos há 1 e 10 dias; hoje+30 só no total; concluído, cancelado e excluído fora');
});

test('m9d619 processos por risco e valores estimado e confirmado separados', async () => {
  const risk = o.byKey(await rows('rm_legal_cases_risk'), ['risk_level', 'case_type']);
  assert.equal(risk.size, 2);
  assert.equal(risk.get('HIGH|EVICTION').count, 2);
  assert.equal(risk.get('SEM_CLASSIFICACAO|LABOR').count, 1, 'sem nível entra em SEM_CLASSIFICACAO; fase CLOSED, arquivado e excluído ficam fora');
  const values = o.byKey(await rows('rm_legal_values'), ['case_type', 'risk_level']);
  assert.equal(values.size, 3);
  assert.deepEqual(o.pick(values.get('EVICTION|HIGH'), ['estimated_total', 'confirmed_total', 'cases_without_value']), { estimated_total: '150000.50', confirmed_total: '20000.00', cases_without_value: 0 });
  assert.deepEqual(o.pick(values.get('LABOR|SEM_CLASSIFICACAO'), ['estimated_total', 'confirmed_total', 'cases_without_value']), { estimated_total: '0.00', confirmed_total: '0.00', cases_without_value: 1 });
  assert.deepEqual(o.pick(values.get('LABOR|LOW'), ['estimated_total', 'confirmed_total']), { estimated_total: '0.00', confirmed_total: '7000.00' }, 'o confirmado de processo encerrado continua; o estimado só dos ativos');
});

test('m9d619 documentos faltantes por tipo e contratos distintos', async () => {
  const docs = o.byKey(await rows('rm_legal_missing_docs'), ['requirement_type']);
  assert.equal(docs.size, 3);
  assert.deepEqual(o.pick(docs.get('IDENTIFICATION'), ['contracts_missing', 'requirements_pending']), { contracts_missing: 2, requirements_pending: 3 });
  assert.deepEqual(o.pick(docs.get('PROOF_OF_INCOME'), ['contracts_missing', 'requirements_pending']), { contracts_missing: 1, requirements_pending: 1 });
  assert.deepEqual(o.pick(docs.get('TODOS'), ['contracts_missing', 'requirements_pending']), { contracts_missing: 2, requirements_pending: 4 }, 'contrato com dois tipos pendentes conta uma vez; cancelado e excluído fora');
});

test('m9d619 casos por estágio com os dias no estágio', async () => {
  const stage = o.byKey(await rows('rm_fin_cases_stage'), ['stage']);
  assert.deepEqual(o.pick(stage.get('UNDER_ANALYSIS'), ['count', 'days_in_stage_sum']), { count: 2, days_in_stage_sum: 26 }, '18 dias (10/10) + 8 dias (20/10); o registro não aplicado não conta');
  assert.deepEqual(o.pick(stage.get('APPROVED'), ['count', 'days_in_stage_sum']), { count: 3, days_in_stage_sum: 88 });
  assert.deepEqual(o.pick(stage.get('REJECTED'), ['count', 'days_in_stage_sum']), { count: 1, days_in_stage_sum: 25 });
  assert.deepEqual(o.pick(stage.get('DRAFT'), ['count', 'days_in_stage_sum']), { count: 1, days_in_stage_sum: 8 }, 'sem histórico vale a última atualização');
});

test('m9d619 aprovação e rejeição por provider, produto e mês, com as horas de análise', async () => {
  const out = o.byKey(await rows('rm_fin_provider_outcome'), ['provider', 'product', 'period_month']);
  assert.equal(out.size, 3);
  const f = ['approved', 'rejected', 'analysis_hours_sum', 'analysis_count'];
  assert.deepEqual(o.pick(out.get('BANCO_A|FINANCIAMENTO|2026-10'), f), { approved: 2, rejected: 0, analysis_hours_sum: '72.00', analysis_count: 1 }, 'a aprovada sem data de envio conta, mas fica fora das horas');
  assert.deepEqual(o.pick(out.get('BANCO_B|FINANCIAMENTO|2026-10'), f), { approved: 0, rejected: 1, analysis_hours_sum: '6.00', analysis_count: 1 });
  assert.deepEqual(o.pick(out.get('BANCO_A|CONSORCIO|2026-09'), f), { approved: 1, rejected: 0, analysis_hours_sum: '24.00', analysis_count: 1 }, 'envio vindo do registro de submissão ao provider');
});

test('m9d619 comissão esperada, confirmada e recebida em colunas separadas', async () => {
  const c = o.byKey(await rows('rm_fin_commission'), ['provider']);
  assert.deepEqual(o.pick(c.get('BANCO_A'), ['expected', 'confirmed', 'received']), { expected: '1500.50', confirmed: '6300.00', received: '4000.00' }, 'ajustada não conta');
  assert.deepEqual(o.pick(c.get('BANCO_B'), ['expected', 'confirmed', 'received']), { expected: '250.00', confirmed: '100.00', received: '100.00' });
});
