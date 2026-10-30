'use strict';

// M9-D425 — POST /marketing/kill-switch pela API real (banco descartável): permissão, motivo, ativação sem MFA, reativação com MFA, confirmação por nível (linha 14 do inventário
// da M9-D852), impacto, auditoria, idempotência e isolamento entre empresas. Nunca chama endpoint de MFA; o MFA recente é gravado direto no banco descartável.
process.env.PORT = process.env.M9D425_HTTP_TEST_PORT || '21425';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../_helpers/m9d425Http');
const { withConfirmation } = require('../_helpers/m9d852Confirm');

let state;
let A;
let B;
const skip = () => state && state.skip;
const ROUTE = '/marketing/kill-switch';
const IMPACT = `${ROUTE}/impact`;
const REASON = 'Conta do Instagram invadida; suspendendo as postagens.';

before(async () => {
  state = await h.start();
  A = state.tenants && state.tenants.A;
  B = state.tenants && state.tenants.B;
  if (!skip()) await h.cleanKillSwitchData([A, B]);
});
after(async () => {
  if (state && !state.skip) {
    await h.revokeRecentMfa(A.userId);
    await h.adminQuery('DELETE FROM core.mfa_credentials WHERE user_id = $1', [A.userId]);
    await h.cleanKillSwitchData([A, B]);
  }
  await h.stop();
});

/** Corpo da ação com a confirmação que a tela faria (simulação do impacto + "entendi"/código digitado + justificativa). */
const confirmed = (who, request, over = {}) => withConfirmation(h, who, IMPACT, { ...request, ...over }, { method: 'POST', body: { ...request, action: request.active ? 'activate' : 'restore' } });
const audits = async (entityId) => (await h.adminQuery("SELECT before_json, after_json, reason, user_id AS actor_user_id FROM audit.audit_log WHERE action = 'marketing.kill_switch.changed' AND entity_id = $1 ORDER BY created_at, id", [String(entityId)])).rows;

test('ativacao_nao_exige_mfa_mas_exige_permissao_e_motivo_e_compromised_fora_de_channel_e_422', { skip: skip() }, async () => {
  await h.adminQuery('DELETE FROM core.mfa_credentials WHERE user_id = $1', [A.userId]); // sem MFA nenhum: a ativação não pode depender dele
  // permissão: sem token 401; sem marketing:killswitch:manage 403 MKT_FORBIDDEN
  assert.equal((await h.call(null, 'POST', ROUTE, { scope: 'GLOBAL', active: true, reason: REASON })).status, 401);
  const denied = await h.call('A:leitura', 'POST', ROUTE, { scope: 'GLOBAL', active: true, reason: REASON });
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'MKT_FORBIDDEN']);
  assert.deepEqual([(await h.call('A:leitura', 'POST', IMPACT, { scope: 'GLOBAL', action: 'activate' })).body.error.code], ['MKT_FORBIDDEN']);
  // a simulação do impacto da ativação: nível 2, sem MFA
  const sim = await h.call('A:gestor', 'POST', IMPACT, { scope: 'CHANNEL', targetId: 'INSTAGRAM', action: 'activate' });
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.deepEqual([sim.body.data.level, sim.body.data.mfaRequired], [2, false]);
  for (const k of ['campaignsRunning', 'stepsScheduled', 'publicationsPending', 'automationsActive']) assert.equal(typeof sim.body.data.counts[k], 'number', k);
  // sem confirmação: 422 (confirmação nível 2), mesmo com motivo
  const bare = await h.call('A:gestor', 'POST', ROUTE, { scope: 'CHANNEL', targetId: 'INSTAGRAM', active: true, reason: REASON });
  assert.deepEqual([bare.status, bare.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  // motivo: ausente ou curto = 400 MKT_REASON_REQUIRED
  for (const reason of [undefined, '', '   ', 'curto']) {
    const body = await confirmed('A:gestor', { scope: 'CHANNEL', targetId: 'INSTAGRAM', active: true, ...(reason === undefined ? {} : { reason }) });
    const res = await h.call('A:gestor', 'POST', ROUTE, body);
    assert.deepEqual([res.status, res.body.error.code, res.body.error.message], [400, 'MKT_REASON_REQUIRED', 'Informe o motivo (mínimo 10 caracteres).'], String(reason));
  }
  // compromised só vale em CHANNEL
  {
    const res = await h.call('A:gestor', 'POST', ROUTE, await confirmed('A:gestor', { scope: 'GLOBAL', active: true, compromised: true, reason: REASON }));
    assert.deepEqual([res.status, res.body.error.code], [422, 'MKT_KILL_SWITCH_COMPROMISED_SCOPE']);
  }
  // alvo inexistente: 404; escopo ou active inválidos: 400
  const unknownChannel = await h.call('A:gestor', 'POST', ROUTE, { scope: 'CHANNEL', targetId: 'TELEGRAM', active: true, reason: REASON });
  assert.deepEqual([unknownChannel.status, unknownChannel.body.error.code], [404, 'MKT_KILL_SWITCH_TARGET_NOT_FOUND']);
  const ghost = { scope: 'CAMPAIGN', targetId: '00000000-0000-4000-8000-000000000425', active: true, reason: REASON };
  const unknownCampaign = await h.call('A:gestor', 'POST', ROUTE, ghost);
  assert.deepEqual([unknownCampaign.status, unknownCampaign.body.error.code], [404, 'MKT_KILL_SWITCH_TARGET_NOT_FOUND']);
  const badScope = await h.call('A:gestor', 'POST', ROUTE, { scope: 'TUDO', active: true, reason: REASON });
  assert.equal(badScope.status, 400);
  // ativação válida: sem MFA, 200, estado ligado, auditoria e histórico
  const ok = await h.call('A:gestor', 'POST', ROUTE, await confirmed('A:gestor', { scope: 'CHANNEL', targetId: 'instagram', active: true, reason: REASON }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.data.scope, ok.body.data.targetId, ok.body.data.active, ok.body.data.changed, ok.body.data.source], ['CHANNEL', 'INSTAGRAM', true, true, 'MANUAL']);
  const flag = (await h.adminQuery("SELECT id, value, is_kill_switch, risk, probe FROM governance.feature_flags WHERE company_id = $1 AND key = 'marketing.channel.instagram.kill'", [A.companyId])).rows[0];
  assert.deepEqual([flag.value, flag.is_kill_switch, flag.risk, flag.probe], [true, true, 'CRITICAL', 'marketing.kill.envio_parado']);
  const trail = await audits(flag.id);
  assert.equal(trail.length, 1);
  assert.deepEqual([trail[0].before_json.active, trail[0].after_json.active, trail[0].actor_user_id, trail[0].reason], [false, true, A.userId, REASON]);
  // idempotência: ativar o escopo já ativo devolve 200 sem nova auditoria
  const again = await h.call('A:gestor', 'POST', ROUTE, { scope: 'CHANNEL', targetId: 'INSTAGRAM', active: true, reason: REASON });
  assert.deepEqual([again.status, again.body.data.changed, again.body.data.active], [200, false, true]);
  assert.equal((await audits(flag.id)).length, 1);
});

test('reativacao_exige_motivo_mfa_e_auditoria', { skip: skip() }, async () => {
  const channel = { scope: 'CHANNEL', targetId: 'EMAIL' };
  assert.equal((await h.call('A:gestor', 'POST', ROUTE, await confirmed('A:gestor', { ...channel, active: true, reason: REASON }))).status, 200);
  await h.adminQuery(`INSERT INTO core.mfa_credentials (id, user_id, group_id, company_id, secret_encrypted, enabled, confirmed_at, recovery_codes_hash, failed_attempts, created_at, updated_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'teste-m9d425', true, now(), '{}', 0, now(), now())`, [A.userId, A.groupId, A.companyId]);
  await h.revokeRecentMfa(A.userId);
  // sem MFA recente: 403 MFA_STEP_UP_REQUIRED, antes de qualquer outra coisa (nem pede a confirmação)
  const noMfa = await h.call('A:gestor', 'POST', ROUTE, { ...channel, active: false, reason: REASON });
  assert.deepEqual([noMfa.status, noMfa.body.error.code], [403, 'MFA_STEP_UP_REQUIRED']);
  // active ausente ou inválido também é tratado como reativação (falha fechada)
  for (const active of [undefined, 'false', 0, null]) {
    const res = await h.call('A:gestor', 'POST', ROUTE, { ...channel, ...(active === undefined ? {} : { active }), reason: REASON });
    assert.deepEqual([res.status, res.body.error.code], [403, 'MFA_STEP_UP_REQUIRED'], String(active));
  }
  await h.grantRecentMfa(A);
  // com MFA, ainda falta a confirmação nível 3 (código digitado + justificativa)
  const bare = await h.call('A:gestor', 'POST', ROUTE, { ...channel, active: false, reason: REASON });
  assert.deepEqual([bare.status, bare.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  const sim = await h.call('A:gestor', 'POST', IMPACT, { ...channel, action: 'restore' });
  assert.deepEqual([sim.status, sim.body.data.level, sim.body.data.mfaRequired, sim.body.data.record.code], [200, 3, true, 'marketing.channel.email.kill']);
  // motivo curto (mesmo com a justificativa da confirmação): 400
  const short = await h.call('A:gestor', 'POST', ROUTE, await confirmed('A:gestor', { ...channel, active: false, reason: 'curto' }));
  assert.deepEqual([short.status, short.body.error.code], [400, 'MKT_REASON_REQUIRED']);
  // reativação completa: um único usuário, sem segundo aprovador
  const ok = await h.call('A:gestor', 'POST', ROUTE, await confirmed('A:gestor', { ...channel, active: false, reason: 'Incidente encerrado; canal de e-mail liberado.' }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.data.active, ok.body.data.changed], [false, true]);
  const flag = (await h.adminQuery("SELECT id, value FROM governance.feature_flags WHERE company_id = $1 AND key = 'marketing.channel.email.kill'", [A.companyId])).rows[0];
  assert.equal(flag.value, false);
  const trail = await audits(flag.id);
  assert.deepEqual(trail.map((a) => [a.before_json.active, a.after_json.active]), [[false, true], [true, false]]);
  assert.deepEqual([trail[1].actor_user_id, trail[1].reason, trail[1].after_json.scope, trail[1].after_json.targetId], [A.userId, 'Incidente encerrado; canal de e-mail liberado.', 'CHANNEL', 'EMAIL']);
  const log = (await h.adminQuery("SELECT action, source, actor_user_id, active_before, active_after, reason FROM marketing.kill_switch_log WHERE company_id = $1 AND scope = 'CHANNEL' AND target_id = 'EMAIL' ORDER BY created_at, id", [A.companyId])).rows;
  assert.deepEqual(log.map((r) => [r.action, r.active_before, r.active_after, r.actor_user_id]), [['ACTIVATE', false, true, A.userId], ['RESTORE', true, false, A.userId]]);
  // reativar o que já está desligado é no-op (sem nova auditoria)
  const noop = await h.call('A:gestor', 'POST', ROUTE, { ...channel, active: false, reason: REASON });
  assert.deepEqual([noop.status, noop.body.data.changed], [200, false]);
  assert.equal((await audits(flag.id)).length, 2);
});

test('confirmacao_nivel_2_e_3_e_impacto_alterado_e_isolamento_entre_empresas', { skip: skip() }, async () => {
  await h.grantRecentMfa(A);
  const scope = { scope: 'CHANNEL', targetId: 'LINKEDIN' };
  // impacto de reativar o que não está ligado: impedimento
  const blocked = await h.call('A:gestor', 'POST', IMPACT, { ...scope, action: 'restore' });
  assert.equal(blocked.status, 200);
  assert.deepEqual(blocked.body.data.blockers.map((b) => b.message), ['Este kill switch não está acionado.']);
  // o impacto muda entre a simulação e a ação (uma campanha entra em andamento): 409 e nada executa
  const simulated = await h.call('A:gestor', 'POST', IMPACT, { ...scope, action: 'activate' });
  const body = { ...scope, active: true, reason: REASON, confirmation: { understood: true, impactToken: simulated.body.data.impactToken } };
  const [campaign] = (await h.adminQuery(`INSERT INTO marketing.campaigns (id, group_id, company_id, code, name, objective, objective_metric, target_value, budget_amount, budget_justification, channels, status, owner_user_id, starts_at, ends_at)
    VALUES (gen_random_uuid(), $1, $2, $3, 'Campanha RUNNING QA-M9', 'Objetivo da campanha de teste', 'LEADS', 10, 0, 'teste', '{LINKEDIN}', 'RUNNING', $4, now() - interval '1 day', now() + interval '10 days') RETURNING id`, [A.groupId, A.companyId, `KS-${Date.now().toString(36)}`, A.userId])).rows;
  try {
    const changed = await h.call('A:gestor', 'POST', ROUTE, body);
    assert.deepEqual([changed.status, changed.body.error.code], [409, 'GOV_ACTION_IMPACT_CHANGED']);
    assert.equal((await h.adminQuery("SELECT 1 FROM governance.feature_flags WHERE company_id = $1 AND key = 'marketing.channel.linkedin.kill' AND value = 'true'::jsonb", [A.companyId])).rowCount, 0, 'nada executou');
    // com o impacto novo (uma campanha em andamento neste canal) a ação passa
    const fresh = await h.call('A:gestor', 'POST', IMPACT, { ...scope, action: 'activate' });
    assert.equal(fresh.body.data.counts.campaignsRunning, 1);
    const ok = await h.call('A:gestor', 'POST', ROUTE, { ...scope, active: true, reason: REASON, confirmation: { understood: true, impactToken: fresh.body.data.impactToken } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // a campanha de A não existe para B e o canal de A não vale para B
    const crossCampaign = await h.call('B:gestor', 'POST', ROUTE, { scope: 'CAMPAIGN', targetId: campaign.id, active: true, reason: REASON });
    assert.equal(crossCampaign.body.error.code === 'MKT_KILL_SWITCH_TARGET_NOT_FOUND' || crossCampaign.status === 422, true);
    const crossImpact = await h.call('B:gestor', 'POST', IMPACT, { scope: 'CAMPAIGN', targetId: campaign.id, action: 'activate' });
    assert.deepEqual([crossImpact.status, crossImpact.body.error.code], [404, 'MKT_KILL_SWITCH_TARGET_NOT_FOUND']);
    assert.equal((await h.adminQuery('SELECT kill_switch_active FROM marketing.campaigns WHERE id = $1', [campaign.id])).rows[0].kill_switch_active, false);
    const flagsB = await h.adminQuery("SELECT 1 FROM governance.feature_flags WHERE company_id = $1 AND key LIKE 'marketing.%.kill'", [B.companyId]);
    assert.equal(flagsB.rowCount, 0, 'a empresa B não ganhou nada');
  } finally {
    await h.adminQuery('DELETE FROM marketing.campaigns WHERE id = $1', [campaign.id]);
  }
});
