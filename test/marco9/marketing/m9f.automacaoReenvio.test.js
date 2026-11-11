'use strict';

// DI-M9F-1 — a ação SEND_MESSAGE das automações com o mesmo desenho da entrega de campanha (INT-005, INT-006, Integrações §7 e §8, MKT §12 e §16 "Provider timeout →
// não duplica"): falha transitória vira nova tentativa com backoff e limite (`integration.retry.*`), timeout vira UNKNOWN reconciliado pela chave antes de qualquer
// reenvio (`integration.unknown.*`), opt-out entre tentativas bloqueia, nada fica QUEUED para sempre, nunca há envio duplicado e a ação só fica OK com o envio
// confirmado. Caminho real: runner -> executor -> sendMarketingMessage -> ChannelAdapter sandbox; retomada pelo executor das ações adiadas. Banco descartável, RLS real.
const env = require('../_helpers/m9fAutomacaoEnv');
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');

const { readyPerson, emailFlow, fire, due, runOf, sendOf, messages, sent, setParam, audits, callsOf, at, T0, scenario } = env;
let A;
before(async () => { ({ a: A } = await env.tenants()); });
beforeEach(() => env.setUp());
afterEach(() => env.tearDown());
after(async () => { await sequelize.close(); });

const iso = (d) => new Date(d).toISOString();
const states = async (t, p) => (await messages(t, A, p)).map((m) => m.delivery_status);

test('429_vira_RETRY_a_run_espera_e_a_acao_so_fica_OK_quando_o_provedor_aceita', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await emailFlow(t, A);
    scenario.current = 'HTTP_429';
    const runId = await fire(t, A, p);
    let s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.error_code, s.attempts, s.rate_deferrals], ['RETRY', 'HTTP_429', 1, 1], 'transitória: nova tentativa, o 429 não gasta tentativa');
    assert.equal(s.due_at, iso(at(30)), 'espera = Retry-After do canal (30 s), maior que o backoff da 1ª tentativa');
    let run = await runOf(t, runId);
    assert.deepEqual([run.status, iso(run.next_due_at)], ['WAITING', iso(at(30))], 'a run não termina com a mensagem na fila');
    assert.deepEqual(await states(t, p), ['QUEUED'], 'o CRM mostra a fila, sem fingir envio');

    scenario.current = null; // o provedor volta
    await due(t, A, at(15));
    assert.equal((await sendOf(t, runId)).status, 'RETRY', 'antes da hora marcada nada é reenviado');
    assert.equal(sent(A), 0);
    await due(t, A, at(40));
    s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.error_code, s.attempts], ['OK', null, 2]);
    assert.match(s.provider_ref, /^sbx-email-/);
    run = await runOf(t, runId);
    assert.deepEqual([run.status, run.next_due_at], ['COMPLETED', null]);
    assert.deepEqual(await states(t, p), ['SENT'], 'a mesma mensagem do CRM (mesma chave) passa a SENT');
    await due(t, A, at(4000));
    assert.equal(sent(A), 1, 'um único envio ao provedor');
    assert.deepEqual(callsOf(s.action_key), ['envio', 'envio'], 'o 429 recusou a 1ª chamada; a 2ª, com a mesma chave, foi aceita; nenhuma outra');
  });
});

test('5xx_esgota_as_tentativas_parametrizadas_e_fecha_FAILED_sem_deixar_mensagem_na_fila', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await setParam(t, A, 'integration.retry.max_attempts', 2);
    await setParam(t, A, 'integration.retry.base_delay_ms', 60000);
    await setParam(t, A, 'integration.retry.jitter_pct', 0);
    const p = await readyPerson(t, A);
    await emailFlow(t, A);
    scenario.current = 'HTTP_5XX';
    const runId = await fire(t, A, p);
    let s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.error_code, s.attempts, s.due_at], ['RETRY', 'HTTP_503', 1, iso(at(60))], 'backoff = integration.retry.base_delay_ms do administrador');
    await due(t, A, at(61));
    s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.error_code, s.detail, s.attempts, s.due_at], ['FAILED', 'MKT_DELIVERY_RETRIES_EXHAUSTED', 'HTTP_503', 2, null], 'limite = integration.retry.max_attempts');
    assert.equal((await runOf(t, runId)).status, 'FAILED', 'fila morta: a run fica FAILED, com a auditoria da falha');
    const [m] = await messages(t, A, p);
    assert.equal(m.delivery_status, 'FAILED', 'a mensagem do CRM não fica QUEUED para sempre');
    assert.match(m.failure_reason, /tentativas de envio acabaram/);
    const [aud] = await audits(t, A, 'marketing.automation_run.failed', runId);
    assert.equal(aud.after_json.actions[0].error_code, 'MKT_DELIVERY_RETRIES_EXHAUSTED');
    scenario.current = null;
    await due(t, A, at(900));
    assert.equal(sent(A), 0, 'nada sai depois de esgotar');
  });
});

test('timeout_com_o_email_entregue_fica_UNKNOWN_e_a_reconciliacao_marca_OK_sem_reenviar', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await emailFlow(t, A);
    scenario.current = 'UNKNOWN_BUT_PUBLISHED';
    const runId = await fire(t, A, p);
    let s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.error_code, s.reconcile_attempts, s.due_at], ['UNKNOWN', 'MKT_ACTION_UNKNOWN', 0, iso(at(30))], 'timeout não é falha: consulta em integration.unknown.reconcile_intervals_s[0]');
    assert.equal((await runOf(t, runId)).status, 'WAITING');
    assert.deepEqual(await states(t, p), ['UNKNOWN']);
    scenario.current = null;
    await due(t, A, at(31));
    s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.reconcile_attempts, s.due_at], ['OK', 1, null]);
    assert.match(s.provider_ref, /^sbx-email-/, 'a referência vem do provedor');
    assert.equal((await runOf(t, runId)).status, 'COMPLETED');
    assert.deepEqual(await states(t, p), ['SENT'], 'o CRM passa a SENT pela confirmação do provedor');
    assert.equal(sent(A), 1, 'nada foi reenviado');
    assert.deepEqual(callsOf(s.action_key), ['envio', 'consulta'], 'consultou pela chave e não reenviou');
    const [aud] = await audits(t, A, 'marketing.automation_run.action.reconciled', runId);
    assert.deepEqual([aud.before_json.status, aud.after_json.found], ['UNKNOWN', true]);
  });
});

test('timeout_sem_o_email_entregue_reconcilia_e_so_entao_reenvia_com_a_mesma_chave', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await emailFlow(t, A);
    scenario.current = 'UNKNOWN_NOT_PUBLISHED';
    const runId = await fire(t, A, p);
    assert.equal((await sendOf(t, runId)).status, 'UNKNOWN');
    assert.equal(sent(A), 0);
    scenario.current = null;
    await due(t, A, at(31));
    const s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.attempts, s.reconcile_attempts], ['OK', 2, 1]);
    const msgs = await messages(t, A, p);
    assert.deepEqual(msgs.map((m) => m.delivery_status), ['SENT'], 'uma única mensagem no CRM, a mesma da 1ª tentativa');
    assert.equal(msgs[0].action_key, s.action_key, 'a chave de idempotência é a da ação');
    assert.equal(sent(A), 1, 'um único registro no provedor');
    assert.deepEqual(callsOf(s.action_key), ['envio', 'consulta', 'envio'], 'o reenvio só depois da consulta');
    const [aud] = await audits(t, A, 'marketing.automation_run.action.reconciled', runId);
    assert.equal(aud.after_json.found, false, 'a consulta veio antes do reenvio');
  });
});

test('consulta_do_UNKNOWN_sem_resposta_espera_e_esgota_sem_reenviar_e_sem_fingir_falha_no_crm', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await setParam(t, A, 'integration.unknown.max_reconcile_attempts', 2);
    await setParam(t, A, 'integration.unknown.reconcile_intervals_s', '30,60');
    const p = await readyPerson(t, A);
    await emailFlow(t, A);
    scenario.current = 'UNKNOWN_BUT_PUBLISHED';
    const runId = await fire(t, A, p);
    scenario.current = null;
    require('../../../src/features/marketing/publications/adapters/sandbox/sandbox.store').revoke(A.companyId, 'EMAIL'); // a consulta ao provedor passa a falhar
    await due(t, A, at(31));
    let s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.reconcile_attempts, s.due_at], ['UNKNOWN', 1, iso(at(91))], 'espera da 2ª consulta = 2º valor de integration.unknown.reconcile_intervals_s');
    await due(t, A, at(92));
    s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.error_code, s.reconcile_attempts, s.due_at], ['FAILED', 'MKT_DELIVERY_UNKNOWN_EXHAUSTED', 2, null]);
    assert.equal((await runOf(t, runId)).status, 'FAILED');
    assert.deepEqual(await states(t, p), ['UNKNOWN'], 'o CRM continua UNKNOWN: o e-mail pode ter saído');
    assert.equal(sent(A), 1, 'nenhum reenvio às cegas');
    assert.deepEqual(callsOf(s.action_key), ['envio', 'consulta', 'consulta'], 'só consultas depois do timeout');
  });
});

test('cofre_fora_por_um_instante_vira_RETRY_e_o_email_sai_quando_o_cofre_volta', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await emailFlow(t, A);
    env.vaultDown();
    const runId = await fire(t, A, p);
    const s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.error_code, s.attempts], ['RETRY', 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE', 1], 'transitória, não FAILED');
    const espera = new Date(s.due_at).getTime() - T0.getTime();
    assert.ok(espera >= 3750 && espera <= 6250, `backoff da 1ª tentativa com jitter de 25% sobre 5 s (${espera} ms)`);
    assert.equal((await messages(t, A, p)).length, 0, 'nada saiu, nada é fingido no CRM');
    env.vaultBack();
    await due(t, A, at(10));
    assert.equal((await sendOf(t, runId)).status, 'OK');
    assert.deepEqual(await states(t, p), ['SENT']);
    assert.equal((await runOf(t, runId)).status, 'COMPLETED');
    assert.equal(sent(A), 1);
  });
});

test('opt_out_entre_as_tentativas_bloqueia_e_cancela_a_mensagem_que_estava_na_fila', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await emailFlow(t, A);
    scenario.current = 'HTTP_429';
    const runId = await fire(t, A, p);
    scenario.current = null;
    await env.addConsent(t, A, p, 'EMAIL', 'MARKETING', 'OPT_OUT', at(20));
    await due(t, A, at(40));
    const s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.error_code, s.due_at], ['SKIPPED', 'OPT_OUT', null], 'o canSend da hora vale');
    const run = await runOf(t, runId);
    assert.deepEqual([run.status, run.blocked_reason], ['BLOCKED', 'OPT_OUT']);
    assert.deepEqual(await states(t, p), ['CANCELLED'], 'a fila não fica pendurada');
    assert.equal(sent(A), 0);
  });
});

test('supressao_durante_a_nova_tentativa_mantem_a_run_ate_fechar_a_mensagem_da_fila', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await emailFlow(t, A);
    scenario.current = 'HTTP_429';
    const runId = await fire(t, A, p);
    scenario.current = null;
    await env.suppressEmail(t, A, p);
    let run = await runOf(t, runId);
    assert.deepEqual([run.status, run.blocked_reason, iso(run.next_due_at)], ['WAITING', 'SUPPRESSED', iso(at(30))], 'com envio aberto a run não fecha antes de fechar a mensagem');
    await due(t, A, at(31));
    assert.deepEqual([(await sendOf(t, runId)).status, (await sendOf(t, runId)).error_code], ['SKIPPED', 'SUPPRESSED']);
    run = await runOf(t, runId);
    assert.deepEqual([run.status, run.blocked_reason], ['BLOCKED', 'SUPPRESSED']);
    assert.deepEqual(await states(t, p), ['CANCELLED']);
    assert.equal(sent(A), 0);
  });
});

test('automacao_pausada_durante_a_nova_tentativa_fecha_a_acao_e_a_mensagem_sem_enviar', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const flow = await emailFlow(t, A);
    scenario.current = 'HTTP_5XX';
    const runId = await fire(t, A, p);
    scenario.current = null;
    await env.q(t, "UPDATE marketing.automation_flows SET status = 'PAUSED' WHERE id = :id RETURNING id", { id: flow.flowId });
    await due(t, A, at(3600));
    assert.deepEqual([(await sendOf(t, runId)).status, (await sendOf(t, runId)).error_code], ['SKIPPED', 'AUTOMATION_PAUSED']);
    assert.deepEqual([(await runOf(t, runId)).status, (await runOf(t, runId)).blocked_reason], ['BLOCKED', 'AUTOMATION_PAUSED']);
    assert.deepEqual(await states(t, p), ['CANCELLED']);
    assert.equal(sent(A), 0);
  });
});

test('falha_definitiva_do_canal_vira_FAILED_na_hora_e_nunca_e_reenviada', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await emailFlow(t, A);
    scenario.current = 'REJECTED';
    const runId = await fire(t, A, p);
    scenario.current = null;
    const s = await sendOf(t, runId);
    assert.deepEqual([s.status, s.error_code, s.due_at], ['FAILED', 'MKT_ACTION_FAILED', null], 'conteúdo recusado (VALIDATION): sem retry');
    assert.equal((await runOf(t, runId)).status, 'FAILED');
    await due(t, A, at(3600));
    assert.equal(sent(A), 0);
  });
});

test('a_tarefa_seguinte_executa_e_a_run_so_fecha_quando_o_envio_fecha', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    await emailFlow(t, A, { after: [env.TASK()] });
    scenario.current = 'HTTP_429';
    const runId = await fire(t, A, p);
    const run = await runOf(t, runId);
    assert.deepEqual(run.actions_result.map((e) => e.status), ['RETRY', 'OK'], 'o envio em nova tentativa não impede a ação interna, como a ação adiada pelo silêncio');
    assert.equal(run.status, 'WAITING');
    scenario.current = null;
    await due(t, A, at(31));
    const done = await runOf(t, runId);
    assert.deepEqual([done.status, done.actions_result.map((e) => e.status)], ['COMPLETED', ['OK', 'OK']]);
    assert.equal(sent(A), 1);
  });
});

test('o_banco_aceita_a_acao_RETRY_no_resultado_da_run_e_continua_recusando_estado_desconhecido', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const ok = await env.q(t, "SELECT marketing.actions_result_valid(CAST(:j AS jsonb)) AS v", { j: JSON.stringify([{ action_key: 'k', status: 'RETRY', due_at: iso(T0) }]) });
    assert.equal(ok[0].v, true, 'migration 762: RETRY é um estado válido da ação');
    const bad = await env.q(t, "SELECT marketing.actions_result_valid(CAST(:j AS jsonb)) AS v", { j: JSON.stringify([{ action_key: 'k', status: 'QUEUED' }]) });
    assert.equal(bad[0].v, false);
  });
});
