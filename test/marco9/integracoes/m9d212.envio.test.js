'use strict';

// Marco 9, M9-D212 (critério herdado da M9-D211 e da M9-D215) — o worker da caixa de entrada liga o evento do fornecedor ao envio: chama resolveDispatchByEvent com o
// status já normalizado pelo adapter e a origem WEBHOOK_SIGNED, e o envio em UNKNOWN se resolve sem esperar a consulta.
process.env.PORT = process.env.M9D212_ENVIO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d212Env');
const { conexao, criar, forcar, ler, chave } = require('../../integrations/dispatch/dispatchHelpers');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

/** Evento do financiamento de laboratório (adapter antigo embrulhado: HMAC-SHA256 em x-webhook-signature, sem tipo de evento). */
const enviarFinanciamento = (c, obj) => {
  const corpo = Buffer.from(JSON.stringify(obj));
  return env.postar(`/v1/webhooks/${c.provider}/${c.canal}`, corpo, { 'x-webhook-signature': `sha256=${crypto.createHmac('sha256', c.segredo).update(corpo).digest('hex')}` });
};

test('intake_evento_assinado_resolve_envio_unknown_sem_esperar_a_consulta', async () => {
  const conn = await conexao(tenant, 'FINANCING');
  const canal = await env.criarCanal(tenant, { provider: conn.providerCode });
  const k = chave();
  const envio = await criar(tenant, conn.id, k, { operation: 'submitCase', snapshot: { caseRef: 'caso-qa-m9' } });
  await forcar(tenant, envio.dispatch.id, "status = 'UNKNOWN', unknown_since = now()");
  assert.equal((await ler(tenant, envio.dispatch.id)).status, 'UNKNOWN');
  const ev = { id: `evt-bank-${env.uniqueSuffix()}`, status: 'APPROVED', resourceId: `pay-${env.uniqueSuffix()}`, idempotencyKey: k };
  const r = await enviarFinanciamento(canal, ev);
  assert.equal(r.json.status, 'accepted');
  await env.rodar(tenant);
  const depois = await ler(tenant, envio.dispatch.id);
  assert.equal(depois.status, 'CONFIRMED', 'o webhook assinado resolve o UNKNOWN na hora, sem consulta');
  assert.equal(depois.external_resource_id, ev.resourceId);
  assert.ok(depois.confirmed_at, 'confirmado pelo evento');
  assert.equal(depois.external_status, 'APPROVED', 'o status guardado é o já normalizado pelo adapter');
  const [l] = await env.inbox(tenant, canal.provider, ev.id);
  assert.deepEqual([l.status, l.applied, l.internal_status], ['PROCESSED', true, 'APPROVED']);
  const outro = await enviarFinanciamento(canal, { id: `evt-bank-${env.uniqueSuffix()}`, status: 'APPROVED', resourceId: 'pay-sem-envio', idempotencyKey: 'chave-que-nao-existe' });
  assert.equal(outro.json.status, 'accepted');
  await env.rodar(tenant);
  assert.equal((await ler(tenant, envio.dispatch.id)).status, 'CONFIRMED', 'evento sem envio ligado não muda nada nem falha');
});
