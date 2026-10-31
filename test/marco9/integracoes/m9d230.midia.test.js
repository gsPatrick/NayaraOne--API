'use strict';

// Marco 9, M9-D230 — mídia do WhatsApp: a que sai só sai de arquivo limpo, classificado, dentro do tamanho e do tipo, com link de curta duração; a que chega é buscada só pelo guarda SSRF,
// entra em quarentena e só aparece depois da verificação. Banco descartável (os testes COMMITAM); antivírus real (clamd).
process.env.PORT = process.env.M9D230_MIDIA_PORT || require('../_helpers/portaLivre').portaLivre();

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d230Env');
const files = require('../_helpers/m9d247Files');
const { montarAmbiente, HOST } = require('../_helpers/ssrfEnv');
const inboundMedia = require('../../../src/features/crm/messaging/whatsapp.inboundMedia');
const quarantine = require('../../../src/features/files/quarantine');
const messagesService = require('../../../src/features/crm/messages.service');

let tenant;
const abertos = [];
const CHAVES = ['integration.whatsapp.max_media_bytes', 'integration.whatsapp.media_link_ttl_min', 'integration.whatsapp.media_max_classification', 'integration.whatsapp.media_allowed_types'];
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
afterEach(async () => { inboundMedia._usarBuscador(null); while (abertos.length) await abertos.pop().fechar(); await env.restaurar(tenant, CHAVES); });
after(async () => { await env.pausar(tenant); await env.sequelize.close(); process.exit(0); });

const midia = (p, f, extra = {}) => ({ kind: 'media', personId: p.id, to: p.phone, mediaRef: f.id, caption: 'Planta', auth: env.authDe(tenant), ...extra });
const recusa = (status, code) => (e) => e.statusCode === status && e.code === code;
const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId });

test('whatsapp_midia_so_se_arquivo_clean', async () => {
  const canal = await env.conectarComModelos(tenant, []);
  const p = await env.pessoa(tenant);
  const antes = await env.contagem(tenant, p.id);
  // Arquivo ainda não verificado, infectado ou sem registro: recusado, nada enfileirado.
  for (const scan of [null, 'PENDING', 'INFECTED']) {
    const f = await env.arquivo(tenant, { scan });
    await assert.rejects(env.enviarMensagem(tenant, midia(p, f)), (e) => recusa(422, 'INTEGRATION_MESSAGING_MEDIA_NOT_CLEAN')(e) && e.message === 'O arquivo ainda não foi liberado pela verificação de segurança.');
  }
  await assert.rejects(env.enviarMensagem(tenant, { ...midia(p, { id: '3f2b1c9e-0000-4000-8000-000000000000' }) }), recusa(404, 'INTEGRATION_MESSAGING_MEDIA_NOT_FOUND'));
  // Classificação acima do que a empresa autoriza, tipo fora da lista e tamanho acima do limite do canal.
  await assert.rejects(env.enviarMensagem(tenant, midia(p, await env.arquivo(tenant, { classificacao: 'CONFIDENTIAL' }))), recusa(403, 'INTEGRATION_MESSAGING_MEDIA_CLASSIFICATION_BLOCKED'));
  await assert.rejects(env.enviarMensagem(tenant, midia(p, await env.arquivo(tenant, { classificacao: null }))), recusa(403, 'INTEGRATION_MESSAGING_MEDIA_CLASSIFICATION_BLOCKED'));
  await assert.rejects(env.enviarMensagem(tenant, midia(p, await env.arquivo(tenant, { nome: 'a.exe', mime: 'application/x-msdownload' }))), recusa(422, 'INTEGRATION_MESSAGING_MEDIA_TYPE_NOT_ALLOWED'));
  await assert.rejects(env.enviarMensagem(tenant, midia(p, await env.arquivo(tenant, { bytes: 16 * 1024 * 1024 + 1 }))), (e) => recusa(413, 'INTEGRATION_MESSAGING_MEDIA_TOO_LARGE')(e) && e.message === 'O arquivo excede o limite do canal.');
  assert.deepEqual(await env.contagem(tenant, p.id), antes, 'nenhuma recusa deixou mensagem ou envio');
  // O limite é parâmetro: baixando para 1 KiB, o arquivo de 2 KiB passa a ser grande.
  const limpo = await env.arquivo(tenant);
  await env.parametro(tenant, 'integration.whatsapp.max_media_bytes', 1024);
  await assert.rejects(env.enviarMensagem(tenant, midia(p, limpo)), recusa(413, 'INTEGRATION_MESSAGING_MEDIA_TOO_LARGE'));
  await env.restaurar(tenant, CHAVES);
  // Limpo, PUBLIC e de tipo aceito: enfileira, e no envio o fornecedor recebe um link assinado que expira em 15 minutos (parâmetro).
  const r = await env.enviarMensagem(tenant, midia(p, limpo));
  assert.equal(r.operation, 'sendMedia');
  const inicio = Date.now();
  await env.rodarEnvios(tenant);
  const m = await env.mensagem(tenant, r.message.id);
  assert.equal(m.delivery_status, 'SENT');
  const noFornecedor = env.store.findById(canal.conn.id, m.external_message_id);
  assert.ok(noFornecedor.mediaLink && /^https?:\/\//.test(noFornecedor.mediaLink.url), 'o fornecedor recebe um link, não o arquivo');
  const minutos = (new Date(noFornecedor.mediaLink.expiresAt).getTime() - inicio) / 60000;
  assert.ok(minutos > 14 && minutos <= 15.5, `link expira em 15 min (deu ${minutos.toFixed(2)})`);
  // Arquivo que deixa de estar limpo entre o enfileiramento e o envio não sai.
  const f2 = await env.arquivo(tenant);
  const r2 = await env.enviarMensagem(tenant, midia(p, f2));
  await env.sql(tenant, "UPDATE people.files SET scan_status = 'INFECTED' WHERE id = :id", { id: f2.id });
  await env.rodarEnvios(tenant);
  assert.notEqual((await env.mensagem(tenant, r2.message.id)).delivery_status, 'SENT', 'o antivírus é conferido de novo no envio');
  // TTL é parâmetro da empresa.
  await env.parametro(tenant, 'integration.whatsapp.media_link_ttl_min', 5);
  const r3 = await env.enviarMensagem(tenant, midia(p, limpo));
  const t0 = Date.now();
  await env.rodarEnvios(tenant);
  const m3 = await env.mensagem(tenant, r3.message.id);
  const l3 = env.store.findById(canal.conn.id, m3.external_message_id).mediaLink;
  assert.ok((new Date(l3.expiresAt).getTime() - t0) / 60000 <= 5.5);
});

/** Mensagem recebida com mídia por URL: o evento assinado vai pelo webhook e o worker busca a mídia pelo guarda (servidor HTTPS local). */
async function receberMidia(canal, p, conteudo, tipo = 'application/pdf') {
  const a = await montarAmbiente((_req, res) => { res.setHeader('content-type', tipo); res.end(conteudo); });
  abertos.push(a);
  const chamadas = [];
  inboundMedia._usarBuscador((url, opts) => { chamadas.push({ url, flow: opts.flow }); return a.buscar(url, { ...opts, flow: 'message_media', _params: { flowHosts: { message_media: [HOST] } } }); });
  const id = `in-${env.uniqueSuffix()}`;
  const ev = { ...env.inboundA(id, p.phone, 'segue o documento'), mediaRef: `https://${HOST}/doc/${id}.pdf`, mimeType: tipo };
  assert.equal((await env.enviar(canal, ev)).status, 200);
  await env.rodar(tenant);
  const [m] = (await env.mensagensDa(tenant, p.id)).filter((x) => x.external_message_id === id);
  return { m, chamadas };
}
const exibicao = async (m) => JSON.parse(JSON.stringify((await env.comTenant(tenant, (t) => messagesService.listMessages(t, { personId: m.person_id }))).find((x) => x.id === m.id)));

test('whatsapp_midia_entrante_em_quarentena', async () => {
  const canal = await env.conectarComModelos(tenant, []);
  const p = await env.pessoa(tenant);
  const { m, chamadas } = await receberMidia(canal, p, files.pdf('contrato de locação'));
  // Buscada só pelo guarda SSRF, com o fluxo da mídia de mensagem.
  assert.deepEqual(chamadas.map((c) => c.flow), ['message_media']);
  // Antes de qualquer uso a linha está em files.quarantine como QUARANTINED, ligada à mensagem; ninguém usa o arquivo ainda.
  const [q] = await env.sql(tenant, 'SELECT * FROM files.quarantine WHERE id = :id', { id: m.media_quarantine_id });
  assert.equal(q.status, 'QUARANTINED');
  assert.equal(q.connection_id, canal.conn.id);
  await assert.rejects(env.comTenant(tenant, (t) => quarantine.assertReleased(ctx(), q.id, t)), (e) => e.statusCode === 423);
  let v = await exibicao(m);
  assert.equal(v.mediaState, 'PENDING');
  assert.match(v.mediaDisplay, /verifica/i);
  assert.equal(v.mediaFileId ?? null, null, 'sem arquivo liberado, nada a exibir');
  // Verificação limpa: a mídia é liberada e só então vira arquivo utilizável.
  await env.comTenant(tenant, (t) => quarantine.verifyQuarantine(ctx(), q.id, t));
  v = await exibicao(m);
  assert.equal(v.mediaState, 'RELEASED');
  const liberado = await env.comTenant(tenant, (t) => quarantine.assertReleased(ctx(), q.id, t));
  assert.equal(v.mediaFileId, liberado.fileId);
  // Mídia infectada: a interação mostra "mídia bloqueada" e nenhum arquivo.
  const inf = await receberMidia(canal, p, files.pdfInfectado());
  const [qi] = await env.sql(tenant, 'SELECT status FROM files.quarantine WHERE id = :id', { id: inf.m.media_quarantine_id });
  assert.equal(qi.status, 'QUARANTINED');
  await env.comTenant(tenant, (t) => quarantine.verifyQuarantine(ctx(), inf.m.media_quarantine_id, t));
  const bloqueada = await exibicao(inf.m);
  assert.deepEqual([bloqueada.mediaState, bloqueada.mediaDisplay, bloqueada.mediaFileId ?? null], ['BLOCKED', 'Mídia bloqueada.', null]);
  // URL que o guarda recusa (host fora da lista do fluxo): a mensagem é registrada, a mídia aparece bloqueada e nada é baixado.
  inboundMedia._usarBuscador(null);
  const id = `in-${env.uniqueSuffix()}`;
  await env.enviar(canal, { ...env.inboundA(id, p.phone, 'olha isso'), mediaRef: 'https://intruso.example.net/x.pdf', mimeType: 'application/pdf' });
  await env.rodar(tenant);
  const [recusada] = (await env.mensagensDa(tenant, p.id)).filter((x) => x.external_message_id === id);
  assert.equal(recusada.body, 'olha isso');
  assert.equal((await exibicao(recusada)).mediaState, 'BLOCKED');
  // Nenhum outro cliente HTTP no código da mídia recebida: só o guarda.
  const fonte = fs.readFileSync(path.join(__dirname, '../../../src/features/crm/messaging/whatsapp.inboundMedia.js'), 'utf8');
  assert.match(fonte, /fetchExternalUrl/);
  assert.doesNotMatch(fonte, /require\(['"](node:)?https?['"]\)|axios|node-fetch|undici|\bfetch\(/);
});
