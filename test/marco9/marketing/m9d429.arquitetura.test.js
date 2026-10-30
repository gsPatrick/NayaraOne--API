'use strict';

// M9-D429 — WhatsApp e e-mail do Marketing usam o ChannelAdapter da M9-D430 (sendToChannel / resolveChannelAdapter), sem chamada direta a fornecedor e sem
// modo próprio de contingência (a dona é a M9-D430); valores de parâmetro só nos arquivos de settings; interactionsOf conta mensagem automática só com
// DELIVERED/READ. Teste estático e de função pura, sem banco.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { interactionsOf } = require('../../../src/features/ai/agents/nay_comercial/comercial.data');

const DIR = path.join(__dirname, '..', '..', '..', 'src', 'features', 'marketing', 'publications', 'messaging');
const files = (dir = DIR) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : (e.name.endsWith('.js') ? [path.join(dir, e.name)] : [])));
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('mensagens_usam_o_channel_adapter_sem_chamada_direta_a_fornecedor_e_sem_modo_de_contingencia_proprio', () => {
  const all = files().map((f) => [path.relative(DIR, f), strip(fs.readFileSync(f, 'utf8'))]);
  assert.ok(all.length >= 15);
  for (const [name, code] of all) {
    assert.ok(!/fetch\(|axios|require\('(node:)?https?'\)|IntegrationHttpClient|providers\//.test(code), `${name} chama fornecedor direto`);
    assert.ok(!/KEEP_INTERNAL|QUEUE_AND_ALTERNATE|PENDING_SYNC/.test(code), `${name} define modo de contingência`);
  }
  const send = all.find(([name]) => name.endsWith('message.send.js'))[1];
  assert.match(send, /sendToChannel\(/);
  assert.match(send, /resolveChannelAdapter\(/);
  assert.match(send, /canSend\(/);
  // o disparo da campanha usa a porta padrão da M9-D418 montada com buildCampaignSendPort({ send })
  const port = all.find(([name]) => name.endsWith('campaign.port.js'))[1];
  assert.match(port, /buildCampaignSendPort\(\{ send: sendStep \}\)/);
});

test('valores_de_parametro_do_preview_moram_so_no_arquivo_de_settings', () => {
  for (const [name, code] of files().filter((f) => !f.endsWith('preview.settings.js')).map((f) => [path.relative(DIR, f), strip(fs.readFileSync(f, 'utf8'))])) {
    assert.ok(!/Você tem uma atualização|parcela, dívida|Serasa|\(\?:loc\|adm/.test(code), `${name} repete valor padrão de parâmetro`);
  }
});

test('interactions_of_so_conta_mensagem_automatica_entregue_ou_lida_e_mantem_a_regra_da_m9d229', () => {
  const at = new Date().toISOString();
  const msg = (data) => ({ type: 'MESSAGE', occurredAt: at, data: { direction: 'OUTBOUND', channel: 'EMAIL', ...data } });
  const now = Date.now();
  assert.equal(interactionsOf([msg({ status: 'SENT', automatic: true })], now).length, 0, 'automática aceita pelo provedor ainda não é contato');
  assert.equal(interactionsOf([msg({ status: 'UNKNOWN', automatic: true })], now).length, 0);
  assert.equal(interactionsOf([msg({ status: 'FAILED', automatic: true })], now).length, 0);
  assert.equal(interactionsOf([msg({ status: 'DELIVERED', automatic: true }), msg({ status: 'READ', automatic: true })], now).length, 2);
  assert.equal(interactionsOf([msg({ status: 'SENT', automatic: false })], now).length, 1, 'mensagem de pessoa aceita continua contando (M9-D229)');
  assert.equal(interactionsOf([msg({ status: 'QUEUED', automatic: false })], now).length, 0);
  assert.equal(interactionsOf([{ type: 'MESSAGE', occurredAt: at, data: { direction: 'INBOUND', status: 'RECEIVED' } }], now).length, 1);
});
