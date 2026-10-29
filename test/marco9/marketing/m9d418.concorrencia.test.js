'use strict';

// M9-D418 — opt-out simultâneo ao envio: a trava única de (pessoa, canal, finalidade) decide; nunca duas mensagens depois do commit
// da supressão. Conexões separadas com COMMIT real: só em banco descartável (DISPOSABLE_DB=1 e DATABASE_ADMIN_URL).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { canSend } = require('../../../src/features/marketing/suppression/canSend');
const { suppress } = require('../../../src/features/marketing/suppression/suppression.service');
const env = require('../_helpers/mktPolicyEnv');
const { SKIP, committedFixture, cleanup, sleep, withTenantTransaction } = require('../_helpers/mktCommit');

let A;
before(async () => { ({ a: A } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const INSTANT = new Date('2026-11-06T15:00:00Z');

/** Tenta enviar: canSend com reserva; segura a transação `holdMs` depois (a trava só solta no commit). */
const sendAttempt = (fx, runId, holdMs) => withTenantTransaction(A, async (t) => {
  const decision = await canSend(fx.personId, 'WHATSAPP', 'MARKETING', INSTANT, { tenant: A, transaction: t, officialTemplate: true, reserve: { runId, actionKey: env.sha(env.uid()) } });
  await sleep(holdMs);
  return decision;
});
const optOut = (fx, holdMs = 0) => withTenantTransaction(A, async (t) => {
  const result = await suppress({ personId: fx.personId, channel: 'WHATSAPP', reason: 'OPT_OUT', source: 'QA-M9-CONCORRENCIA' }, A, t);
  await sleep(holdMs);
  return result;
});
const reservedCount = async (fx) => (await withTenantTransaction(A, (t) => env.q(t, 'SELECT actions_result FROM marketing.automation_runs WHERE subject_id = :p', { p: fx.personId })))
  .reduce((sum, r) => sum + r.actions_result.length, 0);

test('opt_out_simultaneo_ao_envio', { skip: SKIP }, async () => {
  // 1) o envio pega a trava primeiro: a mensagem já reservada sai (o opt-out vale para os próximos); o opt-out espera e vence depois
  const first = await committedFixture(A, 2);
  try {
    const sending = sendAttempt(first, first.runIds[0], 500);
    await sleep(150); // o envio já tomou a trava
    const [sent, suppressed] = await Promise.all([sending, optOut(first)]);
    assert.equal(sent.allowed, true);
    assert.equal(suppressed.replay, false);
    assert.equal(await reservedCount(first), 1);
    const after = await sendAttempt(first, first.runIds[1], 0);
    assert.deepEqual([after.allowed, after.reason], [false, 'SUPPRESSED'], 'nenhuma segunda mensagem depois do commit da supressão');
    assert.equal(await reservedCount(first), 1);
  } finally { await cleanup(first); }

  // 2) o opt-out pega a trava primeiro: o envio espera, relê a supressão e é bloqueado
  const second = await committedFixture(A, 2);
  try {
    const suppressing = optOut(second, 500);
    await sleep(150);
    const [suppressed, sent] = await Promise.all([suppressing, sendAttempt(second, second.runIds[0], 0)]);
    assert.equal(suppressed.replay, false);
    assert.deepEqual([sent.allowed, sent.reason], [false, 'SUPPRESSED']);
    assert.equal(await reservedCount(second), 0, 'nada foi reservado depois do opt-out');
  } finally { await cleanup(second); }

  // 3) rajada: 6 envios e um opt-out ao mesmo tempo; tudo o que sai fica antes do commit da supressão e depois dele nada mais
  const burst = await committedFixture(A, 6);
  try {
    const results = await Promise.all([...burst.runIds.map((id) => sendAttempt(burst, id, 0)), optOut(burst)]);
    const sentCount = results.slice(0, 6).filter((r) => r.allowed).length;
    assert.equal(await reservedCount(burst), sentCount, 'só foram reservados os envios permitidos');
    assert.ok(sentCount <= 3, 'o cap global também vale na rajada');
    const late = await sendAttempt(burst, burst.runIds[0], 0);
    assert.equal(late.reason, 'SUPPRESSED');
  } finally { await cleanup(burst); }
});
