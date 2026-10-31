'use strict';

// Marco 9, M9-D234 — anexos do e-mail: arquivo autorizado ao usuário que envia, classificado dentro do teto, limpo no antivírus, tipo da allowlist e tamanho dentro do limite.
// Os limites vêm dos parâmetros da empresa (integration.email.*). Banco descartável.
process.env.PORT = process.env.M9D234_ANEXOS_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d234Env');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await env.conectar(tenant);
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const comAnexo = (arquivos, extra = {}) => env.enviarEmail(tenant, { attachmentFileIds: [].concat(arquivos).map((f) => f.id), ...extra });
const recusa = (promessa, status, code) => assert.rejects(promessa, (e) => { assert.equal(e.statusCode, status); assert.equal(e.code, code); return true; });
const restaurar = async () => {
  await env.config(tenant, 'integration.email.max_attachment_classification', 'CONFIDENTIAL');
  await env.config(tenant, 'integration.email.max_attachment_bytes', 10485760);
  await env.config(tenant, 'integration.email.attachment_allowed_types', 'pdf,png,jpg,docx,xlsx');
};

test('email_anexo_exige_clean_e_classificacao', async () => {
  await restaurar();
  const limpo = await env.criarArquivo(tenant, { classificacao: 'CONFIDENTIAL' });
  const r = await comAnexo(limpo);
  assert.equal(r.message.attachments.length, 1, 'anexo limpo e classificado dentro do teto é aceito');
  assert.equal(r.message.attachments[0].fileId, limpo.id);
  const [envio] = await env.sql(tenant, 'SELECT payload_snapshot FROM integration.dispatches WHERE id = :id', { id: r.dispatchId });
  assert.deepEqual(Object.keys(envio.payload_snapshot.attachments[0]).sort(), ['fileId', 'fileName', 'mimeType', 'sha256', 'sizeBytes'], 'só a referência do arquivo vai ao provedor, nunca o conteúdo');
  const sensivel = await env.criarArquivo(tenant, { classificacao: 'RESTRICTED' });
  await recusa(comAnexo(sensivel), 403, 'INTEGRATION_EMAIL_ATTACHMENT_CLASSIFICATION_BLOCKED');
  await assert.rejects(comAnexo(sensivel), (e) => { assert.equal(e.message, 'Este documento não pode ser enviado como anexo; use o link seguro.'); assert.equal(e.details.reason, 'ABOVE_LIMIT'); return true; });
  // M9-D920: a classe é obrigatória; o arquivo sem classe informada nasce HIGH (CONFIDENTIAL na visão antiga) e segue a regra do teto como qualquer outro.
  const semClasse = await env.criarArquivo(tenant, { classificacao: null });
  const padrao = await comAnexo(semClasse);
  assert.equal(padrao.message.attachments[0].fileId, semClasse.id, 'a classe padrão (HIGH) cabe no teto configurado (CONFIDENTIAL)');
  assert.equal(padrao.message.attachments[0].classification, 'CONFIDENTIAL');
  for (const scan of [null, 'PENDING', 'INFECTED']) {
     
    await recusa(comAnexo(await env.criarArquivo(tenant, { classificacao: 'INTERNAL', scan })), 422, 'INTEGRATION_EMAIL_ATTACHMENT_NOT_CLEAN');
  }
  // O usuário que envia precisa ter acesso ao arquivo: o de outra pessoa, sem vínculo com o módulo dele, é recusado.
  const alheio = await env.criarArquivo(tenant, { classificacao: 'PUBLIC' });
  await recusa(env.enviarEmail(tenant, { attachmentFileIds: [alheio.id], auth: env.authDe(tenant, { userId: '00000000-0000-4000-8000-0000000000aa' }) }), 403, 'INTEGRATION_EMAIL_ATTACHMENT_NOT_AUTHORIZED');
  await recusa(env.enviarEmail(tenant, { attachmentFileIds: ['11111111-1111-4111-8111-111111111111'] }), 404, 'INTEGRATION_EMAIL_ATTACHMENT_NOT_FOUND');
  // Parâmetro: a empresa pode baixar o teto para INTERNAL, e o arquivo CONFIDENTIAL deixa de passar.
  await env.config(tenant, 'integration.email.max_attachment_classification', 'INTERNAL');
  await recusa(comAnexo(limpo), 403, 'INTEGRATION_EMAIL_ATTACHMENT_CLASSIFICATION_BLOCKED');
  await restaurar();
});

test('email_anexo_tamanho_e_tipo', async () => {
  await restaurar();
  const MiB = 1024 * 1024;
  const a = await env.criarArquivo(tenant, { bytes: 6 * MiB });
  const b = await env.criarArquivo(tenant, { bytes: 5 * MiB });
  await recusa(comAnexo([a, b]), 413, 'INTEGRATION_EMAIL_ATTACHMENT_TOO_LARGE');
  await assert.rejects(comAnexo([a, b]), (e) => { assert.equal(e.message, 'Os anexos excedem o tamanho máximo permitido.'); assert.equal(e.details.totalBytes, 11 * MiB); assert.equal(e.details.maxBytes, 10 * MiB); return true; });
  assert.equal((await comAnexo([a])).message.attachmentBytes, String(6 * MiB), 'um só anexo dentro do limite passa');
  await env.config(tenant, 'integration.email.max_attachment_bytes', 12 * MiB);
  assert.equal((await comAnexo([a, b])).message.attachments.length, 2, 'o limite é o parâmetro da empresa');
  await env.config(tenant, 'integration.email.max_attachment_bytes', 5 * MiB);
  await recusa(comAnexo(a), 413, 'INTEGRATION_EMAIL_ATTACHMENT_TOO_LARGE');
  await restaurar();
  for (const [nome, mime] of [['planilha.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['foto.jpeg', 'image/jpeg'], ['carta.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['imagem.png', 'image/png']]) {
     
    assert.equal((await comAnexo(await env.criarArquivo(tenant, { nome, mime }))).message.attachments.length, 1, `${nome} está na allowlist`);
  }
  await recusa(comAnexo(await env.criarArquivo(tenant, { nome: 'programa.exe', mime: 'application/x-msdownload' })), 422, 'INTEGRATION_EMAIL_ATTACHMENT_TYPE_NOT_ALLOWED');
  await recusa(comAnexo(await env.criarArquivo(tenant, { nome: 'disfarce.pdf', mime: 'application/x-msdownload' })), 422, 'INTEGRATION_EMAIL_ATTACHMENT_TYPE_NOT_ALLOWED');
  await recusa(comAnexo(await env.criarArquivo(tenant, { nome: 'sem-extensao', mime: 'application/pdf' })), 422, 'INTEGRATION_EMAIL_ATTACHMENT_TYPE_NOT_ALLOWED');
  await env.config(tenant, 'integration.email.attachment_allowed_types', 'pdf,txt');
  assert.equal((await comAnexo(await env.criarArquivo(tenant, { nome: 'nota.txt', mime: 'text/plain' }))).message.attachments.length, 1, 'a allowlist é o parâmetro da empresa');
  await recusa(comAnexo(await env.criarArquivo(tenant, { nome: 'planilha.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })), 422, 'INTEGRATION_EMAIL_ATTACHMENT_TYPE_NOT_ALLOWED');
  await restaurar();
});

test('email_destinatarios_e_conteudo_validados', async () => {
  await recusa(env.enviarEmail(tenant, { to: [] }), 422, 'INTEGRATION_EMAIL_RECIPIENT_REQUIRED');
  await recusa(env.enviarEmail(tenant, { to: ['isto-nao-e-um-email'] }), 422, 'INTEGRATION_EMAIL_RECIPIENT_INVALID');
  await recusa(env.enviarEmail(tenant, { subject: '  ' }), 422, 'INTEGRATION_EMAIL_CONTENT_REQUIRED');
  await recusa(env.enviarEmail(tenant, { bodyText: '' }), 422, 'INTEGRATION_EMAIL_CONTENT_REQUIRED');
  await env.config(tenant, 'integration.email.max_recipients', 2);
  await recusa(env.enviarEmail(tenant, { to: ['a@qa-m9.test', 'b@qa-m9.test'], cc: ['c@qa-m9.test'] }), 422, 'INTEGRATION_EMAIL_TOO_MANY_RECIPIENTS');
  await env.config(tenant, 'integration.email.max_recipients', 50);
  const r = await env.enviarEmail(tenant, { to: ['A@qa-m9.test', 'a@qa-m9.test'], cc: ['a@qa-m9.test', 'b@qa-m9.test'], bcc: ['b@qa-m9.test', 'c@qa-m9.test'], replyTo: 'resposta@qa-m9.test' });
  assert.deepEqual([r.message.toAddresses, r.message.ccAddresses, r.message.bccAddresses], [['A@qa-m9.test'], ['b@qa-m9.test'], ['c@qa-m9.test']], 'endereço repetido fica só no primeiro campo');
  assert.equal(r.message.replyTo, 'resposta@qa-m9.test');
});
