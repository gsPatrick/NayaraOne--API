'use strict';

// M9-D425 — a mudança de estado do kill switch (serviço): validação do corpo, auditoria antes/depois, histórico imutável, idempotência, motivo configurável, isolamento
// entre empresas, concorrência, incidente CRITICAL e conta comprometida. Postgres real (RLS FORCE); rollback, exceto os testes de concorrência (COMMITAM e limpam).

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const env = require('../_helpers/m9d425Env');

const { ks, on, off, change, mkCampaign, q, flagRow, auditOf, logOf, asTenant } = env;
const code = (promise) => Promise.resolve(promise).then(() => null, (e) => [e.statusCode, e.code]);
let A;
let B;
before(async () => { ({ a: A, b: B } = await env.tenants()); });
afterEach(() => { ks.registerIncidentResolver(null); ks.registerCompromisedHandler(null); });
after(() => sequelize.close());

test('corpo_invalido_e_motivo_minimo_configuravel', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const parse = (body) => ks.parseChange(body, A, t);
    const reason = 'Motivo válido de teste.';
    assert.deepEqual(await code(parse({ scope: 'TUDO', active: true, reason })), [400, 'MKT_KILL_SWITCH_INPUT_INVALID']);
    assert.deepEqual(await code(parse({ scope: 'GLOBAL', active: 'sim', reason })), [400, 'MKT_KILL_SWITCH_INPUT_INVALID']);
    assert.deepEqual(await code(parse({ scope: 'GLOBAL', active: true, reason, targetId: 'x' })), [400, 'MKT_KILL_SWITCH_INPUT_INVALID']);
    assert.deepEqual(await code(parse({ scope: 'CHANNEL', active: true, reason })), [400, 'MKT_KILL_SWITCH_INPUT_INVALID']);
    assert.deepEqual(await code(parse({ scope: 'GLOBAL', active: true, reason, compromised: 'x' })), [400, 'MKT_KILL_SWITCH_INPUT_INVALID']);
    assert.deepEqual(await code(parse(null)), [400, 'MKT_KILL_SWITCH_INPUT_INVALID']);
    assert.deepEqual(await code(parse({ scope: 'CHANNEL', targetId: 'TELEGRAM', active: true, reason })), [404, 'MKT_KILL_SWITCH_TARGET_NOT_FOUND']);
    assert.deepEqual(await code(parse({ scope: 'CAMPAIGN', targetId: 'não-é-uuid', active: true, reason })), [404, 'MKT_KILL_SWITCH_TARGET_NOT_FOUND']);
    assert.deepEqual(await code(parse({ scope: 'AUTOMATION', targetId: '00000000-0000-4000-8000-000000000001', active: true, reason: 'ok' })), [400, 'MKT_REASON_REQUIRED']);
    assert.deepEqual(await code(parse({ scope: 'GLOBAL', active: true, reason: '123456789' })), [400, 'MKT_REASON_REQUIRED']);
    assert.deepEqual(await code(parse({ scope: 'GLOBAL', active: true, reason: '123456789', compromised: true })), [400, 'MKT_REASON_REQUIRED'], 'o motivo vem antes da regra da conta comprometida');
    assert.deepEqual(await code(parse({ scope: 'GLOBAL', active: true, reason, compromised: true })), [422, 'MKT_KILL_SWITCH_COMPROMISED_SCOPE']);
    assert.deepEqual(await code(parse({ scope: 'AUTOMATION', active: false, reason, targetId: '00000000-0000-4000-8000-000000000001', compromised: true })), [422, 'MKT_KILL_SWITCH_COMPROMISED_SCOPE']);
    const ok = await parse({ scope: ' channel ', targetId: ' whatsapp ', active: true, reason: '  Motivo válido de teste.  ', compromised: true });
    assert.deepEqual(ok, { scope: 'CHANNEL', targetId: 'WHATSAPP', active: true, reason: 'Motivo válido de teste.', compromised: true });
    // o mínimo do motivo é parâmetro da empresa (padrão 10); o schema recusa valor fora da faixa
    await upsertSetting('marketing.killswitch.motivo_min_caracteres', 30, A, A.userId, t);
    const err = await parse({ scope: 'GLOBAL', active: true, reason: 'Vinte caracteres ok.' }).catch((e) => e);
    assert.deepEqual([err.statusCode, err.code, err.message, err.details.minChars], [400, 'MKT_REASON_REQUIRED', 'Informe o motivo (mínimo 30 caracteres).', 30]);
    await assert.rejects(() => upsertSetting('marketing.killswitch.motivo_min_caracteres', 1, A, A.userId, t));
    await assert.rejects(() => upsertSetting('marketing.killswitch.motivo_min_caracteres', 'abc', A, A.userId, t));
    await upsertSetting('marketing.killswitch.motivo_min_caracteres', 3, A, A.userId, t);
    assert.equal((await parse({ scope: 'GLOBAL', active: true, reason: 'abc' })).reason, 'abc');
  });
});

test('auditoria_antes_depois_historico_imutavel_e_idempotencia', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const c = await mkCampaign(t, A);
    const first = await on(t, A, 'CAMPAIGN', c.id, { now: new Date('2031-01-05T10:00:00Z') });
    assert.deepEqual([first.changed, first.previouslyActive, first.active, first.source], [true, false, true, 'MANUAL']);
    const second = await on(t, A, 'CAMPAIGN', c.id);
    assert.deepEqual([second.changed, second.logId], [false, null], 'já ativo: devolve o estado, sem nova linha');
    const restored = await off(t, A, 'CAMPAIGN', c.id);
    assert.deepEqual([restored.changed, restored.active], [true, false]);
    assert.equal((await off(t, A, 'CAMPAIGN', c.id)).changed, false, 'reativar o desligado também é no-op');
    const trail = await auditOf(t, A, c.id);
    assert.equal(trail.length, 2, 'duas auditorias: acionou e reativou');
    assert.deepEqual(trail.map((a) => [a.before_json.active, a.after_json.active, a.actor_user_id]), [[false, true, A.userId], [true, false, A.userId]]);
    assert.equal(trail[0].reason, 'QA-M9 teste do kill switch');
    assert.deepEqual([trail[0].after_json.scope, trail[0].after_json.targetId, trail[0].after_json.source], ['CAMPAIGN', c.id, 'MANUAL']);
    const log = await logOf(t, A, 'CAMPAIGN', c.id);
    assert.deepEqual(log.map((r) => [r.action, r.active_before, r.active_after, r.source]), [['ACTIVATE', false, true, 'MANUAL'], ['RESTORE', true, false, 'MANUAL']]);
    // o histórico é só de inserção: o papel de runtime não altera nem apaga
    await assert.rejects(() => q(t, "UPDATE marketing.kill_switch_log SET reason = 'adulterado' WHERE company_id = :c", { c: A.companyId }));
  });
  await withRollbackTenantTransaction(A, async (t) => {
    await on(t, A, 'GLOBAL');
    await assert.rejects(() => q(t, 'DELETE FROM marketing.kill_switch_log WHERE company_id = :c', { c: A.companyId }));
  });
});

test('flag_do_registro_guarda_versao_dono_e_risco_e_a_chave_nao_muda', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await on(t, A, 'GLOBAL');
    const flag = await flagRow(t, A, 'marketing.sending.kill');
    assert.deepEqual([flag.value, flag.version, flag.is_kill_switch, flag.risk, flag.probe, flag.state], [true, 2, true, 'CRITICAL', 'marketing.kill.envio_parado', 'ACTIVE']);
    await off(t, A, 'GLOBAL');
    assert.equal((await flagRow(t, A, 'marketing.sending.kill')).version, 3);
    const all = await ks.ensureKillSwitches(A, A.userId, t);
    assert.deepEqual(all.map((r) => r.key).sort(), ['marketing.channel.email.kill', 'marketing.channel.facebook.kill', 'marketing.channel.instagram.kill', 'marketing.channel.linkedin.kill',
      'marketing.channel.portal.kill', 'marketing.channel.site.kill', 'marketing.channel.tiktok.kill', 'marketing.channel.whatsapp.kill', 'marketing.channel.youtube.kill', 'marketing.sending.kill']);
    assert.ok(all.every((r) => r.is_kill_switch && r.risk === 'CRITICAL' && r.probe === 'marketing.kill.envio_parado' && r.value === false));
    assert.equal((await ks.ensureKillSwitches(A, A.userId, t)).length, 10, 'idempotente');
  });
});

test('isolamento_entre_empresas_o_kill_switch_de_uma_nao_vale_para_a_outra', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const campaignA = await mkCampaign(t, A);
    await on(t, A, 'GLOBAL');
    await on(t, A, 'CHANNEL', 'EMAIL');
    await on(t, A, 'CAMPAIGN', campaignA.id);
    assert.equal((await ks.readKillState(A, { channel: 'EMAIL', campaignId: campaignA.id }, t)).active.length, 3);
    await asTenant(t, A, B, async () => {
      assert.deepEqual((await ks.readKillState(B, { channel: 'EMAIL', campaignId: campaignA.id }, t)).active, [], 'a empresa B não é afetada');
      assert.deepEqual(await code(on(t, B, 'CAMPAIGN', campaignA.id)), [404, 'MKT_KILL_SWITCH_TARGET_NOT_FOUND'], 'a campanha de A não existe para B');
      await on(t, B, 'CHANNEL', 'EMAIL');
      assert.equal((await q(t, "SELECT count(*)::int AS n FROM governance.feature_flags WHERE key = 'marketing.sending.kill'", {}))[0].n, 0, 'B não enxerga a chave global de A (RLS)');
    });
    assert.equal((await q(t, "SELECT count(*)::int AS n FROM marketing.kill_switch_log WHERE scope = 'CHANNEL'", {}))[0].n, 1, 'A só vê o seu próprio histórico');
  });
});

test('incidente_critical_suspende_outbound', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const incident = 'INC-2031-0042';
    const r = await ks.activateFromIncident({ tenant: A, incidentId: incident, actorUserId: A.userId, transaction: t });
    assert.deepEqual([r.scope, r.active, r.source, r.changed], ['GLOBAL', true, 'INCIDENT_CRITICAL', true]);
    assert.equal((await env.send(t, A, { channel: 'EMAIL', personId: await env.readyPerson(t, A), purpose: 'MARKETING', actionKey: env.key(), subject: 'x', text: 'y', unsubscribeUrl: 'https://www.exemplo.test/d?t=1' })).reason, 'KILL_SWITCH');
    const [entry] = await logOf(t, A, 'GLOBAL', null);
    assert.deepEqual([entry.source, entry.incident_id, entry.actor_user_id], ['INCIDENT_CRITICAL', incident, A.userId]);
    assert.match(entry.reason, /INC-2031-0042/);
    // a reativação exige o incidente resolvido: sem resolvedor, ou com o incidente aberto, 409 e nada muda
    assert.deepEqual(await code(off(t, A, 'GLOBAL')), [409, 'MKT_KILL_SWITCH_INCIDENT_OPEN']);
    ks.registerIncidentResolver(async () => false);
    assert.deepEqual(await code(off(t, A, 'GLOBAL')), [409, 'MKT_KILL_SWITCH_INCIDENT_OPEN']);
    ks.registerIncidentResolver(async () => { throw new Error('módulo de incidentes fora do ar'); });
    assert.deepEqual(await code(off(t, A, 'GLOBAL')), [409, 'MKT_KILL_SWITCH_INCIDENT_OPEN'], 'falha ao consultar = não resolvido');
    assert.equal((await ks.readKillState(A, {}, t)).blocked, true);
    let asked;
    ks.registerIncidentResolver(async ({ incidentId, tenant }) => { asked = [incidentId, tenant.companyId]; return true; });
    const back = await off(t, A, 'GLOBAL');
    assert.deepEqual([back.active, asked], [false, [incident, A.companyId]]);
    assert.equal((await ks.readKillState(A, {}, t)).blocked, false);
    // dados do incidente são obrigatórios
    assert.deepEqual(await code(ks.activateFromIncident({ tenant: A, incidentId: '', actorUserId: A.userId, transaction: t })), [422, 'MKT_KILL_SWITCH_INCIDENT_INVALID']);
    assert.deepEqual(await code(ks.activateFromIncident({ tenant: A, incidentId: incident, actorUserId: null, transaction: t })), [422, 'MKT_KILL_SWITCH_INCIDENT_INVALID']);
  });
});

test('incidente_sobre_bloqueio_manual_passa_a_ser_o_dono_e_acionamento_manual_posterior_nao_tem_trava', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await on(t, A, 'GLOBAL');
    const r = await ks.activateFromIncident({ tenant: A, incidentId: 'INC-77', actorUserId: A.userId, transaction: t });
    assert.deepEqual([r.changed, r.source], [false, 'INCIDENT_CRITICAL'], 'o estado já era ligado; o incidente assume a origem');
    assert.equal((await logOf(t, A, 'GLOBAL', null)).length, 2);
    assert.equal((await auditOf(t, A, (await flagRow(t, A, 'marketing.sending.kill')).id)).length, 2);
    assert.deepEqual(await code(off(t, A, 'GLOBAL')), [409, 'MKT_KILL_SWITCH_INCIDENT_OPEN']);
    ks.registerIncidentResolver(async () => true);
    await off(t, A, 'GLOBAL');
    ks.registerIncidentResolver(null);
    await on(t, A, 'GLOBAL'); // acionamento manual novo: a origem volta a ser MANUAL e reativar não depende de incidente
    await off(t, A, 'GLOBAL');
  });
});

test('conta_comprometida_ativa_o_canal_e_chama_o_tratador_sem_perder_o_bloqueio_se_ele_falhar', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const pending = await change(t, A, { scope: 'CHANNEL', targetId: 'INSTAGRAM', active: true, compromised: true });
    assert.deepEqual([pending.source, pending.active, pending.compromised], ['COMPROMISED_ACCOUNT', true, { handled: false, pending: true }]);
    await off(t, A, 'CHANNEL', 'INSTAGRAM');
    const seen = [];
    ks.registerCompromisedHandler(async (args) => { seen.push([args.channel, args.actorUserId, typeof args.reason]); return { revoked: true }; });
    const done = await change(t, A, { scope: 'CHANNEL', targetId: 'INSTAGRAM', active: true, compromised: true });
    assert.deepEqual([done.compromised, seen], [{ handled: true, revoked: true }, [['INSTAGRAM', A.userId, 'string']]]);
    // marcar de novo um canal já ligado como comprometido ainda executa a sequência (e registra a origem)
    assert.equal((await change(t, A, { scope: 'CHANNEL', targetId: 'INSTAGRAM', active: true, compromised: true })).compromised.handled, true);
    assert.equal(seen.length, 2);
    await off(t, A, 'CHANNEL', 'INSTAGRAM');
    ks.registerCompromisedHandler(async () => { const e = new Error('falha ao revogar'); e.code = 'ADAPTER_REVOKE_FAILED'; throw e; });
    const failed = await change(t, A, { scope: 'CHANNEL', targetId: 'FACEBOOK', active: true, compromised: true });
    assert.deepEqual([failed.active, failed.compromised], [true, { handled: false, error: 'ADAPTER_REVOKE_FAILED' }]);
    assert.equal((await ks.readKillState(A, { channel: 'FACEBOOK' }, t)).blocked, true, 'a falha do tratador mantém o bloqueio');
    assert.equal((await logOf(t, A, 'CHANNEL', 'FACEBOOK'))[0].compromised, true);
  });
});

test('concorrencia_duas_ativacoes_do_mesmo_escopo_gravam_uma_so_mudanca', async () => {
  const T = A;
  try {
    const run = () => env.comTenant(T, async (t) => change(t, T, { scope: 'CHANNEL', targetId: 'TIKTOK', active: true }));
    const results = await Promise.all([run(), run(), run()]);
    assert.equal(results.filter((r) => r.changed).length, 1, 'só uma mudou o estado; as outras viram no-op depois da trava');
    assert.ok(results.every((r) => r.active === true));
    const rows = await env.adminQuery("SELECT count(*)::int AS n FROM marketing.kill_switch_log WHERE company_id = $1 AND scope = 'CHANNEL' AND target_id = 'TIKTOK'", [A.companyId]);
    assert.equal(rows.rows[0].n, 1);
    // um worker lendo em paralelo vê sempre o estado já confirmado (nunca intermediário)
    const seen = await env.comTenant(A, (t) => ks.readKillState(A, { channel: 'TIKTOK' }, t));
    assert.equal(seen.blocked, true);
  } finally {
    await env.adminQuery("DELETE FROM governance.flag_versions WHERE company_id = $1 AND key = 'marketing.channel.tiktok.kill'", [A.companyId]);
    await env.adminQuery("DELETE FROM governance.feature_flags WHERE company_id = $1 AND key = 'marketing.channel.tiktok.kill'", [A.companyId]);
    await env.adminQuery('ALTER TABLE marketing.kill_switch_log DISABLE TRIGGER kill_switch_log_guard');
    await env.adminQuery("DELETE FROM marketing.kill_switch_log WHERE company_id = $1 AND target_id = 'TIKTOK'", [A.companyId]);
    await env.adminQuery('ALTER TABLE marketing.kill_switch_log ENABLE TRIGGER kill_switch_log_guard');
  }
});
