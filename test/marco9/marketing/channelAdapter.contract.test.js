'use strict';

// M9-D430 — suíte ÚNICA de contrato do ChannelAdapter de Marketing (MKT-011), rodada contra cada um dos 9 canais em modo SANDBOX (em CI).
// Em LAB, com conta real, a mesma suíte roda contra o adapter real (runChannelContract aceita a fábrica). Sem banco: o sandbox é puro.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const adapters = require('../../../src/features/marketing/publications/adapters');
const env = require('../_helpers/mktChannelEnv');

const { CHANNELS, CONTRACT_CHECKS, runChannelContract } = adapters;
const fresh = (channel, extra = {}) => env.sandboxFor(channel, extra);

test('adapter_contract_suite_roda_em_todos_os_9_canais', async () => {
  assert.deepEqual([...CHANNELS].sort(), ['EMAIL', 'FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'PORTAL', 'SITE', 'TIKTOK', 'WHATSAPP', 'YOUTUBE']);
  assert.ok(CONTRACT_CHECKS.length >= 8, 'a suíte tem as verificações do item 4 da demanda');
  for (const channel of CHANNELS) {
    const report = await runChannelContract(channel, { make: (scope, extra) => fresh(channel, { scope, ...extra }) });
    assert.equal(report.channel, channel);
    assert.equal(report.mode, 'SANDBOX');
    assert.deepEqual(report.results.filter((r) => !r.ok), [], `canal ${channel}`);
    assert.equal(report.ok, true);
    assert.equal(report.results.length, CONTRACT_CHECKS.length);
  }
});

for (const channel of CHANNELS) {
  const op = env.operationOf(channel);

  test(`sandbox_e_deterministico [${channel}]: mesma entrada, mesma saída, em instâncias e escopos diferentes`, async () => {
    const a = await fresh(channel, { scope: 'A' })[op](env.payload(), { idempotencyKey: 'chave-det-0001' });
    const b = await fresh(channel, { scope: 'B' })[op](env.payload(), { idempotencyKey: 'chave-det-0001' });
    assert.deepEqual(a, b);
    assert.equal(a.sandbox, true);
    assert.equal(a.mode, 'SANDBOX');
    const outra = await fresh(channel, { scope: 'C' })[op](env.payload({ texto: 'outro texto' }), { idempotencyKey: 'chave-det-0001' });
    assert.notEqual(outra.providerRef, a.providerRef, 'o hash do payload entra na resposta');
  });

  test(`timeout_vira_unknown_em_todos [${channel}]: o cenário TIMEOUT devolve UNKNOWN no contrato`, async () => {
    const r = await fresh(channel)[op](env.payload(), { idempotencyKey: 'chave-timeout-01', scenario: 'TIMEOUT' });
    assert.equal(r.status, 'UNKNOWN');
    assert.equal(r.unknown, true);
    assert.equal(r.error.code, 'TIMEOUT');
    assert.equal(r.sandbox, true);
  });

  test(`redaction_de_segredo_em_todos_os_adapters [${channel}]: segredo nunca aparece em resultado nem em log`, async () => {
    const adapter = fresh(channel);
    const segredo = 'sk_live_51HsegredoMuitoLongo9876543210abcdef';
    const bearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.assinaturaSecreta123';
    for (const scenario of [undefined, 'REJECTED', 'HTTP_5XX', 'UNKNOWN_BUT_PUBLISHED']) {
      const r = await adapter[op](env.payload({ apiKey: segredo, headers: { authorization: bearer } }), { idempotencyKey: `chave-red-${scenario || 'ok'}`, scenario });
      const dump = JSON.stringify(r) + JSON.stringify(adapter.logEntries());
      assert.ok(!dump.includes(segredo) && !dump.includes('assinaturaSecreta123'), `vazou em ${scenario || 'OK'}`);
    }
    assert.ok(adapter.logEntries().length > 0, 'o adapter registra o que faz (já redigido)');
  });

  test(`webhook_assinatura_invalida_recusa [${channel}]: 401 MKT_WEBHOOK_SIGNATURE_INVALID e assinatura boa passa`, async () => {
    const secret = 'segredo-do-webhook-qa-m9';
    const adapter = fresh(channel, { webhookSecrets: [secret] });
    const body = Buffer.from(JSON.stringify({ id: 'evt-1', type: 'message.delivered', resourceId: 'sbx-ref-1', status: 'DELIVERED' }));
    const t = Math.floor(Date.now() / 1000);
    const bom = crypto.createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
    const ok = adapter.parseWebhook({ 'x-signature': `t=${t},v1=${bom}` }, body);
    assert.equal(ok.eventId, 'evt-1');
    assert.equal(ok.channel, channel);
    for (const headers of [{ 'x-signature': `t=${t},v1=${'0'.repeat(64)}` }, {}, { 'x-signature': 'lixo' }]) {
      assert.throws(() => adapter.parseWebhook(headers, body), (e) => e.statusCode === 401 && e.code === 'MKT_WEBHOOK_SIGNATURE_INVALID' && e.message === 'Assinatura do webhook inválida.');
    }
    const semSegredo = fresh(channel);
    assert.throws(() => semSegredo.parseWebhook({ 'x-signature': `t=${t},v1=${bom}` }, body), (e) => e.code === 'MKT_WEBHOOK_SIGNATURE_INVALID', 'sem segredo configurado nunca aceita');
  });
}
