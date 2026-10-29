'use strict';

// Marco 9, M9-D213 — replay: horário assinado fora da tolerância (401), mesmo evento reenviado (duplicate, nada reprocessa), id derivado do corpo e a ordem
// tamanho -> assinatura -> horário -> leitura do JSON.
process.env.PORT = process.env.M9D213_REPLAY_PORT || '21215';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d212Env');
const settingsService = require('../../../src/features/settings/settings.service');
const { MessagingSandboxAdapter } = require('../../../src/features/integrations/providers/messaging/sandbox/messaging-sandbox.adapter');
const { refusalsCount } = require('../../../src/features/integrations/webhooks/webhooks.metrics');

let tenant;
let desligarCofre;
const agora = () => Math.floor(Date.now() / 1000);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

test('replay_timestamp_fora_da_janela_recusado', async () => {
  const c = await env.criarCanal(tenant);
  const antes = await refusalsCount(c.provider, 'INTEGRATION_WEBHOOK_REPLAY');
  const velho = env.evento();
  const r = await env.enviar(c, velho, { t: agora() - 12 * 60 });
  assert.equal(r.status, 401, 'assinatura válida, mas o horário assinado tem 12 min com tolerância de 5');
  assert.equal(r.json.error.code, 'INTEGRATION_WEBHOOK_REPLAY');
  assert.equal(r.json.error.message, 'Evento fora da janela de tempo permitida.');
  assert.equal((await env.inbox(tenant, c.provider, velho.id)).length, 0, 'nada é gravado');
  assert.equal(await refusalsCount(c.provider, 'INTEGRATION_WEBHOOK_REPLAY'), antes + 1, 'a recusa é contada');
  const [erro] = await env.erros(tenant, c.provider, 'INTEGRATION_WEBHOOK_REPLAY');
  assert.ok(erro && !JSON.stringify(erro).includes(velho.id), 'o erro de integração não leva o conteúdo do evento');
  const adiantado = await env.enviar(c, env.evento(), { t: agora() + 12 * 60 });
  assert.equal(adiantado.status, 401, 'horário adiantado além da tolerância também é recusado');
  const recente = await env.enviar(c, env.evento(), { t: agora() - 2 * 60 });
  assert.equal(recente.status, 200, 'dentro da tolerância passa');
  await env.comTenant(tenant, (t) => settingsService.upsertSetting('integration.webhook.timestamp_tolerance_s', 900, tenant, tenant.userId, t));
  try {
    const mais = await env.enviar(c, env.evento(), { t: agora() - 12 * 60 });
    assert.equal(mais.status, 200, 'a tolerância é parâmetro da empresa (integration.webhook.timestamp_tolerance_s)');
  } finally {
    await env.sql(tenant, "DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'integration.webhook.timestamp_tolerance_s'", { c: tenant.companyId });
  }
});

test('replay_mesmo_event_id_nao_reprocessa', async () => {
  const c = await env.criarCanal(tenant);
  const ev = env.evento({ status: 'DELIVERED' });
  const primeiro = await env.enviar(c, ev);
  assert.equal(primeiro.json.status, 'accepted');
  await env.rodar(tenant);
  const dois = await env.enviar(c, ev, { t: agora() - 120 });
  assert.deepEqual([dois.status, dois.json], [200, { status: 'duplicate', eventId: ev.id }], 'reenvio 2 min depois dentro da janela: duplicate');
  await env.rodar(tenant);
  const l = await env.linha(tenant, c.provider, ev.id);
  assert.equal(l.attempts, 1);
  assert.equal((await env.outboxDe(tenant, l.id)).length, 1, 'nada reprocessa');
  const conteudoDiferente = await env.enviar(c, { ...ev, status: 'READ' });
  assert.equal(conteudoDiferente.json.status, 'duplicate', 'mesmo id com conteúdo diferente também não grava segunda linha');
  assert.equal((await env.erros(tenant, c.provider, 'WEBHOOK_PAYLOAD_MISMATCH')).length >= 1, true, 'e a adulteração fica registrada');
});

test('replay_id_derivado_sem_event_id', async () => {
  const c = await env.criarCanal(tenant);
  const original = MessagingSandboxAdapter.prototype.webhookDerivesEventId;
  MessagingSandboxAdapter.prototype.webhookDerivesEventId = () => true;
  try {
    const { id: _id, ...semId } = env.evento({ status: 'SENT' });
    const bruto = Buffer.from(JSON.stringify(semId));
    const t = agora();
    const esperado = sha(`${c.provider}:${t}:${sha(bruto)}`);
    const a = await env.enviar(c, bruto, { t });
    assert.deepEqual([a.status, a.json], [200, { status: 'accepted', eventId: esperado }], 'id = sha256(fornecedor:horário:hash do corpo)');
    const b = await env.enviar(c, bruto, { t });
    assert.deepEqual([b.status, b.json.status], [200, 'duplicate'], 'o mesmo corpo no mesmo horário não grava de novo');
    const [l] = await env.inbox(tenant, c.provider, esperado);
    assert.ok(l, 'a linha da caixa de entrada leva o id derivado');
    assert.equal(l.status, 'RECEIVED');
  } finally {
    MessagingSandboxAdapter.prototype.webhookDerivesEventId = original;
  }
  const { id: _x, ...outro } = env.evento();
  const r = await env.enviar(c, outro);
  assert.equal(r.json.status, 'rejected_to_dlq', 'fornecedor que costuma mandar id e veio sem: EVENT_ID_MISSING, não id derivado');
});

test('payload_assinatura_antes_dos_limites_de_estrutura', async () => {
  const c = await env.criarCanal(tenant);
  const fundo = JSON.stringify(JSON.parse(`${'{"a":'.repeat(30)}1${'}'.repeat(30)}`));
  const corpo = Buffer.from(`{"id":"x-${env.uniqueSuffix()}","type":"t.e","n":${fundo}}`);
  const caminho = `/v1/webhooks/${c.provider}/${c.canal}`;
  const falsa = await env.postar(caminho, corpo, { 'x-signature': `t=${agora()},v1=${'0'.repeat(64)}` });
  assert.equal(falsa.status, 401, 'assinatura inválida: 401, e a estrutura nem é olhada');
  assert.equal(falsa.json.error.code, 'INTEGRATION_WEBHOOK_SIGNATURE_INVALID');
  const velhaEFalsa = await env.postar(caminho, corpo, { 'x-signature': `t=${agora() - 3600},v1=${'0'.repeat(64)}` });
  assert.equal(velhaEFalsa.json.error.code, 'INTEGRATION_WEBHOOK_SIGNATURE_INVALID', 'a assinatura vem antes da conferência de horário');
  const lixo = Buffer.from('{isto nao e json');
  const velhaValida = await env.enviar(c, lixo, { t: agora() - 3600 });
  assert.equal(velhaValida.json.error.code, 'INTEGRATION_WEBHOOK_REPLAY', 'assinatura válida e horário velho: replay antes de ler o JSON');
  const valida = await env.enviar(c, corpo);
  assert.deepEqual([valida.status, valida.json], [200, { status: 'rejected_to_dlq' }], 'só com a assinatura válida a estrutura é conferida');
  const grande = Buffer.alloc(1048576 + 2048, 'a');
  const gigante = await env.postar(caminho, grande, { 'x-signature': `t=${agora()},v1=${'0'.repeat(64)}` });
  assert.equal(gigante.status, 413, 'o tamanho vem antes da assinatura');
});
