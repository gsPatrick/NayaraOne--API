'use strict';

// M9-D429 por HTTP real: o webhook assinado de status de entrega do canal aplicado à mensagem do CRM (idempotente por evento e por status, o mais avançado vence,
// FAILED não sobrescreve READ) e o descadastro do e-mail (POST /marketing/unsubscribe, pública, token assinado) que chega à supressão. Os dados são COMMITADOS e
// removidos no fim. Só em banco descartável; nenhum endpoint de MFA é chamado nem token forjado.
process.env.PORT = process.env.M9D429_HTTP_PORT || '21429';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d211Env');
const aiEnv = require('../_helpers/aiHttpEnv');
const msg = require('../_helpers/mktMsgEnv');

let tenant; let offVault; let personIds = [];
before(async () => {
  ({ tenant } = await env.carregarTenants());
  offVault = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => {
  for (const id of personIds) {
    for (const sql of ['DELETE FROM marketing.suppression_list WHERE person_id = $1', 'DELETE FROM crm.messages WHERE person_id = $1', 'DELETE FROM people.communication_consents WHERE person_id = $1',
      'DELETE FROM people.person_contacts WHERE person_id = $1', 'DELETE FROM people.persons WHERE id = $1']) await aiEnv.admin(sql, [id]).catch(() => {});
  }
  offVault();
  await env.sequelize.close();
  process.exit(0);
});

const committedPerson = async () => {
  const id = await env.comTenant(tenant, (t) => msg.readyPerson(t, tenant));
  personIds.push(id);
  return id;
};
const message = async (personId, actionKey) => (await aiEnv.admin('SELECT status, delivery_status, external_message_id FROM crm.messages WHERE person_id = $1 AND action_key = $2', [personId, actionKey])).rows[0];
const eventId = () => `evt-d429-${env.uniqueSuffix()}`;
const post = (c, channel, body) => { const raw = Buffer.from(JSON.stringify(body), 'utf8'); return env.postar(`/v1/marketing/webhooks/${channel}?provider=${c.provider}&token=${c.canal}`, raw, env.assinar(c.segredo, raw)); };

test('webhook_de_status_idempotente_aplica_o_mais_avancado_na_mensagem_do_crm', { skip: aiEnv.SKIP }, async () => {
  const personId = await committedPerson();
  const key = msg.key();
  const sent = await env.comTenant(tenant, async (t) => {
    await msg.openWindow(t, tenant, personId, 1);
    return msg.send(t, tenant, { channel: 'WHATSAPP', personId, purpose: 'MARKETING', actionKey: key, text: 'Olá! Novidades no seu Radar.' }, { now: msg.NOON_SP, mode: 'SANDBOX' });
  });
  assert.equal(sent.status, 'SENT', JSON.stringify(sent));
  const ref = sent.providerRef;
  const canal = await env.criarCanal(tenant);

  const e1 = eventId();
  const delivered = await post(canal, 'WHATSAPP', { id: e1, type: 'message.delivered', resourceId: ref, status: 'DELIVERED' });
  assert.deepEqual([delivered.status, delivered.json.data.status], [200, 'accepted']);
  assert.equal((await message(personId, key)).delivery_status, 'DELIVERED');
  // o mesmo evento de novo é duplicado e nada muda; outro evento com o mesmo status também não muda
  assert.equal((await post(canal, 'WHATSAPP', { id: e1, type: 'message.delivered', resourceId: ref, status: 'DELIVERED' })).json.data.status, 'duplicate');
  assert.equal((await post(canal, 'WHATSAPP', { id: eventId(), type: 'message.delivered', resourceId: ref, status: 'DELIVERED' })).status, 200);
  assert.equal((await message(personId, key)).delivery_status, 'DELIVERED');
  // READ avança; FAILED tardio não sobrescreve; evento de mensagem desconhecida é aceito e ignorado
  await post(canal, 'WHATSAPP', { id: eventId(), type: 'message.read', resourceId: ref, status: 'READ' });
  assert.equal((await message(personId, key)).status, 'READ');
  await post(canal, 'WHATSAPP', { id: eventId(), type: 'message.failed', resourceId: ref, status: 'FAILED' });
  assert.equal((await message(personId, key)).status, 'READ');
  assert.equal((await post(canal, 'WHATSAPP', { id: eventId(), type: 'message.delivered', resourceId: 'sbx-whatsapp-naoexiste', status: 'DELIVERED' })).status, 200);
  // assinatura inválida: 401 e nada muda
  const bad = Buffer.from(JSON.stringify({ id: eventId(), resourceId: ref, status: 'FAILED' }));
  assert.equal((await env.postar(`/v1/marketing/webhooks/WHATSAPP?provider=${canal.provider}&token=${canal.canal}`, bad, env.assinar('segredo-errado', bad))).status, 401);
  assert.equal((await message(personId, key)).status, 'READ');
});

test('descadastro_do_email_por_token_assinado_chega_a_supressao', { skip: aiEnv.SKIP }, async () => {
  const personId = await committedPerson();
  const { signUnsubscribeToken } = msg.messaging;
  const token = await signUnsubscribeToken({ companyId: tenant.companyId, personId, channel: 'EMAIL' });
  const url = '/v1/marketing/unsubscribe';
  const ok = await env.postar(url, JSON.stringify({ token }));
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.data.unsubscribed, ok.json.data.channel, ok.json.data.replay], [true, 'EMAIL', false]);
  const rows = (await aiEnv.admin('SELECT reason, source, channel, purpose FROM marketing.suppression_list WHERE person_id = $1', [personId])).rows;
  assert.deepEqual(rows, [{ reason: 'OPT_OUT', source: 'UNSUBSCRIBE_LINK', channel: 'EMAIL', purpose: null }]);
  // o consentimento da pessoa também ficou OPT_OUT e o mesmo link de novo é inofensivo (replay)
  assert.ok((await aiEnv.admin("SELECT 1 FROM people.communication_consents WHERE person_id = $1 AND channel = 'EMAIL' AND status = 'OPT_OUT'", [personId])).rows.length >= 1);
  assert.equal((await env.postar(url, JSON.stringify({ token }))).json.data.replay, true);
  // a pessoa suprimida deixa de receber
  const after = await env.comTenant(tenant, (t) => msg.send(t, tenant, { channel: 'EMAIL', personId, purpose: 'MARKETING', actionKey: msg.key(), subject: 'Oi', text: 'Olá', unsubscribeUrl: 'https://www.exemplo.test/d' }, { mode: 'SANDBOX' }));
  assert.equal(after.reason, 'SUPPRESSED');
  // token adulterado, de outra pessoa ou de outra empresa, e lixo: 404 sem pista
  const [v, c, p, ch, mac] = token.split('.');
  const forged = [`${v}.${c}.${crypto.randomUUID()}.${ch}.${mac}`, `${v}.${crypto.randomUUID()}.${p}.${ch}.${mac}`, `${v}.${c}.${p}.WHATSAPP.${mac}`, `${v}.${c}.${p}.${ch}.${'0'.repeat(64)}`, 'lixo'];
  for (const bad of forged) {
    const r = await env.postar(url, JSON.stringify({ token: bad }));
    assert.deepEqual([r.status, r.json.error.code], [404, 'MKT_UNSUBSCRIBE_LINK_INVALID'], bad);
  }
  assert.equal((await env.postar(url, JSON.stringify({}))).status, 404);
});
