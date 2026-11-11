'use strict';

// DI-M9F-2 — o pedido de avaliação (REQUEST_REVIEW, M9-D424) também manda mensagem: com o canal incerto (timeout) ou numa falha transitória ele não falha nem fica
// pendurado. Timeout: UNKNOWN reconciliado pela chave antes de qualquer reenvio (INT-005); 429/5xx/cofre fora: nova tentativa com backoff e limite (INT-006); opt-out entre
// as tentativas bloqueia; esgotou: o pedido fecha FAILED (fila morta) e nada fica QUEUED nem PENDING para sempre. O pedido só vira SENT (e review.requested só sai) com o envio
// confirmado. Caminho real: runner -> serviço do pedido -> sendMarketingMessage -> ChannelAdapter sandbox; retomada pelo executor das ações adiadas. Banco descartável.
const env = require('../_helpers/m9fAutomacaoEnv');
const rv = require('../_helpers/mktReviews');
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');

const { scenario, callsOf, setParam } = env;
let A;
before(async () => { ({ tenantA: A } = await rv.prepararTenants()); });
beforeEach(() => env.setUp());
afterEach(() => env.tearDown());
after(async () => { await sequelize.close(); });

const T = rv.NOON_SP;
const at = (s) => new Date(T.getTime() + s * 1000);
const iso = (d) => new Date(d).toISOString();
const SANDBOX = { mode: 'SANDBOX' };
const due = (t, when) => rv.runner.runDueActions(A, t, { now: when, mode: 'SANDBOX' });
const msgs = async (t, p) => (await env.messages(t, A, p)).map((m) => m.delivery_status);

/** Pessoa pronta (só e-mail, OPT_IN em AVALIACAO), automação da satisfação instalada e o pedido disparado por uma nota 5. Devolve { p, runId }. */
async function pedido(t) {
  await env.q(t, "UPDATE marketing.automation_runs SET next_due_at = '2999-01-01T00:00:00Z' WHERE company_id = :c AND status = 'WAITING' RETURNING id", { c: A.companyId });
  const p = await rv.ready(t, A);
  const { out } = await rv.record(t, A, p, 5, SANDBOX);
  return { p, runId: out.runs[0].runId };
}
const action = async (t, runId) => (await rv.runRow(t, runId)).actions_result.find((a) => a.type === 'REQUEST_REVIEW');
const request = async (t, p) => (await rv.requestOf(t, p))[0];

test('429_deixa_o_pedido_PENDING_com_nova_tentativa_e_ele_so_vira_SENT_quando_o_canal_aceita', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    scenario.current = 'HTTP_429';
    const { p, runId } = await pedido(t);
    let a = await action(t, runId);
    assert.deepEqual([a.status, a.error_code, a.channel, a.due_at], ['RETRY', 'HTTP_429', 'EMAIL', iso(at(30))], 'transitória: a ação espera o Retry-After');
    assert.equal((await rv.runRow(t, runId)).status, 'WAITING');
    let r = await request(t, p);
    assert.equal(r.status, 'PENDING', 'o pedido não falha nem é dado como feito');
    assert.deepEqual(await msgs(t, p), ['QUEUED']);
    assert.equal((await rv.reviewEvents(t, r.id)).length, 0);
    scenario.current = null;
    await due(t, at(31));
    a = await action(t, runId);
    r = await request(t, p);
    assert.deepEqual([a.status, r.status], ['OK', 'SENT']);
    assert.deepEqual(await msgs(t, p), ['SENT'], 'a mesma mensagem (mesma chave)');
    assert.equal((await rv.reviewEvents(t, r.id)).length, 1, 'review.requested uma única vez');
    assert.equal((await rv.runRow(t, runId)).status, 'COMPLETED');
    assert.deepEqual(callsOf(a.action_key), ['envio', 'envio']);
  });
});

test('timeout_com_o_email_entregue_reconcilia_e_registra_o_pedido_sem_reenviar', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    scenario.current = 'UNKNOWN_BUT_PUBLISHED';
    const { p, runId } = await pedido(t);
    let a = await action(t, runId);
    assert.deepEqual([a.status, a.error_code, a.due_at], ['UNKNOWN', 'MKT_ACTION_UNKNOWN', iso(at(30))]);
    assert.equal((await request(t, p)).status, 'PENDING');
    assert.deepEqual(await msgs(t, p), ['UNKNOWN']);
    scenario.current = null;
    await due(t, at(31));
    a = await action(t, runId);
    const r = await request(t, p);
    assert.deepEqual([a.status, r.status], ['OK', 'SENT']);
    assert.deepEqual(await msgs(t, p), ['SENT']);
    assert.equal((await rv.reviewEvents(t, r.id)).length, 1);
    assert.deepEqual(callsOf(a.action_key), ['envio', 'consulta'], 'consultou pela chave e não reenviou');
  });
});

test('timeout_sem_o_email_entregue_consulta_e_so_entao_reenvia_com_a_mesma_chave', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    scenario.current = 'UNKNOWN_NOT_PUBLISHED';
    const { p, runId } = await pedido(t);
    scenario.current = null;
    await due(t, at(31));
    const a = await action(t, runId);
    assert.deepEqual([a.status, (await request(t, p)).status], ['OK', 'SENT']);
    assert.deepEqual(await msgs(t, p), ['SENT'], 'uma única mensagem no CRM');
    assert.deepEqual(callsOf(a.action_key), ['envio', 'consulta', 'envio']);
  });
});

test('opt_out_entre_as_tentativas_bloqueia_o_pedido_e_cancela_a_mensagem_da_fila', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    scenario.current = 'HTTP_429';
    const { p, runId } = await pedido(t);
    scenario.current = null;
    await env.addConsent(t, A, p, 'EMAIL', 'AVALIACAO', 'OPT_OUT', at(10));
    await due(t, at(31));
    const r = await request(t, p);
    assert.deepEqual([r.status, r.error_code], ['SUPPRESSED', 'OPT_OUT'], 'o canSend da hora do reenvio vale');
    assert.deepEqual(await msgs(t, p), ['CANCELLED']);
    assert.equal((await action(t, runId)).status, 'SKIPPED');
    assert.equal((await rv.reviewEvents(t, r.id)).length, 0);
    assert.deepEqual(callsOf((await action(t, runId)).action_key), ['envio'], 'nada saiu depois do opt-out');
  });
});

test('5xx_esgota_as_tentativas_e_o_pedido_fecha_FAILED_sem_mensagem_na_fila', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await setParam(t, A, 'integration.retry.max_attempts', 2);
    await setParam(t, A, 'integration.retry.base_delay_ms', 60000);
    await setParam(t, A, 'integration.retry.jitter_pct', 0);
    scenario.current = 'HTTP_5XX';
    const { p, runId } = await pedido(t);
    assert.deepEqual([(await action(t, runId)).status, (await action(t, runId)).due_at], ['RETRY', iso(at(60))]);
    await due(t, at(61));
    const r = await request(t, p);
    assert.deepEqual([r.status, r.error_code], ['FAILED', 'MKT_DELIVERY_RETRIES_EXHAUSTED']);
    assert.deepEqual(await msgs(t, p), ['FAILED'], 'a fila não fica pendurada');
    assert.deepEqual([(await action(t, runId)).status, (await rv.runRow(t, runId)).status], ['FAILED', 'FAILED'], 'fila morta');
    assert.equal((await rv.reviewEvents(t, r.id)).length, 0);
  });
});

test('consulta_sem_resposta_esgota_e_o_pedido_fecha_FAILED_com_a_mensagem_ainda_UNKNOWN', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await setParam(t, A, 'integration.unknown.max_reconcile_attempts', 1);
    scenario.current = 'UNKNOWN_BUT_PUBLISHED';
    const { p, runId } = await pedido(t);
    scenario.current = null;
    require('../../../src/features/marketing/publications/adapters/sandbox/sandbox.store').revoke(A.companyId, 'EMAIL');
    await due(t, at(31));
    const r = await request(t, p);
    assert.deepEqual([r.status, r.error_code], ['FAILED', 'MKT_DELIVERY_UNKNOWN_EXHAUSTED']);
    assert.deepEqual(await msgs(t, p), ['UNKNOWN'], 'não se finge falha do que pode ter saído');
    const a = await action(t, runId);
    assert.deepEqual([a.status, a.error_code], ['FAILED', 'MKT_DELIVERY_UNKNOWN_EXHAUSTED']);
    assert.deepEqual(callsOf(a.action_key), ['envio', 'consulta'], 'nenhum reenvio às cegas');
  });
});

test('cofre_fora_por_um_instante_vira_nova_tentativa_e_o_pedido_sai_quando_o_cofre_volta', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    env.vaultDown();
    const { p, runId } = await pedido(t);
    const a = await action(t, runId);
    assert.deepEqual([a.status, a.error_code], ['RETRY', 'MKT_TRACKING_KEY_UNAVAILABLE'], 'a chave do link rastreável está no cofre: passageiro, não pedido perdido');
    assert.equal((await request(t, p)).status, 'PENDING');
    assert.equal((await msgs(t, p)).length, 0, 'nada saiu, nada é fingido no CRM');
    env.vaultBack();
    await due(t, at(10));
    assert.equal((await request(t, p)).status, 'SENT');
    assert.deepEqual(await msgs(t, p), ['SENT']);
  });
});
