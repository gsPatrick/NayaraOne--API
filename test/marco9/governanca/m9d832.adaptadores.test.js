'use strict';

// M9-D832 — as 11 ações chamam o serviço normal do módulo (nunca inserem direto), conferem os campos da tabela 3.5 e deixam a origem BCP no efeito. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d832Env');
const { SPEC } = require('../_helpers/m9d834Spec');

const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
let A;
let ctx;

// campos comparados por ação (tabela de adaptadores da M9-D832 §3.1 item 5)
const COMPARED = {
  REGISTER_LEAD: ['nome', 'telefone'], REGISTER_VISIT: ['nomeCliente', 'imovel', 'dataHoraVisita'], REGISTER_PROPOSAL: ['documento', 'imovel', 'valorAluguelCentavos'],
  REGISTER_KEY_DELIVERY: ['contrato', 'imovel', 'data'], RECEIVE_PAYMENT: ['valorCentavos', 'data', 'documento'], EMERGENCY_PAYMENT: ['valorCentavos', 'data', 'documento'],
  DAILY_REPORT: ['obra', 'data'], MATERIAL_REQUEST: ['obra', 'material', 'quantidade'], REGISTER_DOCUMENT: ['processo', 'tipoDocumento', 'data'],
  REGISTER_CASE_PROGRESS: ['processo', 'etapa', 'data'], REGISTER_DEADLINE: ['processo', 'dataFinalPrazo'],
};
// tabela e coluna onde o serviço normal grava o efeito (a prova de que o comando não é uma cópia solta)
const EFFECT_TABLE = {
  REGISTER_LEAD: ['crm.opportunities', 'Opportunity'], REGISTER_VISIT: ['crm.visits', 'Visit'], REGISTER_PROPOSAL: ['crm.proposals', 'Proposal'], REGISTER_KEY_DELIVERY: ['legal.key_deliveries', 'KeyDelivery'],
  RECEIVE_PAYMENT: ['finance.financial_entries', 'FinancialEntry'], EMERGENCY_PAYMENT: ['finance.financial_entries', 'FinancialEntry'], DAILY_REPORT: ['construction.daily_reports', 'DailyReport'],
  MATERIAL_REQUEST: ['construction.material_requests', 'MaterialRequest'], REGISTER_DOCUMENT: ['correspondent.case_documents', 'CaseDocument'], REGISTER_CASE_PROGRESS: ['correspondent.financing_cases', 'FinancingCase'],
  REGISTER_DEADLINE: ['legal.legal_deadlines', 'LegalDeadline'],
};

before(async () => {
  if (!env.DISPOSABLE) return;
  ({ A } = await env.loadTenants());
  await env.prepare(A);
  ctx = await env.context(A);
});
after(async () => { if (env.DISPOSABLE) { await env.cleanImports(); await env.sequelize.close(); } });

test('m9d832 cada uma das 11 ações tem adaptador e campos comparados e grava pelo serviço normal', { skip: skip() }, async () => {
  assert.equal(SPEC.length, 11);
  for (const spec of SPEC) {
    const op = await env.recordAction(A, spec.action, ctx);
    const { items, summary } = await env.importIds(A, [op.id]);
    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(item.error, null, `${spec.action}: ${JSON.stringify(item.error)}`);
    assert.equal(summary.failed, 0);
    const [table, entity] = EFFECT_TABLE[spec.action];
    assert.equal(item.commandRef.split(':')[0], entity, `${spec.action}: referência do comando`);
    const row = await env.importRow(op.id);
    assert.deepEqual(row.effect.compared, COMPARED[spec.action], `${spec.action}: campos comparados`);
    assert.equal(row.command_ref, item.commandRef);
    const effectId = item.commandRef.split(':')[1];
    assert.equal((await env.adminQuery(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [effectId])).rows[0].n, 1, `${spec.action}: efeito em ${table}`);
    const stored = await env.opRow(op.id);
    assert.equal(stored.import_command_ref, item.commandRef);
    assert.ok(['RECONCILED', 'IMPORTED'].includes(stored.status), `${spec.action}: ${stored.status}`);
    assert.equal((await env.reconciliationOf(op.id)).result, item.reconciliation.result);
  }
});

test('m9d832 o lançamento do recebimento nasce do serviço normal: a parcela é baixada com a data do papel', { skip: skip() }, async () => {
  const receivableId = await require('../_helpers/m9d832More').createReceivable(A, ctx.base, 1250);
  const op = await env.recordAction(A, 'RECEIVE_PAYMENT', { ...ctx, receivableId }, { valorCentavos: 125000, data: '2026-10-18' });
  const { items } = await env.importIds(A, [op.id]);
  assert.deepEqual([items[0].status, items[0].reconciliation.result, items[0].reconciliation.diff], ['RECONCILED', 'MATCHED', []]);
  const entry = (await env.adminQuery('SELECT status, amount::text, settled_at FROM finance.financial_entries WHERE id = $1', [receivableId])).rows[0];
  assert.equal(entry.status, 'SETTLED');
  assert.equal(entry.amount, '1250.00');
  assert.equal(new Date(entry.settled_at).toISOString().slice(0, 10), '2026-10-18', 'data do caixa = data do papel');
});

test('m9d832 o lançamento a pagar do pagamento emergencial leva a origem BCP e a chave de idempotência da operação', { skip: skip() }, async () => {
  const op = await env.recordAction(A, 'EMERGENCY_PAYMENT', ctx);
  const { items } = await env.importIds(A, [op.id]);
  const entry = (await env.adminQuery('SELECT * FROM finance.financial_entries WHERE id = $1', [items[0].commandRef.split(':')[1]])).rows[0];
  assert.deepEqual([entry.nature, entry.status, entry.origin_ref, entry.idempotency_key], ['PAYABLE', 'PENDING', `bcp:${op.manualReference}`, `bcp:${A.companyId}:${op.manualReference}`]);
  assert.ok(entry.description.startsWith(`BCP ${op.manualReference} | Doc: `), 'o favorecido e o documento ficam no início da descrição');
  assert.equal(items[0].reconciliation.result, 'MATCHED');
});

test('m9d832 as referências do papel aceitam o código legível (imóvel, centro de custo, obra) e recusam o que não existe', { skip: skip() }, async () => {
  const visit = await env.recordAction(A, 'REGISTER_VISIT', ctx, { imovel: ctx.base.property.code.toLowerCase() });
  const material = await env.recordAction(A, 'MATERIAL_REQUEST', ctx, { obra: ctx.base.project.code });
  const payment = await env.recordAction(A, 'EMERGENCY_PAYMENT', ctx, { centroCusto: ctx.base.costCenter.code });
  const bad = await env.recordAction(A, 'MATERIAL_REQUEST', ctx, { obra: 'OBRA-NAO-EXISTE' });
  const { items } = await env.importIds(A, [visit.id, material.id, payment.id, bad.id]);
  assert.deepEqual(items.map((i) => i.error && i.error.code), [null, null, null, 'GOV_BCP_COMMAND_REJECTED']);
  assert.match(items[3].error.message, /^O sistema recusou a operação: obra "OBRA-NAO-EXISTE" não encontrado\.$/);
  assert.equal((await env.opRow(bad.id)).status, 'RECORDED');
});
