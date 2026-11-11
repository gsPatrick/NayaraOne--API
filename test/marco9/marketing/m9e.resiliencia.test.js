'use strict';

// Verificação K=7 do e-mail de campanha, item 5 (INT-005, INT-006, §7/§8 de Integrações e MKT §12): falha transitória do provedor ou do cofre não vira
// perda definitiva, resultado incerto fica UNKNOWN até reconciliar, nada é enviado duas vezes e nada fica aberto para sempre. Caminho real da campanha
// (runLifecycleTick -> disparo -> porta -> sendMarketingMessage -> ChannelAdapter sandbox), banco descartável, RLS real, transação com rollback.
const env = require('../_helpers/m9eEnv');
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const sandboxStore = require('../../../src/features/marketing/publications/adapters/sandbox/sandbox.store');

const { q, readyPerson, campaignFor, tick, one, deliveries, messagesOf, sent, setParam, audits, stepOf, at, T0, scenario } = env;
let A;
before(async () => { ({ a: A } = await env.tenants()); });
beforeEach(() => env.setUp());
afterEach(() => env.tearDown());
after(async () => { await sequelize.close(); });

const iso = (d) => new Date(d).toISOString();

test('429_vira_RETRY_sem_gastar_tentativa_respeita_o_retry_after_e_sai_quando_o_provedor_volta', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    scenario.current = 'HTTP_429';
    await tick(t, A, T0);
    let d = await one(t, c.id);
    assert.deepEqual([d.status, d.reason, d.attempts, d.rate_deferrals], ['RETRY', 'HTTP_429', 1, 1], 'transitória: RETRY, o 429 não conta como tentativa gasta');
    assert.equal(iso(d.next_attempt_at), iso(at(30)), 'espera = Retry-After do canal (30 s), maior que o backoff da 1ª tentativa');
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['QUEUED'], 'o CRM mostra a mensagem na fila, sem fingir envio');
    const resumo = (await campaigns.getCampaign(A, c.id, t)).deliveries;
    assert.equal(resumo.byStatus.RETRY, 1); assert.equal(resumo.reasonsByStatus.RETRY.HTTP_429, 1); assert.equal(resumo.open, 1); assert.equal(resumo.nextAttemptAt, iso(at(30)));
    assert.equal((await stepOf(t, c.id)).status, 'SCHEDULED', 'o step não fecha com entrega aberta');

    scenario.current = null; // o provedor volta
    await tick(t, A, at(15));
    assert.equal((await one(t, c.id)).status, 'RETRY', 'antes da hora marcada nada é reenviado');
    assert.equal(sent(A), 0);
    await tick(t, A, at(40));
    d = await one(t, c.id);
    assert.deepEqual([d.status, d.reason], ['SENT', null]);
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['SENT'], 'a mesma mensagem do CRM (mesma chave) passa a SENT');
    assert.equal((await stepOf(t, c.id)).status, 'SENT');
    await tick(t, A, at(400));
    assert.equal(sent(A), 1, 'um único envio ao provedor');
  });
});

test('5xx_esgota_as_tentativas_parametrizadas_com_backoff_e_fecha_FAILED_sem_deixar_mensagem_na_fila', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await setParam(t, A, 'integration.retry.max_attempts', 2);
    await setParam(t, A, 'integration.retry.base_delay_ms', 60000);
    await setParam(t, A, 'integration.retry.jitter_pct', 0);
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    scenario.current = 'HTTP_5XX';
    await tick(t, A, T0);
    let d = await one(t, c.id);
    assert.deepEqual([d.status, d.reason, d.attempts], ['RETRY', 'HTTP_503', 1]);
    assert.equal(iso(d.next_attempt_at), iso(at(60)), 'backoff = integration.retry.base_delay_ms do administrador');
    await tick(t, A, at(30));
    assert.equal((await one(t, c.id)).attempts, 1, 'antes do backoff nada acontece');
    await tick(t, A, at(61));
    d = await one(t, c.id);
    assert.deepEqual([d.status, d.reason, d.attempts, d.next_attempt_at], ['FAILED', 'MKT_DELIVERY_RETRIES_EXHAUSTED', 2, null], 'limite = integration.retry.max_attempts');
    const [m] = await messagesOf(t, A, p);
    assert.equal(m.delivery_status, 'FAILED', 'a mensagem do CRM não fica QUEUED para sempre');
    assert.match(m.failure_reason, /tentativas de envio acabaram/);
    const [aud] = await audits(t, A, 'marketing.campaign.delivery.failed', d.id);
    assert.equal(aud.before_json.status, 'RETRY'); assert.equal(aud.after_json.status, 'FAILED'); assert.equal(aud.after_json.lastCode, 'HTTP_503');
    assert.equal((await stepOf(t, c.id)).status, 'SENT', 'sem entrega aberta o step fecha');
    const resumo = (await campaigns.getCampaign(A, c.id, t)).deliveries;
    assert.equal(resumo.byStatus.FAILED, 1); assert.equal(resumo.reasonsByStatus.FAILED.MKT_DELIVERY_RETRIES_EXHAUSTED, 1); assert.equal(resumo.reprocessable, 1); assert.equal(resumo.open, 0);
    scenario.current = null;
    await tick(t, A, at(900));
    assert.equal((await one(t, c.id)).status, 'FAILED', 'fila morta: só o reprocessamento reabre');
    assert.equal(sent(A), 0);
  });
});

test('timeout_com_o_email_entregue_fica_UNKNOWN_e_a_reconciliacao_marca_SENT_sem_reenviar', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    scenario.current = 'UNKNOWN_BUT_PUBLISHED';
    await tick(t, A, T0);
    let d = await one(t, c.id);
    assert.deepEqual([d.status, d.reason, d.reconcile_attempts], ['UNKNOWN', 'CHANNEL_UNKNOWN', 0], 'timeout não é falha definitiva');
    assert.equal(iso(d.next_attempt_at), iso(at(30)), '1ª consulta depois de integration.unknown.reconcile_intervals_s[0]');
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['UNKNOWN']);
    assert.equal((await stepOf(t, c.id)).status, 'SCHEDULED');
    scenario.current = null;
    await tick(t, A, at(31));
    d = await one(t, c.id);
    assert.deepEqual([d.status, d.reconcile_attempts], ['SENT', 1]);
    assert.match(d.external_ref, /^sbx-email-/, 'a referência vem do provedor');
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['SENT'], 'o CRM passa a SENT pela confirmação do provedor');
    assert.equal(sent(A), 1, 'nada foi reenviado');
    const [aud] = await audits(t, A, 'marketing.campaign.delivery.reconciled', d.id);
    assert.deepEqual([aud.before_json.status, aud.after_json.status, aud.after_json.found], ['UNKNOWN', 'SENT', true]);
  });
});

test('timeout_sem_o_email_entregue_reconcilia_e_so_entao_reenvia_com_a_mesma_chave', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    scenario.current = 'UNKNOWN_NOT_PUBLISHED';
    await tick(t, A, T0);
    assert.equal((await one(t, c.id)).status, 'UNKNOWN');
    assert.equal(sent(A), 0);
    scenario.current = null;
    await tick(t, A, at(31));
    const d = await one(t, c.id);
    assert.deepEqual([d.status, d.attempts], ['SENT', 2]);
    const msgs = await messagesOf(t, A, p);
    assert.deepEqual(msgs.map((m) => m.delivery_status), ['SENT'], 'uma única mensagem no CRM, a mesma da 1ª tentativa');
    assert.equal(sent(A), 1, 'um único registro no provedor');
    const [aud] = await audits(t, A, 'marketing.campaign.delivery.reconciled', d.id);
    assert.equal(aud.after_json.found, false, 'a consulta veio antes do reenvio');
  });
});

test('consulta_do_UNKNOWN_sem_resposta_espera_e_esgota_para_a_fila_morta_sem_fingir_falha_no_crm', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await setParam(t, A, 'integration.unknown.max_reconcile_attempts', 2);
    await setParam(t, A, 'integration.unknown.reconcile_intervals_s', '30,60');
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    scenario.current = 'UNKNOWN_BUT_PUBLISHED';
    await tick(t, A, T0);
    scenario.current = null;
    sandboxStore.revoke(A.companyId, 'EMAIL'); // a consulta ao provedor passa a falhar (resposta não conclusiva)
    await tick(t, A, at(31));
    let d = await one(t, c.id);
    assert.deepEqual([d.status, d.reconcile_attempts], ['UNKNOWN', 1]);
    assert.equal(iso(d.next_attempt_at), iso(at(91)), 'espera da 2ª consulta = 2º valor de integration.unknown.reconcile_intervals_s');
    await tick(t, A, at(92));
    d = await one(t, c.id);
    assert.deepEqual([d.status, d.reason, d.reconcile_attempts, d.next_attempt_at], ['FAILED', 'MKT_DELIVERY_UNKNOWN_EXHAUSTED', 2, null]);
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['UNKNOWN'], 'o CRM continua UNKNOWN: o e-mail pode ter saído');
    assert.equal(sent(A), 1, 'nenhum reenvio às cegas');
  });
});

test('cofre_fora_por_um_instante_vira_RETRY_e_o_email_sai_quando_o_cofre_volta', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    env.vaultDown();
    await tick(t, A, T0);
    const d = await one(t, c.id);
    assert.deepEqual([d.status, d.reason, d.attempts], ['RETRY', 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE', 1], 'o caso da homologação: transitória, não FAILED');
    const espera = new Date(d.next_attempt_at).getTime() - T0.getTime();
    assert.ok(espera >= 3750 && espera <= 6250, `backoff da 1ª tentativa com jitter de 25% sobre 5 s (${espera} ms)`);
    assert.equal((await messagesOf(t, A, p)).length, 0, 'nada saiu, nada é fingido no CRM');
    env.vaultBack();
    await tick(t, A, at(10));
    assert.deepEqual([(await one(t, c.id)).status], ['SENT']);
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['SENT']);
    assert.equal(sent(A), 1);
  });
});

test('opt_out_entre_as_tentativas_bloqueia_e_cancela_a_mensagem_que_estava_na_fila', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    scenario.current = 'HTTP_429';
    await tick(t, A, T0);
    scenario.current = null;
    await env.addConsent(t, A, p, 'EMAIL', 'MARKETING', 'OPT_OUT', at(20));
    await tick(t, A, at(40));
    assert.deepEqual([(await one(t, c.id)).status, (await one(t, c.id)).reason], ['BLOCKED', 'OPT_OUT']);
    assert.deepEqual((await messagesOf(t, A, p)).map((m) => m.delivery_status), ['CANCELLED'], 'a fila não fica pendurada');
    assert.equal(sent(A), 0);
  });
});

test('campanha_encerrada_cancela_o_RETRY_e_so_reconcilia_o_UNKNOWN_sem_reenviar', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p1 = await readyPerson(t, A);
    const p2 = await readyPerson(t, A);
    const x = await campaignFor(t, A, [p1]);
    scenario.current = 'HTTP_429';
    await tick(t, A, T0);
    const y = await campaignFor(t, A, [p2]);
    scenario.current = 'UNKNOWN_BUT_PUBLISHED';
    await tick(t, A, at(5));
    assert.equal((await one(t, x.id)).status, 'RETRY');
    assert.equal((await one(t, y.id)).status, 'UNKNOWN');
    scenario.current = null;
    await tick(t, A, new Date('2031-12-10T21:01:00Z')); // depois do fim (18:00 em São Paulo)
    const dx = await one(t, x.id);
    assert.deepEqual([dx.status, dx.reason, dx.next_attempt_at], ['CANCELLED', 'CAMPAIGN_ENDED', null], 'campanha encerrada não continua');
    assert.deepEqual((await messagesOf(t, A, p1)).map((m) => m.delivery_status), ['CANCELLED']);
    assert.equal((await one(t, y.id)).status, 'SENT', 'o UNKNOWN da campanha encerrada só é reconciliado: o provedor tinha o e-mail');
    assert.equal(sent(A), 1, 'nenhum envio depois do fim');
    const [aud] = await audits(t, A, 'marketing.campaign.delivery.cancelled', dx.id);
    assert.deepEqual([aud.before_json.status, aud.after_json.status], ['RETRY', 'CANCELLED']);
  });
});

test('falha_definitiva_do_canal_vira_FAILED_na_hora_e_nunca_e_reenviada', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p1 = await readyPerson(t, A);
    const p2 = await readyPerson(t, A);
    const c1 = await campaignFor(t, A, [p1]);
    scenario.current = 'REJECTED';
    await tick(t, A, T0);
    const c2 = await campaignFor(t, A, [p2]);
    scenario.current = 'AUTH_EXPIRED';
    await tick(t, A, at(1));
    scenario.current = null;
    await tick(t, A, at(3600));
    const d1 = await one(t, c1.id); const d2 = await one(t, c2.id);
    assert.deepEqual([d1.status, d1.reason, d1.attempts, d1.next_attempt_at], ['FAILED', 'REJECTED', 1, null], 'conteúdo recusado (VALIDATION): sem retry');
    assert.deepEqual([d2.status, d2.reason, d2.attempts], ['FAILED', 'AUTH_EXPIRED', 1], 'credencial (AUTH): sem retry');
    assert.equal(sent(A), 0);
    assert.equal((await campaigns.getCampaign(A, c1.id, t)).deliveries.reprocessable, 0, 'recusa definitiva não é reprocessável');
  });
});

test('o_banco_nao_aceita_entrega_aberta_sem_hora_de_voltar_nem_mudanca_de_linha_final_ou_de_identidade', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const p = await readyPerson(t, A);
    const outra = await readyPerson(t, A);
    const c = await campaignFor(t, A, [p]);
    await tick(t, A, T0);
    const [d] = await deliveries(t, c.id);
    assert.equal(d.status, 'SENT');
    const tentar = async (sql, re, extra = {}) => {
      await sequelize.query('SAVEPOINT g', { transaction: t });
      await assert.rejects(() => q(t, sql, { id: d.id, p: outra, ...extra }), re);
      await sequelize.query('ROLLBACK TO SAVEPOINT g', { transaction: t });
    };
    const copia = (key, status, next) => `INSERT INTO marketing.campaign_step_deliveries (group_id, company_id, campaign_id, step_id, person_id, action_key, status, next_attempt_at)
      SELECT group_id, company_id, campaign_id, step_id, :p, repeat('${key}', 64), '${status}', ${next} FROM marketing.campaign_step_deliveries WHERE id = :id RETURNING id`;
    await tentar("UPDATE marketing.campaign_step_deliveries SET status = 'RETRY', next_attempt_at = now() WHERE id = :id", /MKT_DELIVERY_FINAL/);
    await tentar("UPDATE marketing.campaign_step_deliveries SET reason = 'X' WHERE id = :id", /MKT_DELIVERY_FINAL/);
    await tentar(copia('e', 'RETRY', 'NULL'), /mkt_campaign_step_deliveries_next_chk/);
    await tentar(copia('f', 'FAILED', 'now()'), /mkt_campaign_step_deliveries_next_chk/);
    const [failed] = await q(t, copia('a', 'FAILED', 'NULL'), { id: d.id, p: outra });
    await tentar('UPDATE marketing.campaign_step_deliveries SET person_id = :p2 WHERE id = :f', /MKT_DELIVERY_IDENTITY/, { f: failed.id, p2: p });
    const [reaberta] = await q(t, "UPDATE marketing.campaign_step_deliveries SET status = 'RETRY', next_attempt_at = now() WHERE id = :f RETURNING updated_at", { f: failed.id });
    assert.ok(reaberta.updated_at, 'FAILED pode voltar à fila (reprocessamento) e o gatilho carimba updated_at');
  });
});
