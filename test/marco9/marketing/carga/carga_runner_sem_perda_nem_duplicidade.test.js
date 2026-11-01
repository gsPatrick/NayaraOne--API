'use strict';

// M9-D441 carga (a): o runner de automações processa 1.000 eventos, cada um entregue 2 vezes e por 2 consumidores simultâneos, sem perda e sem duplicidade (MKT-007): 1 run e 1 mensagem por
// chave, 1 evento automation.run.started por run. Depois reentrega TODOS os eventos de novo (replay). 1.000 é só o tamanho do conjunto para forçar concorrência, não uma meta de desempenho.
// COMMIT real: só em banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withTenantTransaction } = require('../../../testHelpers');
const env = require('../../_helpers/mktRunner');
const carga = require('../../_helpers/mktCarga');
const isolamento = require('../../_helpers/mktCargaIsolamento');
const { isolarConexoesDeCanal, garantirConexaoDeCanal } = require('../../_helpers/mktConexoesLimpas');

const TOTAL = 1000;
let tenant; let iso; let flow; let personIds = [];
before(async () => {
  if (carga.DISPOSABLE) {
    ({ tenantA: tenant } = await env.prepararTenants());
    await isolarConexoesDeCanal(tenant);
    await garantirConexaoDeCanal(tenant, 'messaging-sandbox', 'Marketing: MESSAGING'); // a carga dispara 1000 envios em paralelo: a connection do canal já existe antes
    iso = await isolamento.isolar(tenant.companyId, ['killswitch', 'fluxos']);
  }
});
after(async () => {
  if (carga.DISPOSABLE && tenant) {
    await carga.withAdmin(async (admin) => {
      await carga.cleanupPeople(admin, personIds);
      if (flow) await carga.cleanupFlow(admin, flow);
    });
    await iso.restaurar();
  }
  await sequelize.close();
});
const tx = (fn) => withTenantTransaction(tenant, fn);

test('carga_runner_sem_perda_nem_duplicidade', { skip: carga.SKIP }, async (tctx) => {
  // fixture: o fluxo com a ação de envio e TOTAL pessoas prontas (telefone e consentimento), em lotes de 100 por transação
  flow = await tx((t) => env.publishedFlow(t, tenant, { actions: [env.SEND()], frequencyCap: { max: 10, windowDays: 7, scope: 'PERSON_CHANNEL_PURPOSE' } }));
  for (let i = 0; i < TOTAL; i += 100) {
    const lote = await tx(async (t) => { const ids = []; for (let j = i; j < Math.min(i + 100, TOTAL); j += 1) ids.push(await env.readyPerson(t, tenant)); return ids; });
    personIds.push(...lote);
  }
  assert.equal(personIds.length, TOTAL);
  const eventos = personIds.map((personId) => env.eventFor(tenant, personId));

  // cada evento é entregue 2 vezes AO MESMO TEMPO por 2 consumidores, com vários eventos em andamento (o pool tem 10 conexões)
  const t0 = Date.now();
  const resultados = await carga.limited(eventos, 3, (event) => Promise.allSettled([tx((t) => env.run(t, tenant, event)), tx((t) => env.run(t, tenant, event))]));
  const rejeitados = resultados.flat().filter((r) => r.status === 'rejected');
  assert.deepEqual(rejeitados.map((r) => r.reason && r.reason.message).slice(0, 3), [], 'nenhuma entrega falhou');
  // e depois o replay de todos os eventos (reentrega do outbox)
  await carga.limited(eventos, 3, (event) => tx((t) => env.run(t, tenant, event)));
  const ms = Date.now() - t0;

  // sem perda e sem duplicidade
  const runIds = new Set(resultados.flatMap((par) => par.flatMap((r) => r.value.runs.map((x) => x.runId))));
  assert.equal(runIds.size, TOTAL, 'uma run por evento (nenhuma perdida, nenhuma repetida)');
  const [estado] = await tx((t) => env.q(t, `SELECT
      (SELECT count(*)::int FROM marketing.automation_runs WHERE automation_version_id = :v) AS runs,
      (SELECT count(DISTINCT idempotency_key)::int FROM marketing.automation_runs WHERE automation_version_id = :v) AS chaves,
      (SELECT count(*)::int FROM marketing.automation_runs WHERE automation_version_id = :v AND status = 'COMPLETED') AS completas,
      (SELECT count(*)::int FROM crm.messages WHERE person_id = ANY(CAST(:ids AS uuid[])) AND direction = 'OUTBOUND') AS mensagens,
      (SELECT count(DISTINCT action_key)::int FROM crm.messages WHERE person_id = ANY(CAST(:ids AS uuid[])) AND direction = 'OUTBOUND') AS chaves_de_mensagem,
      (SELECT count(*)::int FROM (SELECT person_id FROM crm.messages WHERE person_id = ANY(CAST(:ids AS uuid[])) AND direction = 'OUTBOUND' GROUP BY person_id HAVING count(*) > 1) d) AS pessoas_com_duas,
      (SELECT count(*)::int FROM integration.outbox_events WHERE event_type = 'automation.run.started' AND aggregate_id IN (SELECT id FROM marketing.automation_runs WHERE automation_version_id = :v)) AS iniciados`,
  { v: flow.versionId, ids: `{${personIds.join(',')}}` }));
  const fora = await tx((t) => env.q(t, "SELECT status, blocked_reason, actions_result, policy_trace FROM marketing.automation_runs WHERE automation_version_id = :v AND status <> 'COMPLETED' LIMIT 2", { v: flow.versionId }));
  assert.deepEqual(estado, { runs: TOTAL, chaves: TOTAL, completas: TOTAL, mensagens: TOTAL, chaves_de_mensagem: TOTAL, pessoas_com_duas: 0, iniciados: TOTAL }, `MKT_LOAD_INVARIANT_BROKEN ${JSON.stringify(fora)}`);
  tctx.diagnostic(`${TOTAL} eventos x (2 consumidores simultâneos + 1 replay): ${estado.runs} runs, ${estado.mensagens} mensagens, ${estado.chaves_de_mensagem} chaves de mensagem, ${estado.pessoas_com_duas} pessoas com 2 mensagens, ${estado.iniciados} eventos started; ${ms} ms`);
});
