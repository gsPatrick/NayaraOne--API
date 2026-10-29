'use strict';

// M9-D708 (3.4 e 3.5) — o aceite do owner: decide() com evidência, tolerância, só o owner decide, nova versão invalida, concorrência trava a linha
// e a trava do ambiente PRODUCAO (409 ANALYTICS_ENV_NOT_READY) pelo serviço de parâmetros. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e708 = require('../_helpers/m9d708Env');
const reconcile = require('../../../src/features/analytics/metrics/acceptance.reconcile');
const acceptance = require('../../../src/features/analytics/metrics/acceptance.service');
const registry = require('../../../src/features/analytics/metrics');
const { upsertSetting, getSetting } = require('../../../src/features/settings/settings.service');
const { REFERENCE_REPORTS } = require('../../../scripts/analytics/reconcile/reports');
require('../../../src/features/analytics');

const { entry, account, bankTx, run, dayAt, AS_OF, NOW } = e708;
let env;
before(async () => { env = await e708.setup(); });
after(() => e708.teardown(env));

const opts = { asOfDate: AS_OF, now: NOW, referenceReports: REFERENCE_REPORTS };
const owner = (t) => e708.ctxFor(t, env.ownerUserId);
const reconcileCode = (t, code) => e708.inTx(t, { commit: true }, (tx) => reconcile.reconcileMetric(owner(t), code, opts, tx));
const decide = (t, userId, code, version, decision, evidence, extra = {}) => e708.inTx(t, { commit: true }, (tx) => acceptance.decide(code, version, userId, decision, evidence,
  { ctx: e708.ctxFor(t, userId, extra.permissions), transaction: tx, comment: extra.comment }));
const expectErr = (promise, status, code) => assert.rejects(promise, (e) => { assert.equal(e.statusCode, status, `${e.code}: ${e.message}`); assert.equal(e.code, code); return true; });

/** Caixa livre do exemplo da demanda: BI 120.000,00 (entradas próprias 140.000, saídas 20.000); o extrato diz o mesmo ou 10,00 a menos. */
async function caixa(t, { extratoAMenos = '0.00' } = {}) {
  const acc = await account(env, t, { opening: '0.00' });
  await entry(env, t, { nature: 'RECEIVABLE', amount: '140000.00', account: acc, settled: dayAt(-3) });
  await entry(env, t, { nature: 'PAYABLE', amount: '20000.00', account: acc, settled: dayAt(-1) });
  await bankTx(env, t, { account: acc, amount: '140000.00', date: '2026-10-25' });
  await bankTx(env, t, { account: acc, amount: String(-20000 - Number(extratoAMenos)), date: '2026-10-27' });
  await run(t);
}

test('m9d708 aceite sem diferença: o owner aceita com evidência e a métrica fica liberada', async () => {
  const t = env.cX;
  await caixa(t);
  const r = await reconcileCode(t, 'fin.free_cash');
  assert.deepEqual([r.biValue, r.referenceValue, r.difference], ['120000.00', '120000.00', '0.00']);
  const file = await e708.evidenceFile(env, t);
  const out = await decide(t, env.ownerUserId, 'fin.free_cash', 1, 'ACEITAR', file, { comment: 'Conferido com o saldo conciliado.' });
  assert.equal(out.status, 'ACCEPTED');
  const row = await e708.acceptanceRow(env, t, 'fin.free_cash', 1);
  assert.deepEqual([row.status, row.accepted_by, row.evidence_file_id, row.comment], ['ACCEPTED', env.ownerUserId, file, 'Conferido com o saldo conciliado.']);
  assert.ok(row.accepted_at);
  const [audit] = (await env.admin.query("SELECT before_json, after_json FROM audit.audit_log WHERE company_id = :c AND action = 'analytics.metric.acceptance_decided' ORDER BY occurred_at DESC LIMIT 1", { replacements: { c: t.companyId } }))[0];
  assert.equal(audit.before_json.status, 'PENDING');
  assert.equal(audit.after_json.status, 'ACCEPTED');
  assert.equal(audit.after_json.evidenceFileId, file, 'a auditoria leva a evidência');
});

test('m9d708 aceite com diferença acima da tolerância é recusado', async () => {
  const t = env.cY;
  await caixa(t, { extratoAMenos: '10.00' }); // o extrato tem 10,00 a menos: relatório 119.990,00
  const r = await reconcileCode(t, 'fin.free_cash');
  assert.deepEqual([r.biValue, r.referenceValue, r.difference], ['120000.00', '119990.00', '10.00']);
  const file = await e708.evidenceFile(env, t);
  await expectErr(decide(t, env.ownerUserId, 'fin.free_cash', 1, 'ACEITAR', file), 409, 'ANALYTICS_ACCEPT_DIFFERENCE');
  assert.equal((await e708.acceptanceRow(env, t, 'fin.free_cash', 1)).status, 'PENDING', 'a recusa não altera a linha');
  const out = await decide(t, env.ownerUserId, 'fin.free_cash', 1, 'REJEITAR', file, { comment: 'Diferença de R$ 10,00 a explicar no extrato.' });
  assert.equal(out.status, 'REJECTED');
  const row = await e708.acceptanceRow(env, t, 'fin.free_cash', 1);
  assert.deepEqual([row.status, row.difference], ['REJECTED', '10.00']);
});

test('m9d708 o parâmetro de tolerância do administrador libera diferença pequena', async () => {
  const t = env.cY;
  await e708.setSetting(env, t, 'analytics.aceite.tolerancia', 'dinheiro=15,00; contagem=0; demais=0');
  await reconcileCode(t, 'fin.free_cash');
  const row0 = await e708.acceptanceRow(env, t, 'fin.free_cash', 1);
  assert.equal(row0.tolerance, '15.00');
  const file = await e708.evidenceFile(env, t);
  assert.equal((await decide(t, env.ownerUserId, 'fin.free_cash', 1, 'ACEITAR', file)).status, 'ACCEPTED');
  await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'analytics.aceite.tolerancia'", { replacements: { c: t.companyId } });
});

test('m9d708 só o owner decide', async () => {
  const t = env.cX;
  await reconcileCode(t, 'fin.free_cash');
  const file = await e708.evidenceFile(env, t);
  await expectErr(decide(t, env.otherUserId, 'fin.free_cash', 1, 'ACEITAR', file), 403, 'ANALYTICS_ACCEPT_NOT_OWNER');
  await expectErr(decide(t, env.otherUserId, 'fin.free_cash', 1, 'REJEITAR', file), 403, 'ANALYTICS_ACCEPT_NOT_OWNER');
  await expectErr(decide(t, env.ownerUserId, 'fin.free_cash', 1, 'ACEITAR', file, { permissions: ['analytics:read'] }), 403, 'PERMISSION_DENIED');
  assert.equal((await e708.acceptanceRow(env, t, 'fin.free_cash', 1)).status, 'PENDING');
});

test('m9d708 a decisão exige linha reconciliada, evidência real da empresa, versão vigente e decisão válida', async () => {
  const t = env.cX;
  const file = await e708.evidenceFile(env, t);
  const foreign = await e708.evidenceFile(env, env.cY);
  await expectErr(decide(t, env.ownerUserId, 'fin.free_cash', 1, 'TALVEZ', file), 400, 'ANALYTICS_ACCEPT_INVALID');
  await expectErr(decide(t, env.ownerUserId, 'fin.free_cash', 1, 'ACEITAR', null), 400, 'ANALYTICS_ACCEPT_EVIDENCE_REQUIRED');
  await expectErr(decide(t, env.ownerUserId, 'fin.free_cash', 1, 'ACEITAR', e708.uuid()), 400, 'ANALYTICS_ACCEPT_EVIDENCE_NOT_FOUND');
  await expectErr(decide(t, env.ownerUserId, 'fin.free_cash', 1, 'ACEITAR', foreign), 400, 'ANALYTICS_ACCEPT_EVIDENCE_NOT_FOUND');
  await expectErr(decide(t, env.ownerUserId, 'fin.free_cash', 7, 'ACEITAR', file), 409, 'ANALYTICS_ACCEPT_VERSION_STALE');
  await expectErr(decide(t, env.ownerUserId, 'fin.metrica_que_nao_existe', 1, 'ACEITAR', file), 404, 'ANALYTICS_METRIC_NOT_FOUND');
  await expectErr(decide(t, env.ownerUserId, 'fin.third_party_cash', 1, 'ACEITAR', file), 409, 'ANALYTICS_ACCEPT_NOT_RECONCILED');
});

test('m9d708 nova versão invalida o aceite e o aceite volta a PENDING para a versão nova', async () => {
  const t = env.cX;
  const file = await e708.evidenceFile(env, t);
  await reconcileCode(t, 'fin.free_cash');
  await decide(t, env.ownerUserId, 'fin.free_cash', 1, 'ACEITAR', file);
  const manage = { groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions: ['analytics:manage'] };
  await e708.inTx(t, { commit: true }, (tx) => registry.publishVersion('fin.free_cash', {
    scopeLevel: 'COMPANY', version: 2, validFrom: '2026-10-29', changeReason: 'Passa a descontar a caução da conta de garantia.',
    formulaSemantic: 'Caixa livre = caixa total menos o dinheiro de terceiros retido e menos a caução da conta de garantia.',
  }, manage, tx, { now: NOW, reasonMinChars: 10 }));
  const v2 = await e708.acceptanceRow(env, t, 'fin.free_cash', 2);
  assert.ok(v2, 'a versão nova ganha a sua linha');
  assert.deepEqual([v2.status, v2.accepted_by, v2.accepted_at], ['PENDING', null, null]);
  const v1 = await e708.acceptanceRow(env, t, 'fin.free_cash', 1);
  assert.equal(v1.status, 'ACCEPTED', 'o aceite da v1 fica como histórico da v1');
  await expectErr(decide(t, env.ownerUserId, 'fin.free_cash', 1, 'ACEITAR', file), 409, 'ANALYTICS_ACCEPT_VERSION_STALE');
  const { avaliarAceite } = require('../../../scripts/analytics/ci/gates/aceite');
  const rows = (await env.admin.query('SELECT metric_code AS code, metric_version AS version, status FROM analytics.metric_acceptance WHERE company_id = :c', { replacements: { c: t.companyId } }))[0];
  const gate = avaliarAceite({ ambiente: 'PRODUCAO', metricas: [{ code: 'fin.free_cash', version: 2 }], aceites: rows });
  assert.equal(gate.ok, false);
});

test('m9d708 duas decisões ao mesmo tempo: a linha é travada e só uma vale', async () => {
  const t = env.cY;
  await e708.setSetting(env, t, 'analytics.aceite.tolerancia', 'dinheiro=0,00; contagem=0; demais=0');
  await reconcileCode(t, 'fin.third_party_cash');
  const file = await e708.evidenceFile(env, t);
  const settled = await Promise.allSettled([
    decide(t, env.ownerUserId, 'fin.third_party_cash', 1, 'ACEITAR', file),
    decide(t, env.ownerUserId, 'fin.third_party_cash', 1, 'REJEITAR', file),
  ]);
  assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
  const lost = settled.find((s) => s.status === 'rejected');
  assert.equal(lost.reason.statusCode, 409);
  assert.equal(lost.reason.code, 'ANALYTICS_ACCEPT_ALREADY_DECIDED');
  const [{ n }] = (await env.admin.query("SELECT count(*)::int AS n FROM audit.audit_log WHERE company_id = :c AND action = 'analytics.metric.acceptance_decided' AND after_json->>'metricCode' = 'fin.third_party_cash'", { replacements: { c: t.companyId } }))[0];
  assert.equal(n, 1);
});

/** Deixa a empresa só com fin.free_cash e fin.third_party_cash publicados (as demais saem do ar), para o portão ter dois itens. */
async function onlyTwoPublished(t) {
  await env.admin.query("UPDATE analytics.metric_definitions SET status = 'RETIRED' WHERE company_id = :c AND status = 'PUBLISHED' AND metric_code NOT IN ('fin.free_cash', 'fin.third_party_cash')", { replacements: { c: t.companyId } });
}
const setAmbiente = (t, value) => e708.inTx(t, { commit: true }, (tx) => upsertSetting('analytics.ambiente', value, { groupId: t.groupId, companyId: t.companyId }, env.ownerUserId, tx));

test('m9d708 PRODUCAO é recusada com métrica sem aceite', async () => {
  const t = env.cX;
  await onlyTwoPublished(t);
  await reconcileCode(t, 'fin.third_party_cash');
  await expectErr(setAmbiente(t, 'PRODUCAO'), 409, 'ANALYTICS_ENV_NOT_READY');
  const value = await e708.inTx(t, {}, (tx) => getSetting('analytics.ambiente', { groupId: t.groupId, companyId: t.companyId }, tx, 'LAB'));
  assert.equal(value, 'LAB', 'nada foi gravado');
  assert.equal((await setAmbiente(t, 'LAB')).value, 'LAB', 'LAB sempre pode');
});

test('m9d708 ambiente PRODUCAO exige todas as métricas aceitas', async () => {
  const t = env.cX;
  const file = await e708.evidenceFile(env, t);
  await decide(t, env.ownerUserId, 'fin.third_party_cash', 1, 'ACEITAR', file); // falta a v2 do caixa livre
  await expectErr(setAmbiente(t, 'PRODUCAO'), 409, 'ANALYTICS_ENV_NOT_READY');
  try {
    await setAmbiente(t, 'PRODUCAO');
  } catch (e) {
    assert.ok(e.details.pendentes.some((p) => p.startsWith('fin.free_cash')), 'a resposta nomeia o que falta');
    assert.equal(e.message, 'Há indicadores sem aceite do responsável.');
  }
  // a v2 só ganha snapshot no próximo dia-base (valid_from 29/10); a reconciliação dela é simulada com a conferência sem diferença
  const v2 = await reconcileCode(t, 'fin.free_cash');
  assert.equal(v2.biValue, null, 'sem snapshot da v2 ainda');
  await env.admin.query("UPDATE analytics.metric_acceptance SET bi_value = 120000, reference_value = 120000, difference = 0, tolerance = 0 WHERE company_id = :c AND metric_code = 'fin.free_cash' AND metric_version = 2", { replacements: { c: t.companyId } });
  await decide(t, env.ownerUserId, 'fin.free_cash', 2, 'ACEITAR', file);
  assert.equal((await setAmbiente(t, 'PRODUCAO')).value, 'PRODUCAO');
  assert.equal(await e708.inTx(t, {}, (tx) => acceptance.readAmbiente({ groupId: t.groupId, companyId: t.companyId }, tx)), 'PRODUCAO');
});
