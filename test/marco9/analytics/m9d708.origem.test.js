'use strict';

// M9-D708 (3.3) — KPI de outra área (Comercial/CRM) conferido contra a origem registrada: o relatório de referência é a lista de oportunidades do CRM refeita
// pelo detalhe assinado do snapshot (contagem para crm.opportunities_by_stage; a fórmula do KPI sobre as linhas para crm.conversion_rate). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/crmKpiEnv');
const reconcile = require('../../../src/features/analytics/metrics/acceptance.reconcile');
const { REFERENCE_REPORTS } = require('../../../scripts/analytics/reconcile/reports');

const { src, at, opp, TODAY, NOW } = kit;
let env;
before(async () => { env = await kit.setup(); });
after(async () => {
  await env.admin.query('DELETE FROM analytics.metric_acceptance WHERE company_id IN (:ids)', { replacements: { ids: [env.cX.companyId, env.cY.companyId] } });
  await kit.teardown(env);
});

const reconcileOne = (t, code) => kit.inTx(t, { commit: true }, (tx) => reconcile.reconcileMetric(kit.ctxOf(t), code, { asOfDate: TODAY, now: NOW, referenceReports: REFERENCE_REPORTS }, tx));

test('m9d708 KPI do CRM é conferido contra a lista de oportunidades da origem registrada', async () => {
  const t = env.cX;
  const [b1, b2] = [src.uuid(), src.uuid()];
  const ids = [];
  const closed = {};
  const add = async (c, outcome) => { const id = await opp(env, t, c); ids.push(id); if (outcome) closed[id] = outcome; };
  await add({ owner: b1, stage: 'NEW', created: at(1), updated: at(28) });
  await add({ owner: b1, stage: 'NEW', created: at(1), updated: at(26) });
  await add({ owner: b2, stage: 'VISIT_SCHEDULED', created: at(1), updated: at(14) });
  await add({ owner: b1, stage: 'CLOSED_WON', created: at(1), closedAt: at(10) }, 'won');
  await add({ owner: b2, stage: 'CLOSED_LOST', created: at(1), closedAt: at(13), lostReason: 'PRICE' }, 'lost');
  await kit.refreshAll(t, ids, closed);
  await kit.kpis(t);
  const stages = await reconcileOne(t, 'crm.opportunities_by_stage');
  assert.notEqual(stages.biValue, null, 'o BI tem valor');
  assert.equal(stages.referenceValue, stages.biValue, 'a lista de oportunidades do CRM bate com o KPI');
  assert.equal(stages.difference, '0');
  assert.match(stages.referenceReport, /Origem .*crm\.opportunities/);
  const conversion = await reconcileOne(t, 'crm.conversion_rate');
  assert.notEqual(conversion.referenceValue, null, 'a fórmula do KPI refeita sobre as linhas da origem');
  assert.equal(conversion.referenceValue, '50.00', '1 ganha em 2 encerradas, refeito das linhas do CRM');
  assert.equal(conversion.biValue, null, 'a regra de qualidade (amostra curta) deixa o KPI sem valor: o aceite não passa sem diferença calculada');
  assert.equal(conversion.difference, null);
  const [rows] = await env.admin.query("SELECT metric_code, status, reference_value IS NOT NULL AS has_ref FROM analytics.metric_acceptance WHERE company_id = :c ORDER BY 1", { replacements: { c: t.companyId } });
  assert.deepEqual(rows.map((r) => [r.metric_code, r.status, r.has_ref]), [['crm.conversion_rate', 'PENDING', true], ['crm.opportunities_by_stage', 'PENDING', true]]);
});
