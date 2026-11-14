'use strict';

// M9-D710 — fato revertido na origem (estorno, contrato cancelado depois de assinado, ganho desfeito): a linha original NÃO muda, nasce a compensatória (revision 1, valor negado,
// count_effect -1) com o mesmo instante, as somas dão zero e o UNIQUE (kind, source_id, revision) impede reverter duas vezes. Dado sem data deixa o KPI INCOMPLETE. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d710Env');
const sc = require('../_helpers/m9d710Scenario');

let env;
let paid;
before(async () => {
  env = await kit.setup();
  paid = await sc.pagamentos(env, env.cX);
  await kit.rebuild(env.cX);
});
after(() => kit.teardown(env));

const factRows = async (t, sourceId) => (await env.admin.query(
  `SELECT revision, is_reversal, count_effect, amount::text AS amount, occurred_at, occurred_date::text AS day, source_event_id::text AS event, is_third_party, account_id::text AS account
     FROM analytics.rm_command_events WHERE company_id = :c AND source_id = :s ORDER BY revision`, { replacements: { c: t.companyId, s: sourceId } }
))[0];
const kpi = async (t, code) => (await kit.kpis(t)).cmd.kpis[code];

test('m9d710 estorno gera linha compensatória e sai da soma', async () => {
  const t = env.cX;
  assert.deepEqual([(await kpi(t, 'fin.payments_settled_relevant')).value, (await kpi(t, 'fin.payments_settled_relevant')).details.amount], ['2', '35000.00']);
  const [original] = await factRows(t, paid.grande);
  await sc.estornar(env, t, paid.grande, '25000.00', sc.at('28', '13:00:00'));
  const applied = await kit.apply(t, kit.makeEvent(t, 'finance.entry.reversed', { originalEntryId: paid.grande }));
  assert.ok(applied.upserted >= 1, 'o evento atualizou o read model (e os demais que o consomem)');
  const rows = await factRows(t, paid.grande);
  assert.equal(rows.length, 2, 'original e compensatória');
  assert.deepEqual(rows[0], original, 'a linha original não foi alterada pela reversão');
  assert.deepEqual([rows[1].revision, rows[1].is_reversal, rows[1].count_effect, rows[1].amount], [1, true, -1, '-25000.00']);
  assert.equal(new Date(rows[1].occurred_at).getTime(), new Date(rows[0].occurred_at).getTime(), 'a compensatória herda o instante do fato');
  assert.equal(rows[1].day, rows[0].day);
  assert.equal(rows[1].account, rows[0].account);
  const after = await kpi(t, 'fin.payments_settled_relevant');
  assert.deepEqual([after.status, after.value, after.details.amount], ['OK', '1', '10000.00'], 'o estornado sai da contagem e da soma (original + compensatória = zero)');
  assert.equal(await kit.dimension(t, 'fin.payments_settled_relevant', 'valor_brl') * 1, 10000);
});

test('m9d710 reversão grava linha com revision 1 e valor negado sem violar o UNIQUE', async () => {
  const t = env.cX;
  const before = await factRows(t, paid.grande);
  assert.deepEqual(before.map((r) => r.revision), [0, 1]);
  // reaplicar (replay) e recalcular pela agenda não cria revision 2 nem duplica a compensatória
  await kit.apply(t, kit.makeEvent(t, 'finance.entry.reversed', { originalEntryId: paid.grande }));
  await kit.rebuild(t);
  const again = await factRows(t, paid.grande);
  assert.deepEqual(again.map((r) => [r.revision, r.amount]), [[0, '25000.00'], [1, '-25000.00']]);
  // a segunda reversão do mesmo fato é recusada pelo UNIQUE (kind, source_id, revision)
  const group = t.groupId;
  await assert.rejects(
    env.admin.query(
      `INSERT INTO analytics.rm_command_events (company_id, group_id, kind, source_type, source_id, revision, is_reversal, amount, count_effect)
       VALUES (:c, :g, 'PAYMENT_SETTLED', 'FinancialEntry', :s, 1, true, -25000.00, -1)`, { replacements: { c: t.companyId, g: group, s: paid.grande } }
    ),
    (err) => /rm_command_events_pk|duplicate key|unique/i.test(`${err.message} ${(err.parent && err.parent.message) || ''}`)
  );
  // revision 2 não existe: o CHECK só aceita 0 e 1
  await assert.rejects(env.admin.query(
    `INSERT INTO analytics.rm_command_events (company_id, group_id, kind, source_type, source_id, revision, is_reversal, amount, count_effect) VALUES (:c, :g, 'PAYMENT_SETTLED', 'FinancialEntry', :s, 2, true, -1, -1)`,
    { replacements: { c: t.companyId, g: group, s: paid.grande } }
  ));
});

test('m9d710 contrato cancelado depois de assinado e ganho desfeito também geram a compensatória', async () => {
  const t = env.cY;
  const contracts = await sc.contratos(env, t);
  const opps = await sc.oportunidades(env, t);
  await kit.rebuild(t);
  assert.deepEqual([(await kpi(t, 'legal.contracts_signed')).value, (await kpi(t, 'crm.opportunities_won')).value], ['3', '3']);
  await kit.update(env, 'legal.contracts', contracts.grande, { status: 'CANCELLED' });
  await kit.apply(t, kit.makeEvent(t, 'legal.contract.status_changed', { id: contracts.grande, fromStatus: 'SIGNED', toStatus: 'CANCELLED' }));
  await kit.update(env, 'crm.opportunities', opps.a, { stage: 'LOST', deleted_at: null });
  await kit.apply(t, kit.makeEvent(t, 'crm.opportunity.stage_changed', { id: opps.a, fromStage: 'WON', toStage: 'LOST' }));
  for (const id of [contracts.grande, opps.a]) {
    const rows = await factRows(t, id);
    assert.deepEqual(rows.map((r) => [r.revision, r.is_reversal, r.count_effect]), [[0, false, 1], [1, true, -1]], id);
    assert.equal(Number(rows[1].amount), -Number(rows[0].amount));
  }
  const c = await kpi(t, 'legal.contracts_signed');
  const o = await kpi(t, 'crm.opportunities_won');
  assert.deepEqual([c.value, c.details.amount], ['2', '2500.00'], 'o contrato de 480.000,00 saiu da soma');
  assert.deepEqual([o.value, o.details.amount], ['2', '210000.00'], 'a ganha de 300.000,00 saiu da soma');
});

test('m9d710 dado sem data deixa o KPI INCOMPLETE com valor nulo (contrato sem data de assinatura e liquidação sem settledAt)', async () => {
  const t = env.cY;
  await sc.contract(env, t, { type: 'LEASE', total: '10.00', signedAt: null });
  await sc.payment(env, t, { amount: '12000.00', settledAt: null, status: 'SETTLED' });
  await kit.rebuild(t);
  const c = await kpi(t, 'legal.contracts_signed');
  const p = await kpi(t, 'fin.payments_settled_relevant');
  assert.deepEqual([c.status, c.value, c.details.reason], ['INCOMPLETE', null, 'CONTRATO_ASSINADO_SEM_DATA']);
  assert.deepEqual([p.status, p.value, p.details.reason], ['INCOMPLETE', null, 'LIQUIDACAO_SEM_DATA']);
  assert.equal((await kit.readKpi(t, 'legal.contracts_signed')).value, null, 'nunca um número enganoso');
});
