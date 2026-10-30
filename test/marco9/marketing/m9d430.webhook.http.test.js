'use strict';

// M9-D430 — POST /v1/marketing/webhooks/:channel (pública, sem JWT): a assinatura é a autorização. HTTP real contra o app de teste, connection com canal e
// segredo no cofre (o do bloco B), assinatura inválida = 401 MKT_WEBHOOK_SIGNATURE_INVALID e o evento válido cai na caixa de entrada do framework.
// Só em banco descartável (os testes COMMITAM).
process.env.PORT = process.env.M9D430_WEBHOOK_PORT || '21430';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d211Env');

let tenant;
let desligarCofre;
before(async () => {
  ({ tenant } = await env.carregarTenants());
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const caminho = (canal, c, extra = '') => `/v1/marketing/webhooks/${canal}?provider=${c.provider}&token=${c.canal}${extra}`;
const novoId = () => `evt-d430-${env.uniqueSuffix()}`;
const enviar = (canal, c, corpo, headers) => {
  const bruto = Buffer.from(corpo, 'utf8');
  return env.postar(caminho(canal, c), bruto, headers || env.assinar(c.segredo, bruto));
};

test('webhook_assinatura_invalida_recusa: 401 MKT_WEBHOOK_SIGNATURE_INVALID, sem gravar nada', async () => {
  const c = await env.criarCanal(tenant);
  const id = novoId();
  const corpo = JSON.stringify({ id, type: 'message.delivered', status: 'DELIVERED' });
  const r = await enviar('WHATSAPP', c, corpo, env.assinar('segredo-errado-qa-m9', Buffer.from(corpo)));
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'MKT_WEBHOOK_SIGNATURE_INVALID');
  assert.equal(r.json.error.message, 'Assinatura do webhook inválida.');
  assert.equal((await env.inbox(tenant, c.provider, id)).length, 0);
  const semCabecalho = await enviar('WHATSAPP', c, corpo, {});
  assert.equal(semCabecalho.status, 401);
  assert.ok((await env.erros(tenant, c.provider, 'INTEGRATION_WEBHOOK_SIGNATURE_INVALID')).length >= 1, 'a falha é registrada como erro de segurança do bloco B');
});

test('webhook_valido_e_aceito_e_vai_para_a_caixa_de_entrada_do_framework', async () => {
  const c = await env.criarCanal(tenant);
  const id = novoId();
  const corpo = JSON.stringify({ id, type: 'message.delivered', resourceId: 'sbx-ref-77', status: 'DELIVERED' });
  const r = await enviar('WHATSAPP', c, corpo);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { success: true, data: { status: 'accepted', eventId: id } });
  const [linha] = await env.inbox(tenant, c.provider, id);
  assert.ok(linha);
  assert.equal(linha.company_id, tenant.companyId);
  assert.equal(linha.event_type, 'message.delivered');
  const repetido = await enviar('WHATSAPP', c, corpo);
  assert.equal(repetido.json.data.status, 'duplicate');
});

test('webhook_de_canal_desconhecido_ou_sem_token_valido_responde_404_sem_vazar_nada', async () => {
  const c = await env.criarCanal(tenant);
  const corpo = JSON.stringify({ id: novoId(), type: 'x' });
  const bruto = Buffer.from(corpo);
  const h = env.assinar(c.segredo, bruto);
  const orkut = await env.postar(caminho('ORKUT', c), bruto, h);
  assert.deepEqual([orkut.status, orkut.json.error.code], [404, 'MKT_CHANNEL_NOT_FOUND']);
  const semToken = await env.postar(`/v1/marketing/webhooks/EMAIL?provider=${c.provider}&token=nao-existe-nenhum-canal-assim-1`, bruto, h);
  assert.deepEqual([semToken.status, semToken.json.error.code], [404, 'MKT_CHANNEL_NOT_FOUND']);
});

test('webhook_fora_da_janela_de_tempo_e_replay: 401 antes de qualquer gravação', async () => {
  const c = await env.criarCanal(tenant);
  const corpo = JSON.stringify({ id: novoId(), type: 'message.delivered' });
  const bruto = Buffer.from(corpo);
  const velho = Math.floor(Date.now() / 1000) - 24 * 3600;
  const r = await env.postar(caminho('EMAIL', c), bruto, env.assinar(c.segredo, bruto, { t: velho }));
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'INTEGRATION_WEBHOOK_REPLAY');
});

test('webhook_com_corpo_que_nao_e_json_ou_sem_id_responde_422', async () => {
  const c = await env.criarCanal(tenant);
  const lixo = Buffer.from('{isto nao e json');
  const a = await env.postar(caminho('EMAIL', c), lixo, env.assinar(c.segredo, lixo));
  assert.deepEqual([a.status, a.json.error.code], [422, 'MKT_WEBHOOK_PAYLOAD_INVALID']);
  const semId = Buffer.from(JSON.stringify({ type: 'x' }));
  const b = await env.postar(caminho('EMAIL', c), semId, env.assinar(c.segredo, semId));
  assert.deepEqual([b.status, b.json.error.code], [422, 'MKT_WEBHOOK_PAYLOAD_INVALID']);
});
