'use strict';

// Marco 9, M9-D213 — limites da borda: corpo cortado no limite sem ler o resto (413), tipo de conteúdo (415), estrutura do JSON (fila morta com 200).
process.env.PORT = process.env.M9D213_LIMITES_PORT || '21216';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const env = require('../_helpers/m9d212Env');
const settingsService = require('../../../src/features/settings/settings.service');
const { MessagingSandboxAdapter } = require('../../../src/features/integrations/providers/messaging/sandbox/messaging-sandbox.adapter');
const { rawBodyMiddleware } = require('../../../src/features/integrations/webhooks/webhooks.rawBody');

let tenant;
let desligarCofre;
const MIB = 1048576;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const param = (chave, valor) => env.comTenant(tenant, (t) => settingsService.upsertSetting(chave, valor, tenant, tenant.userId, t));
const limpar = (chave) => env.sql(tenant, 'DELETE FROM core.tenant_settings WHERE company_id = :c AND key = :k', { c: tenant.companyId, k: chave });
const aninhado = (n) => JSON.parse(`${'{"a":'.repeat(n)}1${'}'.repeat(n)}`);

/** POST de corpo grande: o servidor pode responder 413 ou derrubar a conexão (livro: "a conexão é cortada"); os dois valem como recusa. Devolve { status } ou { reset: true }. */
async function postarGrande(caminho, corpo, headers) {
  try {
    const r = await env.postar(caminho, corpo, headers);
    return { status: r.status, json: r.json };
  } catch (err) {
    return { reset: true, err: String(err.cause && err.cause.code) };
  }
}
const recusado = (r) => r.status === 413 || r.reset === true;

/** Corpo SEM Content-Length (chunked) de `total` bytes contra um servidor com a leitura bruta real; devolve { status, lidoPeloServidor }. */
async function enviarEmPedacos(limite, total) {
  const lido = {};
  const app = express();
  app.post('/x', (req, _res, next) => { req.webhookBodyLimit = limite; next(); }, rawBodyMiddleware, (req, res) => res.json({ ok: true, tamanho: req.body.length }));
  app.use((err, req, res, _next) => { lido.bytes = req.socket.bytesRead; res.status(err.statusCode || 500).json({ code: err.code }); });
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: servidor.address().port, path: '/x', method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } });
      req.on('response', (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, lido })); });
      req.on('error', (e) => (['ECONNRESET', 'EPIPE'].includes(e.code) ? resolve({ status: 413, lido }) : reject(e)));
      const pedaco = Buffer.alloc(65536, 'a');
      let enviado = 0;
      const escrever = () => {
        while (enviado < total) {
          enviado += pedaco.length;
          if (!req.write(pedaco)) { req.once('drain', escrever); return; }
        }
        req.end();
      };
      escrever();
    });
  } finally {
    servidor.closeAllConnections();
    servidor.close();
  }
}

test('payload_gigante_413_sem_estourar_memoria', async () => {
  const c = await env.criarCanal(tenant);
  const grande = Buffer.alloc(3 * MIB, 'a');
  const pouco = Buffer.alloc(MIB + 4096, 'a');
  const r = await env.postar(`/v1/webhooks/${c.provider}/${c.canal}`, pouco, env.assinar(c.segredo, pouco));
  assert.equal(r.status, 413, 'Content-Length acima do limite de 1 MiB: recusado antes de ler');
  assert.equal(r.json.error.code, 'INTEGRATION_WEBHOOK_TOO_LARGE');
  assert.equal(r.json.error.message, 'O corpo do evento excede o tamanho máximo permitido.');
  const tres = await postarGrande(`/v1/webhooks/${c.provider}/${c.canal}`, grande, env.assinar(c.segredo, grande));
  assert.equal(recusado(tres), true, '3 MiB: 413 ou conexão cortada');
  assert.equal((await env.erros(tenant, c.provider, 'INTEGRATION_WEBHOOK_TOO_LARGE')).length >= 1, true, 'a recusa vira erro de integração sem o conteúdo');
  const semLength = await enviarEmPedacos(MIB, 3 * MIB);
  assert.equal(semLength.status, 413, 'sem Content-Length a leitura é cortada ao passar do limite');
  assert.equal(semLength.lido.bytes < MIB + 512 * 1024, true, `o servidor leu ${semLength.lido.bytes} bytes de 3145728: a leitura parou perto do limite`);
  const dentro = await enviarEmPedacos(MIB, 512 * 1024);
  assert.equal(dentro.status, 200, 'corpo dentro do limite passa');
});

test('payload_gigante_politica_do_fornecedor_ate_10_mib', async () => {
  const c = await env.criarCanal(tenant);
  const caminho = `/v1/webhooks/${c.provider}/${c.canal}`;
  const corpo = Buffer.from(JSON.stringify({ ...env.evento(), lista: Array.from({ length: 30000 }, () => 'x'.repeat(100)) }));
  assert.equal(recusado(await postarGrande(caminho, corpo, env.assinar(c.segredo, corpo))), true, 'sem a política, 3 MiB passa do limite de 1 MiB');
  await env.sql(tenant, "UPDATE integration.connections SET policy_json = '{\"webhook\":{\"max_body_bytes\":5242880}}'::jsonb WHERE id = :id", { id: c.conn.id });
  assert.equal((await env.postar(caminho, corpo, env.assinar(c.segredo, corpo))).status, 200, 'a política do fornecedor eleva o limite');
  const enorme = Buffer.alloc(11 * MIB, 'a');
  await env.sql(tenant, "UPDATE integration.connections SET policy_json = '{\"webhook\":{\"max_body_bytes\":99999999}}'::jsonb WHERE id = :id", { id: c.conn.id });
  assert.equal(recusado(await postarGrande(caminho, enorme, env.assinar(c.segredo, enorme))), true, 'teto absoluto de 10 MiB');
});

test('payload_texto_enorme_na_fila_morta_nao_trava_o_servidor', async () => {
  const c = await env.criarCanal(tenant);
  await env.sql(tenant, "UPDATE integration.connections SET policy_json = '{\"webhook\":{\"max_body_bytes\":5242880}}'::jsonb WHERE id = :id", { id: c.conn.id });
  const t0 = Date.now();
  const r = await env.enviar(c, env.evento({ nota: 'a'.repeat(3 * MIB) }));
  assert.deepEqual([r.status, r.json], [200, { status: 'rejected_to_dlq' }], 'texto acima de integration.webhook.max_string_length vai à fila morta');
  assert.equal(Date.now() - t0 < 3000, true, 'o erro sanitizado não varre megabytes de texto');
});

test('payload_content_type_nao_suportado', async () => {
  const c = await env.criarCanal(tenant);
  const ev = env.evento();
  const xml = await env.enviar(c, ev, { headers: { 'Content-Type': 'application/xml' } });
  assert.equal(xml.status, 415);
  assert.equal(xml.json.error.code, 'INTEGRATION_WEBHOOK_UNSUPPORTED_MEDIA');
  assert.equal(xml.json.error.message, 'Tipo de conteúdo não suportado.');
  assert.equal((await env.inbox(tenant, c.provider, ev.id)).length, 0);
  const form = await env.enviar(c, `id=${ev.id}&type=message.status`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(form.status, 415, 'formulário só vale para o fornecedor que o declara');
  const texto = await env.enviar(c, ev, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  assert.equal(texto.status, 200, 'text/plain é aceito');
  const original = MessagingSandboxAdapter.prototype.webhookContentTypes;
  MessagingSandboxAdapter.prototype.webhookContentTypes = () => ['application/x-www-form-urlencoded'];
  try {
    const id = `evt-form-${env.uniqueSuffix()}`;
    const ok = await env.enviar(c, `id=${id}&type=message.status&resourceId=r1&status=SENT`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.deepEqual([ok.status, ok.json], [200, { status: 'accepted', eventId: id }]);
  } finally {
    MessagingSandboxAdapter.prototype.webhookContentTypes = original;
  }
});

test('payload_json_profundo_recusado', async () => {
  const c = await env.criarCanal(tenant);
  const profundo = env.evento({ n: aninhado(25) });
  const r = await env.enviar(c, profundo);
  assert.deepEqual([r.status, r.json], [200, { status: 'rejected_to_dlq' }], 'profundidade 25 > 20: fila morta com 200');
  const [morta] = await env.sql(tenant, "SELECT * FROM integration.webhook_inbox WHERE connection_id = :id AND dead_letter_reason = 'STRUCTURE_LIMIT'", { id: c.conn.id });
  assert.equal(morta.status, 'DEAD_LETTER');
  const nivel20 = await env.enviar(c, env.evento({ n: aninhado(17) }));
  assert.equal(nivel20.json.status, 'accepted', 'dentro do limite passa');
  await param('integration.webhook.max_keys', 30);
  await param('integration.webhook.max_string_length', 100);
  try {
    const muitas = await env.enviar(c, env.evento(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]))));
    assert.equal(muitas.json.status, 'rejected_to_dlq', 'mais chaves que integration.webhook.max_keys');
    const longa = await env.enviar(c, env.evento({ nota: 'x'.repeat(150) }));
    assert.equal(longa.json.status, 'rejected_to_dlq', 'texto maior que integration.webhook.max_string_length');
  } finally {
    await limpar('integration.webhook.max_keys');
    await limpar('integration.webhook.max_string_length');
  }
  assert.equal((await env.sql(tenant, "SELECT 1 FROM integration.webhook_inbox WHERE connection_id = :id AND dead_letter_reason = 'STRUCTURE_LIMIT'", { id: c.conn.id })).length, 3);
});

test('payload_estrutura_excessiva_vai_para_dlq_com_200', async () => {
  const c = await env.criarCanal(tenant);
  const ev = env.evento({ n: aninhado(30), cpf: '123.456.789-09' });
  const r = await env.enviar(c, ev);
  assert.equal(r.status, 200, 'nunca 400 nem 500');
  assert.equal(r.json.status, 'rejected_to_dlq');
  const [morta] = await env.sql(tenant, "SELECT * FROM integration.webhook_inbox WHERE connection_id = :id AND dead_letter_reason = 'STRUCTURE_LIMIT'", { id: c.conn.id });
  assert.equal(morta.payload_raw, null);
  assert.equal(morta.payload, null);
  const [erro] = await env.erros(tenant, c.provider, 'INTEGRATION_WEBHOOK_PAYLOAD_INVALID');
  assert.match(erro.message, /^Evento recebido e enviado para a fila de erros/);
  assert.ok(!JSON.stringify(erro).includes('123.456.789-09'), 'sem dado pessoal');
  await env.rodar(tenant);
  assert.equal((await env.sql(tenant, 'SELECT attempts FROM integration.webhook_inbox WHERE id = :id', { id: morta.id }))[0].attempts, 0, 'a fila morta não volta ao worker');
});
