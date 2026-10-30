'use strict';

// M9-D872 — acionar e restaurar o kill switch pela API real (banco descartável): acionar sem MFA, restaurar com MFA, motivo, auditoria, sem segundo aprovador, confirmação por nível
// (linha 14 do inventário da M9-D852), impacto, isolamento e permissão. Nunca chama endpoint de MFA.
process.env.PORT = process.env.M9D872_HTTP_TEST_PORT || '21872';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../_helpers/m9d872Http');
const probes = require('../../../src/features/core-governance/feature-flags/kill-switch/probes/registry');
const D = require('../../../src/shared/destructive-actions');

let state;
let A;
let counter = 0;
const PROBE = 'qa.m9d872.http_probe';
const skip = () => state && state.skip;
before(async () => {
  probes.registerProbe({ name: PROBE, version: '1', run: async () => ({ pass: true }) });
  state = await h.start();
  A = state.tenants && state.tenants.A;
});
after(async () => {
  if (state && !state.skip) {
    await h.dropMfa(A);
    await h.adminQuery("DELETE FROM governance.flag_versions WHERE key LIKE 'qa.m9d872.http_%'");
    await h.adminQuery("DELETE FROM governance.feature_flags WHERE key LIKE 'qa.m9d872.http_%'");
  }
  await h.stop();
});

const keyOf = () => `qa.m9d872.http_${Date.now().toString(36)}_${counter++}`;
const create = (over = {}) => h.call('A:gestor', 'POST', '/feature-flags', { key: keyOf(), value: false, ownerUserId: A.userId, isKillSwitch: true, risk: 'CRITICAL', probe: PROBE, description: 'Interrompe o envio de teste.', ...over });
const impact = (body) => h.call('A:gestor', 'POST', '/feature-flags/impact', body);
const understood = (impactToken) => ({ confirmation: { understood: true, impactToken } });
const restoreConfirm = (key, impactToken, over = {}) => ({ confirmation: { typedCode: key, justification: 'Incidente encerrado, voltar a enviar.', impactToken, ...over } });

test('m9d872 as duas ações do kill switch estão ligadas ao inventário da M9-D852 (linha 14)', () => {
  for (const key of ['kill_switch.activate', 'kill_switch.restore']) {
    const entry = D.inventory.get(key);
    assert.equal(entry.wired, true, key);
    assert.deepEqual([entry.method, entry.route, entry.permission], ['PATCH', '/feature-flags', 'governance:flags:manage']);
    assert.equal(entry.impact.path, '/feature-flags/impact');
  }
  assert.deepEqual([D.inventory.get('kill_switch.activate').level, D.inventory.get('kill_switch.activate').mfa], [2, 'não']);
  assert.deepEqual([D.inventory.get('kill_switch.restore').level, D.inventory.get('kill_switch.restore').mfa], [3, 'sim']);
  assert.ok(D.registry.registeredKeys().includes('kill_switch.activate') && D.registry.registeredKeys().includes('kill_switch.restore'));
});

test('m9d872 acionar kill switch nao exige MFA e restaurar exige MFA sem segundo aprovador', { skip: skip() }, async () => {
  const made = await create();
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const flag = made.body.data;
  await h.enableMfaWithoutStepUp(A); // MFA habilitado, porém sem verificação recente
  // acionar: nível 2, sem MFA, com permissão e motivo
  const sim = await impact({ key: flag.key, action: 'activate' });
  assert.equal(sim.status, 200, JSON.stringify(sim.body));
  assert.deepEqual([sim.body.data.level, sim.body.data.mfaRequired, sim.body.data.counts.switches, sim.body.data.blockers], [2, false, 1, []]);
  assert.match(sim.body.data.items[0].label, /Interrompe o envio de teste/);
  const noConfirm = await h.call('A:gestor', 'PATCH', '/feature-flags', { key: flag.key, value: true, reason: 'Incidente em andamento.' });
  assert.deepEqual([noConfirm.status, noConfirm.body.error.code], [422, 'GOV_CONFIRMATION_REQUIRED']);
  const noReason = await h.call('A:gestor', 'PATCH', '/feature-flags', { key: flag.key, value: true, ...understood(sim.body.data.impactToken) });
  assert.deepEqual([noReason.status, noReason.body.error.code], [422, 'GOV_FLAG_REASON_REQUIRED']);
  const on = await h.call('A:gestor', 'PATCH', '/feature-flags', { key: flag.key, value: true, reason: 'Incidente em andamento.', ...understood(sim.body.data.impactToken) });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual([on.body.data.value, on.body.data.version], [true, 2]);
  const again = await impact({ key: flag.key, action: 'activate' });
  const twice = await h.call('A:gestor', 'PATCH', '/feature-flags', { key: flag.key, value: true, reason: 'Repetido.', ...understood(again.body.data.impactToken) });
  assert.deepEqual([twice.status, twice.body.data.unchanged], [200, true], 'acionar o já acionado não tem efeito novo');

  // restaurar: nível 3 com MFA
  const back = await impact({ key: flag.key, action: 'restore' });
  assert.deepEqual([back.body.data.level, back.body.data.mfaRequired, back.body.data.record.code], [3, true, flag.key]);
  const noMfa = await h.call('A:gestor', 'PATCH', '/feature-flags', { key: flag.key, value: false, reason: 'Voltar.', ...restoreConfirm(flag.key, back.body.data.impactToken) });
  assert.deepEqual([noMfa.status, noMfa.body.error.code], [403, 'MFA_STEP_UP_REQUIRED']);
  assert.equal((await h.call('A:gestor', 'GET', `/feature-flags?id=${flag.id}`)).body.data.itens[0].value, true, 'sem MFA continua acionado');
  await h.grantMfa(A);
  const noCode = await h.call('A:gestor', 'PATCH', '/feature-flags', { key: flag.key, value: false, reason: 'Voltar.', ...restoreConfirm('outra.chave', back.body.data.impactToken) });
  assert.deepEqual([noCode.status, noCode.body.error.code, noCode.body.error.details.missing], [422, 'GOV_CONFIRMATION_REQUIRED', ['typedCode']]);
  const noJustification = await h.call('A:gestor', 'PATCH', '/feature-flags', { key: flag.key, value: false, reason: 'Voltar.', ...restoreConfirm(flag.key, back.body.data.impactToken, { justification: '' }) });
  assert.deepEqual(noJustification.body.error.details.missing, ['justification']);
  const ok = await h.call('A:gestor', 'PATCH', '/feature-flags', { key: flag.key, value: false, reason: 'Incidente encerrado.', ...restoreConfirm(flag.key, back.body.data.impactToken) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.data.value, ok.body.data.version], [false, 3], 'restaurar com MFA, motivo e código é uma única chamada, sem segundo aprovador');
  const audit = await h.adminQuery("SELECT reason, user_id, before_json, after_json FROM audit.audit_log WHERE entity_id = $1 AND action = 'governance.flag.changed' ORDER BY occurred_at", [flag.id]);
  assert.deepEqual(audit.rows.map((r) => r.reason).slice(-2), ['Incidente em andamento.', 'Incidente encerrado.']);
  assert.ok(audit.rows.every((r) => r.user_id === A.userId || r.user_id === null));
  const confirmed = await h.adminQuery("SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'governance.action.confirmed' AND after_json->>'actionKey' IN ('kill_switch.activate','kill_switch.restore') AND after_json->>'recordCode' = $1", [flag.key]);
  assert.ok(confirmed.rows[0].n >= 3, 'a confirmação de cada ação fica auditada');
});

test('m9d872 restaurar um switch que não está acionado é impedimento e o impacto alterado devolve 409', { skip: skip() }, async () => {
  const flag = (await create()).body.data;
  await h.grantMfa(A);
  const idle = await impact({ key: flag.key, action: 'restore' });
  assert.equal(idle.body.data.blockers.length, 1);
  const act = await impact({ id: flag.id, action: 'activate' });
  await h.call('A:gestor', 'PATCH', '/feature-flags', { id: flag.id, value: true, reason: 'Acionar.', ...understood(act.body.data.impactToken) });
  const sim = await impact({ id: flag.id, action: 'restore' });
  assert.deepEqual([sim.body.data.counts.unverified, sim.body.data.blockers], [0, []]);
  await h.adminQuery("UPDATE governance.feature_flags SET verification_state = 'UNVERIFIED' WHERE id = $1", [flag.id]);
  const changed = await h.call('A:gestor', 'PATCH', '/feature-flags', { id: flag.id, value: false, reason: 'Voltar.', ...restoreConfirm(flag.key, sim.body.data.impactToken) });
  assert.deepEqual([changed.status, changed.body.error.code], [409, 'GOV_ACTION_IMPACT_CHANGED']);
  assert.equal((await h.call('A:gestor', 'GET', `/feature-flags?id=${flag.id}`)).body.data.itens[0].value, true, 'nada executou');
  const fresh = await impact({ id: flag.id, action: 'restore' });
  assert.equal(fresh.body.data.counts.unverified, 1);
  const done = await h.call('A:gestor', 'PATCH', '/feature-flags', { id: flag.id, value: false, reason: 'Voltar.', ...restoreConfirm(flag.key, fresh.body.data.impactToken) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
});

test('m9d872 flag comum segue sem confirmação e kill switch exige probe na criação pela API', { skip: skip() }, async () => {
  const plain = await h.call('A:gestor', 'POST', '/feature-flags', { key: keyOf(), value: false, ownerUserId: A.userId });
  assert.equal(plain.status, 201);
  const edit = await h.call('A:gestor', 'PATCH', '/feature-flags', { id: plain.body.data.id, value: true, reason: 'Ligar.' });
  assert.equal(edit.status, 200, 'flag que não é kill switch não passa pelo guarda');
  const noProbe = await create({ probe: undefined });
  assert.deepEqual([noProbe.status, noProbe.body.error.code, noProbe.body.error.message], [422, 'GOV_KILL_PROBE_REQUIRED', 'Todo kill switch precisa de um teste automatizado.']);
  const metaChange = await h.call('A:gestor', 'PATCH', '/feature-flags', { id: plain.body.data.id, key: 'qa.outra.chave', reason: 'x' });
  assert.deepEqual([metaChange.status, metaChange.body.error.code], [422, 'GOV_FLAG_INPUT_INVALID'], 'a chave nunca muda: key no PATCH é só o seletor');
});

test('m9d872 permissão, isolamento entre empresas e módulo', { skip: skip() }, async () => {
  const flag = (await create()).body.data;
  const noPerm = await h.call('A:leitura', 'POST', '/feature-flags/impact', { key: flag.key, action: 'activate' });
  assert.deepEqual([noPerm.status, noPerm.body.error.code, noPerm.body.error.details.required], [403, 'PERMISSION_DENIED', 'governance:flags:manage']);
  const noAuth = await h.call(null, 'POST', '/feature-flags/impact', { key: flag.key, action: 'activate' });
  assert.equal(noAuth.status, 401);
  const other = await h.call('B:gestor', 'POST', '/feature-flags/impact', { key: flag.key, action: 'activate' });
  assert.equal(other.status, 404, 'a empresa B não enxerga o switch de A');
  const otherPatch = await h.call('B:gestor', 'PATCH', '/feature-flags', { key: flag.key, value: true, reason: 'x' });
  assert.equal(otherPatch.status, 404);
  const badAction = await impact({ key: flag.key, action: 'explodir' });
  assert.deepEqual([badAction.status, badAction.body.error.code], [422, 'GOV_FLAG_INPUT_INVALID']);
});
