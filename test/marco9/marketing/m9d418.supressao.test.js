'use strict';

// M9-D418 — supressão por endereço (hash), opt-out por resposta, efeito sobre o agendado e remoção auditada. Banco descartável
// (ver m9d416.cap.test.js para o comando); transação com rollback, role de runtime (RLS FORCE).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { canSend } = require('../../../src/features/marketing/suppression/canSend');
const { suppress, liftSuppression } = require('../../../src/features/marketing/suppression/suppression.service');
const automatic = require('../../../src/features/marketing/suppression/suppression.automatic');
const { hashAddress } = require('../../../src/features/marketing/suppression/address');
const env = require('../_helpers/mktPolicyEnv');

const { addConsent, readyPerson, makeFlowVersion, makeRun, sendAction, uid, q, HOUR, NOON_SP } = env;
let A;
let B;
before(async () => { ({ a: A, b: B } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const run = (fn) => withRollbackTenantTransaction(A, fn);
const MANAGE = ['marketing:suppression:manage'];
const send = (t, personId, channel = 'WHATSAPP') => canSend(personId, channel, 'MARKETING', NOON_SP, { tenant: A, transaction: t, officialTemplate: true });
const rows = (t, personId) => q(t, 'SELECT * FROM marketing.suppression_list WHERE person_id = :p ORDER BY created_at', { p: personId });
const events = (t, personId, type) => q(t, 'SELECT payload_json FROM integration.outbox_events WHERE aggregate_id = :p AND event_type = :ty', { p: personId, ty: type });

test('palavra_sair_cria_supressao_imediata', async () => {
  await run(async (t) => {
    for (const word of ['SAIR', '  parar! ', 'Stop', 'cancelar.']) {
      const p = await readyPerson(t, A);
      const result = await automatic.handleInboundReply({ personId: p, channel: 'WHATSAPP', text: word }, A, t);
      assert.equal(result.suppressed, true, word);
      assert.equal((await send(t, p)).reason, 'SUPPRESSED', 'bloqueia na hora');
      const [row] = await rows(t, p);
      assert.deepEqual([row.reason, row.source, row.channel, row.purpose, row.active], ['OPT_OUT', 'INBOUND_REPLY:WHATSAPP', 'WHATSAPP', null, true]);
      assert.equal((await events(t, p, 'customer.opted_out')).length, 1, 'customer.opted_out emitido');
      const consent = await q(t, "SELECT status, purpose FROM people.communication_consents WHERE person_id = :p AND status = 'OPT_OUT'", { p });
      assert.deepEqual(consent, [{ status: 'OPT_OUT', purpose: 'ALL' }], 'o opt-out também fica no consentimento da pessoa');
      const audit = await q(t, "SELECT action FROM audit.audit_log WHERE entity_type = 'marketing.suppression' AND entity_id = :id", { id: row.id });
      assert.deepEqual(audit, [{ action: 'marketing.suppression.created' }]);
    }
    const other = await readyPerson(t, A);
    for (const text of ['sair daqui', 'oi', '', 'não quero sair', null]) assert.equal((await automatic.handleInboundReply({ personId: other, channel: 'WHATSAPP', text }, A, t)).suppressed, false, String(text));
    assert.equal((await send(t, other)).allowed, true);
    // palavras são do administrador
    await upsertSetting('marketing.suppression.palavras_opt_out', 'DESCADASTRAR', A, A.userId, t);
    assert.equal((await automatic.handleInboundReply({ personId: other, channel: 'WHATSAPP', text: 'sair' }, A, t)).suppressed, false);
    assert.equal((await automatic.handleInboundReply({ personId: other, channel: 'WHATSAPP', text: 'descadastrar' }, A, t)).suppressed, true);
  });
});

test('supressao_automatica_por_link_bounce_reclamacao_e_numero_invalido_e_duplicada_devolve_a_existente', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A);
    const link = await automatic.handleUnsubscribeLink({ personId: p, channel: 'EMAIL' }, A, t);
    assert.equal(link.replay, false);
    const again = await automatic.handleUnsubscribeLink({ personId: p, channel: 'EMAIL' }, A, t);
    assert.equal(again.replay, true, 'supressão duplicada devolve a existente');
    assert.equal(again.suppressions[0].id, link.suppressions[0].id);
    assert.equal((await rows(t, p)).length, 1);
    assert.equal((await events(t, p, 'customer.opted_out')).length, 1, 'sem segundo evento');
    const bounce = await readyPerson(t, A);
    await automatic.handlePermanentBounce({ personId: bounce, channel: 'EMAIL' }, A, t);
    const spam = await readyPerson(t, A);
    await automatic.handleSpamComplaint({ personId: spam, channel: 'EMAIL' }, A, t);
    const bad = await readyPerson(t, A);
    await automatic.handleInvalidNumber({ personId: bad, channel: 'WHATSAPP' }, A, t);
    assert.deepEqual([(await rows(t, bounce))[0].reason, (await rows(t, bounce))[0].source], ['BOUNCE', 'PERMANENT_BOUNCE']);
    assert.deepEqual([(await rows(t, spam))[0].reason, (await rows(t, spam))[0].source], ['COMPLAINT', 'SPAM_COMPLAINT']);
    assert.deepEqual([(await rows(t, bad))[0].reason, (await rows(t, bad))[0].source], ['BOUNCE', 'INVALID_NUMBER']);
    for (const [pid, ch] of [[bounce, 'EMAIL'], [spam, 'EMAIL'], [bad, 'WHATSAPP']]) assert.equal((await send(t, pid, ch)).reason, 'SUPPRESSED');
    await assert.rejects(suppress({ channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'x' }, A, t), (e) => e.statusCode === 422);
    await assert.rejects(suppress({ personId: p, channel: 'EMAIL', reason: 'NADA', source: 'x' }, A, t), (e) => e.statusCode === 422);
  });
});

test('supressao_guarda_apenas_hash', async () => {
  await run(async (t) => {
    const email = `QA-M9-${uid().slice(0, 6)}@Exemplo.Test`;
    const p = await readyPerson(t, A, { phone: '(11) 98765-4321', email });
    await suppress({ personId: p, channel: 'WHATSAPP', reason: 'MANUAL', source: 'QA-M9' }, A, t);
    await suppress({ personId: p, channel: 'EMAIL', reason: 'MANUAL', source: 'QA-M9', purpose: 'MARKETING' }, A, t);
    const list = await rows(t, p);
    assert.equal(list.length, 2);
    const byChannel = Object.fromEntries(list.map((r) => [r.channel, r]));
    assert.equal(byChannel.WHATSAPP.address_hash, hashAddress('+5511987654321'), 'telefone em E.164 com o país padrão');
    assert.equal(byChannel.EMAIL.address_hash, hashAddress(email.toLowerCase()), 'e-mail em minúsculas');
    const dump = JSON.stringify(list);
    assert.ok(!/987654321/.test(dump) && !/exemplo/i.test(dump), 'nenhum endereço em claro na tabela');
    // por endereço, sem pessoa: outra pessoa com o mesmo número cai na supressão
    const other = await readyPerson(t, A, { phone: '+55 11 90000-1111' });
    await suppress({ channel: 'WHATSAPP', address: '11900001111', reason: 'MANUAL', source: 'QA-M9' }, A, t);
    assert.equal((await send(t, other)).reason, 'SUPPRESSED');
  });
});

test('remover_supressao_exige_permissao_e_motivo', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A);
    const { suppressions: [row] } = await suppress({ personId: p, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    const ctx = (permissions) => ({ tenant: A, actor: A.userId, permissions });
    await assert.rejects(liftSuppression(row.id, { reason: 'Pediu para voltar', consentId: uid() }, ctx([]), t), (e) => {
      assert.equal(e.statusCode, 403);
      assert.equal(e.code, 'MKT_FORBIDDEN');
      assert.equal(e.message, 'Você não pode remover supressões.');
      return true;
    });
    await assert.rejects(liftSuppression(row.id, { reason: '  ', consentId: uid() }, ctx(MANAGE), t), (e) => e.statusCode === 422 && e.code === 'MKT_VALIDATION');
    await assert.rejects(liftSuppression(row.id, { reason: 'Pediu para voltar' }, ctx(MANAGE), t), (e) => e.statusCode === 422 && e.code === 'MKT_CONSENT_PROOF_REQUIRED');
    // OPT_IN anterior à supressão não prova nada; OPT_IN de outra pessoa ou de outro canal também não
    const old = await addConsent(t, A, p, 'WHATSAPP', 'MARKETING', 'OPT_IN', new Date(Date.now() - 24 * HOUR));
    await assert.rejects(liftSuppression(row.id, { reason: 'x', consentId: old }, ctx(MANAGE), t), (e) => e.code === 'MKT_CONSENT_PROOF_REQUIRED');
    const wrongChannel = await addConsent(t, A, p, 'EMAIL', 'MARKETING', 'OPT_IN', new Date(Date.now() + HOUR));
    await assert.rejects(liftSuppression(row.id, { reason: 'x', consentId: wrongChannel }, ctx(MANAGE), t), (e) => e.code === 'MKT_CONSENT_PROOF_REQUIRED');
    await assert.rejects(liftSuppression(uid(), { reason: 'x', consentId: old }, ctx(MANAGE), t), (e) => e.statusCode === 404);
    assert.equal((await send(t, p)).reason, 'SUPPRESSED', 'nada foi removido');

    const proof = await addConsent(t, A, p, 'WHATSAPP', 'MARKETING', 'OPT_IN', new Date(Date.now() + HOUR));
    const lifted = await liftSuppression(row.id, { reason: 'Cliente pediu para voltar a receber', consentId: proof }, ctx(MANAGE), t);
    assert.equal(lifted.replay, false);
    assert.equal(lifted.suppression.active, false);
    assert.equal(lifted.suppression.lifted_by, A.userId);
    const [audit] = await q(t, "SELECT before_json, after_json, reason, user_id FROM audit.audit_log WHERE entity_id = :id AND action = 'marketing.suppression.lifted'", { id: row.id });
    assert.equal(audit.before_json.active, true);
    assert.equal(audit.after_json.active, false);
    assert.equal(audit.after_json.consentId, proof);
    assert.equal(audit.reason, 'Cliente pediu para voltar a receber');
    assert.equal(audit.user_id, A.userId);
    assert.equal((await liftSuppression(row.id, { reason: 'repetido', consentId: proof }, ctx(MANAGE), t)).replay, true);
    // com o OPT_IN posterior (mais recente que o OPT_OUT geral) a pessoa volta a poder receber
    const after = await canSend(p, 'WHATSAPP', 'MARKETING', NOON_SP, { tenant: A, transaction: t, officialTemplate: true });
    assert.equal(after.allowed, true, JSON.stringify(after));
  });
});

test('supressao_cancela_acoes_scheduled_da_run_waiting', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A);
    const other = await readyPerson(t, A);
    const { versionId } = await makeFlowVersion(t, A);
    const scheduled = (over = {}) => sendAction({ status: 'SCHEDULED', ...over });
    const waiting = await makeRun(t, A, { versionId, personId: p, status: 'WAITING', actions: [scheduled(), scheduled({ channel: 'EMAIL' }), sendAction({ status: 'OK' })] });
    const untouched = await makeRun(t, A, { versionId, personId: p, status: 'WAITING', actions: [scheduled({ channel: 'EMAIL' })] });
    const strangers = await makeRun(t, A, { versionId, personId: other, status: 'WAITING', actions: [scheduled()] });
    const done = await makeRun(t, A, { versionId, personId: p, status: 'COMPLETED', actions: [sendAction({ status: 'OK' })] });
    const result = await suppress({ personId: p, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    assert.deepEqual(result.blockedRuns, [waiting]);
    const [w] = await q(t, 'SELECT status, blocked_reason, actions_result, finished_at, next_due_at FROM marketing.automation_runs WHERE id = :id', { id: waiting });
    assert.equal(w.status, 'BLOCKED');
    assert.equal(w.blocked_reason, 'SUPPRESSED');
    assert.deepEqual(w.actions_result.map((a) => `${a.channel}:${a.status}`), ['WHATSAPP:SKIPPED', 'EMAIL:SCHEDULED', 'WHATSAPP:OK']);
    assert.equal(w.actions_result[0].reason, 'SUPPRESSED');
    assert.ok(w.finished_at && w.next_due_at === null);
    const status = async (id) => (await q(t, 'SELECT status FROM marketing.automation_runs WHERE id = :id', { id }))[0].status;
    assert.deepEqual([await status(untouched), await status(strangers), await status(done)], ['WAITING', 'WAITING', 'COMPLETED']);
    const blocked = await events(t, waiting, 'automation.run.blocked');
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].payload_json.payload.blockedReason, 'SUPPRESSED');
    // supressão por endereço (sem pessoa) alcança a pessoa dona do endereço
    const q3 = await readyPerson(t, A, { phone: '11955550000' });
    const run3 = await makeRun(t, A, { versionId, personId: q3, status: 'WAITING', actions: [scheduled()] });
    const byAddress = await suppress({ channel: 'WHATSAPP', address: '11955550000', reason: 'MANUAL', source: 'QA-M9' }, A, t);
    assert.deepEqual(byAddress.blockedRuns, [run3]);
  });
});

test('supressao_e_isolada_por_empresa', async () => {
  await run(async (t) => {
    const p = await readyPerson(t, A, { phone: '11987654321' });
    await suppress({ personId: p, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9' }, A, t);
    const seenByB = await env.asTenant(t, A, B, () => q(t, 'SELECT count(*)::int AS n FROM marketing.suppression_list WHERE person_id = :p', { p }));
    assert.equal(seenByB[0].n, 0, 'a empresa B não enxerga a supressão da A (RLS)');
    const pb = await env.asTenant(t, A, B, async () => {
      const x = await env.makePerson(t, B);
      await env.addContact(t, B, x, 'WHATSAPP', '11987654321');
      await env.addConsent(t, B, x, 'WHATSAPP', 'MARKETING', 'OPT_IN');
      return x;
    });
    const decision = await env.asTenant(t, A, B, () => canSend(pb, 'WHATSAPP', 'MARKETING', NOON_SP, { tenant: B, transaction: t, officialTemplate: true }));
    assert.equal(decision.allowed, true, 'mesmo número em outra empresa não é suprimido pela supressão da A');
  });
});
