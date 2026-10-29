'use strict';

// Marco 9, M9-D212 — a rota só valida, grava e responde: sem regra de negócio, dentro do prazo, 503 quando o banco não responde e evento sem id na fila morta com 200.
process.env.PORT = process.env.M9D212_ROTA_PORT || '21212';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d212Env');
const settingsService = require('../../../src/features/settings/settings.service');
const { MessagingSandboxAdapter } = require('../../../src/features/integrations/providers/messaging/sandbox/messaging-sandbox.adapter');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

test('intake_rota_responde_sem_processar_dominio', async () => {
  const c = await env.criarCanal(tenant);
  const original = MessagingSandboxAdapter.prototype.toInternalEvent;
  let conversoes = 0;
  MessagingSandboxAdapter.prototype.toInternalEvent = function contar(...args) { conversoes += 1; return original.apply(this, args); };
  try {
    const ev = env.evento({ status: 'DELIVERED' });
    const r = await env.enviar(c, ev);
    assert.deepEqual([r.status, r.json], [200, { status: 'accepted', eventId: ev.id }]);
    const l = await env.linha(tenant, c.provider, ev.id);
    assert.equal(l.status, 'RECEIVED', 'a rota só grava: nada foi processado');
    assert.equal(l.attempts, 0);
    assert.equal(l.applied, null);
    assert.equal(conversoes, 0, 'a rota não converte o evento nem chama o adapter');
    assert.equal((await env.outboxDe(tenant, l.id)).length, 0, 'nenhum evento interno nasce na rota');
    const dup = await env.enviar(c, ev);
    assert.deepEqual([dup.status, dup.json], [200, { status: 'duplicate', eventId: ev.id }]);
    await env.rodar(tenant);
    assert.equal(conversoes >= 1, true, 'quem converte é o worker');
  } finally {
    MessagingSandboxAdapter.prototype.toInternalEvent = original;
  }
});

test('intake_resposta_sob_tempo_limite', async () => {
  const c = await env.criarCanal(tenant);
  const limite = 2000;
  for (let i = 0; i < 5; i += 1) {
    const t0 = Date.now();
    const r = await env.enviar(c, env.evento());
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 < limite, 'a resposta vem antes de integration.webhook.response_timeout_ms (padrão 2000 ms)');
  }
  // Banco lento: um INSERT do mesmo evento fica esperando outra transação aberta; passou do prazo configurado, a rota responde 503 e o fornecedor reenvia.
  await env.comTenant(tenant, (t) => settingsService.upsertSetting('integration.webhook.response_timeout_ms', 300, tenant, tenant.userId, t));
  const ev = env.evento();
  const segurando = await env.sequelize.transaction();
  try {
    await env.sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: segurando });
    await env.sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: segurando });
    await env.sequelize.query(
      `INSERT INTO integration.webhook_inbox (group_id, company_id, provider_code, external_event_id, signature_valid, payload_hash)
       VALUES (:g, :c, :p, :e, true, repeat('a', 64))`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, p: c.provider, e: ev.id }, transaction: segurando }
    );
    const t0 = Date.now();
    const lento = await env.enviar(c, ev);
    assert.equal(lento.status, 503);
    assert.equal(lento.json.error.code, 'INTEGRATION_WEBHOOK_TEMPORARILY_UNAVAILABLE');
    assert.equal(lento.json.error.message, 'Recebimento temporariamente indisponível; reenvie.');
    assert.ok(Date.now() - t0 < 1500, 'a rota não espera o banco além do prazo');
  } finally {
    await segurando.rollback();
    await env.comTenant(tenant, (t) => settingsService.upsertSetting('integration.webhook.response_timeout_ms', 2000, tenant, tenant.userId, t));
  }
  const reenviado = await env.enviar(c, ev);
  assert.equal(reenviado.status, 200, 'o reenvio do fornecedor é aceito (accepted, ou duplicate se a gravação interrompida terminou)');
  assert.equal(['accepted', 'duplicate'].includes(reenviado.json.status), true);
});

test('intake_evento_sem_id_vai_para_dlq_com_200', async () => {
  const c = await env.criarCanal(tenant);
  const { id: _semId, ...semId } = env.evento({ nota: 'sem identificador' });
  const r = await env.enviar(c, semId);
  assert.deepEqual([r.status, r.json], [200, { status: 'rejected_to_dlq' }], 'nunca 4xx: o fornecedor reenviaria em laço');
  const [morta] = await env.sql(tenant, "SELECT * FROM integration.webhook_inbox WHERE connection_id = :id AND dead_letter_reason = 'EVENT_ID_MISSING'", { id: c.conn.id });
  assert.ok(morta, 'linha DEAD_LETTER com o motivo EVENT_ID_MISSING');
  assert.equal(morta.status, 'DEAD_LETTER');
  assert.equal(morta.payload_raw, null);
  const [erro] = await env.erros(tenant, c.provider, 'INTEGRATION_WEBHOOK_EVENT_ID_MISSING');
  assert.ok(erro, 'o código INTEGRATION_WEBHOOK_EVENT_ID_MISSING fica só no registro de erro');
  assert.equal(erro.message, 'Evento sem identificador externo; enviado para a fila de erros.');
  await env.rodar(tenant);
  assert.equal((await env.sql(tenant, 'SELECT attempts FROM integration.webhook_inbox WHERE id = :id', { id: morta.id }))[0].attempts, 0, 'a fila morta não vai ao worker');
});
