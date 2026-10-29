'use strict';

// M9-D824 — rotas GET /dlp/anomalies e POST /dlp/anomalies/:id/review pela API real (banco descartável): permissão, revisão com motivo, sessão preservada e a
// leitura de 250 itens HIGH pela rota de VIEW (M9-D825) abrindo a anomalia.
process.env.PORT = process.env.M9D824_HTTP_TEST_PORT || '21824';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d825Env');

let http; let fx;
before(async () => {
  http = await env.startDlpHttp(process.env.PORT);
  if (!http.skip) fx = await env.createFixtures(http, 'gestorA', 'D824');
});
after(async () => { if (fx) await env.removeFixtures(fx); await env.adminQuery("DELETE FROM people.persons WHERE legal_name = 'QA-M9 Sem documento'").catch(() => {}); await env.stopDlpHttp(); });

test('m9d824 leitura de 250 itens HIGH gera sinais pela rota de VIEW e abre a anomalia', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  // Pessoa sem CPF: só tem campo HIGH (nascimento), para a soma ser a de HIGH e não a de RESTRICTED.
  const plain = await http.call('gestorA', 'POST', '/people', { personType: 'PF', legalName: 'QA-M9 Sem documento', birthOrFoundationDate: '1985-03-02', allowDuplicate: true });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  // A resposta do próprio POST devolve a pessoa (HIGH) e também conta como leitura: o sinal da criação sai da conta, que mede só as 250 leituras da rota de VIEW.
  await env.adminQuery('DELETE FROM governance.access_signals');
  await env.adminQuery('DELETE FROM governance.access_anomalies');
  for (let batch = 0; batch < 25; batch += 1) {
    const out = await Promise.all(Array.from({ length: 10 }, () => http.call('gestorA', 'GET', `/people/${plain.body.data.id}`)));
    assert.ok(out.every((r) => r.status === 200), 'as leituras seguem liberadas (VIEW não é suspenso)');
  }
  const [sum] = (await env.adminQuery("SELECT sum(count)::int AS total FROM governance.access_signals WHERE company_id = $1 AND kind = 'READ' AND classification = 'HIGH'", [http.tenants.A.companyId])).rows;
  assert.equal(sum.total, 250, 'um sinal por recurso lido');
  const open = await env.anomaliesOf(http.tenants.A, 'OPEN');
  assert.equal(open.length, 1, 'a anomalia abre uma vez só');
  assert.deepEqual([open[0].kind, open[0].trigger_signals.classification, open[0].user_id], ['READ', 'HIGH', http.tenants.A.userId]);
});

test('m9d824 GET /dlp/anomalies lista para a revisão e exige governance:dlp:admin', async (t) => {
  if (http.skip) return t.skip(http.skip);
  await env.clean();
  const maker = await http.call('makerA', 'GET', '/dlp/anomalies');
  assert.deepEqual([maker.status, maker.body.error.code, maker.body.error.details.required], [403, 'PERMISSION_DENIED', env.ADMIN]);
  const denied = await http.call('makerA', 'POST', `/dlp/anomalies/${env.randomUUID()}/review`, { decision: 'CONFIRMED', reason: 'x' });
  assert.equal(denied.status, 403);
  env.setup({ default: 'LOW' });
  try {
    for (let i = 0; i < 3; i += 1) await env.exportOf(http.tenants.A, http.tenants.A.userId, { idempotencyKey: `h-${env.randomUUID()}` });
  } finally { env.teardown(); }
  const list = await http.call('gestorA', 'GET', '/dlp/anomalies?status=OPEN&kind=EXPORT');
  assert.equal(list.status, 200, 'a anomalia não derrubou a sessão do usuário');
  assert.equal(list.body.data.total, 1);
  const [anomaly] = list.body.data.items;
  assert.deepEqual([anomaly.kind, anomaly.status, anomaly.userId, anomaly.triggerSignals.total], ['EXPORT', 'OPEN', http.tenants.A.userId, 3]);
  assert.ok(new Date(anomaly.restrictedUntil) > new Date());
  const bad = await http.call('gestorA', 'GET', '/dlp/anomalies?status=TALVEZ');
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'GOV_DLP_REQUEST_INVALID']);
  const other = await http.call('gestorB', 'GET', '/dlp/anomalies');
  assert.deepEqual([other.status, other.body.data.total], [200, 0], 'a empresa B não enxerga a anomalia de A');
  const noReason = await http.call('gestorA', 'POST', `/dlp/anomalies/${anomaly.id}/review`, { decision: 'FALSE_POSITIVE' });
  assert.deepEqual([noReason.status, noReason.body.error.code, noReason.body.error.message], [400, 'GOV_ANOMALY_REASON_REQUIRED', 'Informe o motivo da revisão.']);
  const done = await http.call('gestorA', 'POST', `/dlp/anomalies/${anomaly.id}/review`, { decision: 'FALSE_POSITIVE', reason: 'Fechamento mensal conferido.' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.data.status, done.body.data.restrictedUntil, done.body.data.reviewedBy], ['FALSE_POSITIVE', null, http.tenants.A.userId]);
  const after = await http.call('gestorA', 'GET', '/dlp/anomalies?status=OPEN');
  assert.equal(after.body.data.total, 0);
  assert.equal((await env.stateOf(http.tenants.A, http.tenants.A.userId)).dlp_restricted_until, null);
});
