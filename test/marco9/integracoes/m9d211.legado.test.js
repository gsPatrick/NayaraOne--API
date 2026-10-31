'use strict';

// Marco 9, M9-D211 — as quatro rotas públicas antigas (Clicksign, banco, seguro e financiamento) seguem com o mesmo caminho e o mesmo contrato,
// agora sobre o framework: corpo bruto e limite WEBHOOK compartilhado. A prova ponta a ponta do financiamento está em m9d240.webhook.
process.env.PORT = process.env.M9D211_LEGADO_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d211Env');
const { scopeKeyOf } = require('../../../src/features/integrations/webhooks/webhooks.rateLimit');
const { tolerantJson } = require('../../../src/features/integrations/webhooks/webhooks.legacy');
const { isFrameworkWebhookPath } = require('../../../src/features/integrations/webhooks/webhooks.paths');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const ROTAS = {
  clicksign: '/v1/legal/webhooks/clicksign',
  banco: '/v1/finance/webhooks/bank-payment',
  seguro: '/v1/procurement/webhooks/insurance',
  financiamento: '/v1/correspondent/webhooks/financing/sandbox',
};
const enviar = (rota, corpo, headers = {}) => env.postar(rota, Buffer.from(corpo), headers);
const dados = (r) => (r.json && r.json.data) || r.json;

test('webhook_rotas_legadas_aliases', async () => {
  // Clicksign: evento sem signatário nem envelope é reconhecido sem efeito.
  const click = await enviar(ROTAS.clicksign, '{"event":{"name":"upload"}}');
  assert.equal(click.status, 200);
  assert.deepEqual([dados(click).acknowledged, dados(click).processed, dados(click).reason], [true, false, 'no_identifier_in_payload']);
  // Clicksign: roteamento desconhecido segue 200 para o fornecedor não reenviar em laço.
  const desconhecido = await enviar(ROTAS.clicksign, JSON.stringify({ event: { name: 'sign', data: { signer: { key: `chave-${env.uniqueSuffix()}` } } } }));
  assert.equal(desconhecido.status, 200);
  assert.equal(dados(desconhecido).reason, 'unknown_routing');
  // Banco e seguro: corpo sem identificação é 400 invalid_payload e submissão desconhecida é 200 unknown_routing, como antes.
  for (const rota of [ROTAS.banco, ROTAS.seguro]) {
    const invalido = await enviar(rota, '{"status":"PAID"}');
    assert.equal(invalido.status, 400, rota);
    assert.equal(dados(invalido).reason, 'invalid_payload');
    const ignorado = await enviar(rota, JSON.stringify({ externalSubmissionId: `sub-${env.uniqueSuffix()}`, status: 'PAID' }));
    assert.equal(ignorado.status, 200, rota);
    assert.equal(dados(ignorado).reason, 'unknown_routing');
  }
  // Financiamento: sem os campos do evento é 200 invalid_payload; evento de caso desconhecido sem assinatura válida é 401 igual à assinatura inválida.
  const semCampos = await enviar(ROTAS.financiamento, '{}');
  assert.equal(semCampos.status, 200);
  assert.equal(dados(semCampos).reason, 'invalid_payload');
  const semAssinatura = await enviar(ROTAS.financiamento, JSON.stringify({ externalCaseId: `caso-${env.uniqueSuffix()}`, externalEventId: `evt-${env.uniqueSuffix()}`, status: 'ANALYSIS' }));
  assert.equal(semAssinatura.status, 401);
  assert.equal(semAssinatura.json.error.code, 'CORRESPONDENT_WEBHOOK_HMAC_INVALID');
});

test('webhook_legado_corpo_bruto_sem_parser_de_json_do_app', async () => {
  // O JSON ilegível não derruba a rota com 400 do parser global: o módulo recebe corpo vazio e responde como a um evento sem identificação.
  const quebrado = await enviar(ROTAS.clicksign, '{"event": isto quebra');
  assert.equal(quebrado.status, 200);
  assert.equal(dados(quebrado).reason, 'no_identifier_in_payload');
  // Qualquer Content-Type chega como bytes, e o corpo é lido do mesmo jeito.
  const texto = await env.postar(ROTAS.clicksign, Buffer.from('{"event":{"name":"upload"}}'), { 'Content-Type': 'text/plain' });
  assert.equal(texto.status, 200);
  assert.equal(tolerantJson(Buffer.from('[1,2]')) instanceof Array, false, 'lista na raiz vira corpo vazio');
  assert.deepEqual(tolerantJson(Buffer.alloc(0)), {});
  assert.equal(isFrameworkWebhookPath('/api/v1/legal/webhooks/clicksign'), true);
  assert.equal(isFrameworkWebhookPath('/api/v1/correspondent/webhooks/financing/sandbox'), true);
  assert.equal(isFrameworkWebhookPath('/api/v1/webhooks/p/c'), true);
  assert.equal(isFrameworkWebhookPath('/api/webhooks/p/c'), true);
  assert.equal(isFrameworkWebhookPath('/api/v1/people'), false);
  assert.equal(isFrameworkWebhookPath('/api/v1/x/webhooks/p/c'), false);
  const grande = await env.postar(ROTAS.clicksign, Buffer.alloc(1048576 + 4096, 'a'), {});
  assert.equal(grande.status, 413);
  assert.equal(grande.json.error.code, 'INTEGRATION_WEBHOOK_TOO_LARGE');
});

test('webhook_legado_usa_o_limite_compartilhado_webhook', async () => {
  const HITS = path.join(__dirname, '../_helpers/m9d843Hits.js');
  const filho = (chave, n) => new Promise((resolve, reject) => {
    execFile(process.execPath, [HITS, chave, String(n)], { env: process.env }, (err, out) => (err ? reject(err) : resolve(JSON.parse(out.trim()))));
  });
  process.env.API_RATE_LIMIT_ENABLED = 'true';
  try {
    // o fornecedor do alias do financiamento é o da URL: um nome só deste teste não atrapalha os demais
    const provider = `qa-leg-${env.uniqueSuffix()}`.toLowerCase().slice(0, 40);
    let r;
    for (let i = 0; i < 3 && !(r && r.status === 429); i += 1) { // a janela de 60 s pode virar no meio da semeadura: semeia de novo
      await Promise.all(['127.0.0.1', '::ffff:127.0.0.1', '::1'].map((ip) => filho(scopeKeyOf(ip, provider), 130)));
      r = await enviar(`/v1/correspondent/webhooks/financing/${provider}`, '{}');
    }
    assert.equal(r.status, 429, 'o alias antigo passa pelo mesmo contador do banco, não pelo da memória');
    assert.equal(r.json.error.code, 'INTEGRATION_RATE_LIMITED');
    const outro = await enviar(`/v1/correspondent/webhooks/financing/sandbox`, '{}');
    assert.equal(outro.status, 200);
  } finally { delete process.env.API_RATE_LIMIT_ENABLED; }
});

test('webhook_financiamento_tem_canal_na_connection_e_rota_unica', async () => {
  // O canal do webhook do Correspondente passa a ser o da connection: o fornecedor pode migrar da URL antiga para a única, com a mesma assinatura (x-webhook-signature).
  const c = await env.criarCanal(tenant, { provider: 'financing-sandbox' });
  assert.match(c.canal, /^[A-Za-z0-9_-]{24,48}$/);
  const id = `evt-fin-${env.uniqueSuffix()}`;
  const corpo = Buffer.from(JSON.stringify({ externalCaseId: 'caso-qualquer', externalEventId: id, status: 'ANALYSIS' }));
  const assinatura = { 'x-webhook-signature': `sha256=${crypto.createHmac('sha256', c.segredo).update(corpo).digest('hex')}` };
  const ok = await env.postar(`/v1/webhooks/financing-sandbox/${c.canal}`, corpo, assinatura);
  assert.deepEqual([ok.status, ok.json], [200, { status: 'accepted', eventId: id }]);
  assert.equal((await env.inbox(tenant, 'financing-sandbox', id)).length, 1);
  const falsa = await env.postar(`/v1/webhooks/financing-sandbox/${c.canal}`, corpo, { 'x-webhook-signature': `sha256=${'0'.repeat(64)}` });
  assert.equal(falsa.status, 401);
});
