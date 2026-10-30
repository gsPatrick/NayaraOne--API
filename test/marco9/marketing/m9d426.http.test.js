'use strict';

// M9-D426 — POST /marketing/media/:id/authorize (rota I9) e POST /marketing/content com montagem, por HTTP real: permissão, validação, isolamento entre empresas.
// Só em banco descartável. Nenhum endpoint de MFA é chamado.
process.env.PORT = process.env.M9D426_HTTP_TEST_PORT || '21726';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/mktHttp');

const PREFIX = 'QA-M9 D426';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('QA-M9 D426 imagem de teste')]).toString('base64');
let sequelize;

before(async () => {
  if (!http.DISPOSABLE) return;
  ({ sequelize } = require('../../../src/models'));
  await http.start([
    { label: 'D426 editor', tenant: 'A', profile: 'gestor', permissions: ['marketing:content:read', 'marketing:content:write', 'marketing:content:approve'] },
    { label: 'D426 leitor', tenant: 'A', profile: 'leitura', permissions: ['marketing:content:read'] },
    { label: 'D426 outra empresa', tenant: 'B', profile: 'gestor', permissions: ['marketing:content:read', 'marketing:content:write', 'marketing:content:approve'] },
  ]);
});
after(async () => {
  if (http.DISPOSABLE) await http.adminQuery('DELETE FROM marketing.media_derivatives').catch(() => {});
  await http.stop(PREFIX);
  if (http.DISPOSABLE) {
    await http.adminQuery('DELETE FROM marketing.media_authorizations').catch(() => {});
    await http.adminQuery("DELETE FROM people.files WHERE file_name LIKE 'qa-m9-d426%'").catch(() => {});
  }
  if (sequelize) await sequelize.close().catch(() => {});
  if (http.state.loaded) setTimeout(() => process.exit(0), 300);
});

async function upload(who, name) {
  const res = await http.call(who, 'POST', '/files', { fileName: name, mimeType: 'image/png', contentBase64: PNG, category: 'marketing' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

test('rota_de_autorizacao_de_midia_e_montagem_pela_criacao', { skip: !http.DISPOSABLE && http.SKIP_DISPOSABLE }, async () => {
  if (http.state.skip) return;
  const file = await upload('D426 editor', 'qa-m9-d426-sala.png');
  const path = `/marketing/media/${file.id}/authorize`;
  assert.equal((await http.call('D426 leitor', 'POST', path, { origin: 'EQUIPE' })).status, 403, 'sem marketing:content:approve');
  assert.equal((await http.call(null, 'POST', path, { origin: 'EQUIPE' })).status, 401);
  assert.equal((await http.call('D426 editor', 'POST', path, { origin: 'EQUIPE', extra: 1 })).body.error.code, 'MKT_VALIDATION', 'campo desconhecido');
  assert.equal((await http.call('D426 editor', 'POST', path, {})).status, 400);
  assert.equal((await http.call('D426 editor', 'POST', path, { origin: 'INVENTADA' })).status, 422);
  assert.equal((await http.call('D426 editor', 'POST', '/marketing/media/nao-e-uuid/authorize', { origin: 'EQUIPE' })).status, 400);
  const missing = await http.call('D426 editor', 'POST', `/marketing/media/${require('node:crypto').randomUUID()}/authorize`, { origin: 'EQUIPE' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'MKT_NOT_FOUND');
  const foreign = await http.call('D426 outra empresa', 'POST', path, { origin: 'EQUIPE' });
  assert.equal(foreign.status, 404, 'o arquivo de outra empresa não existe para esta');
  assert.equal(foreign.body.error.code, 'MKT_NOT_FOUND');

  // antes de autorizar: o conteúdo recusa a mídia
  const body = { type: 'VIDEO_REEL', title: `${PREFIX} reel`, texto: 'Tour pelo apartamento.', montagem: { midias: [file.id], operacoes: [{ op: 'CAPTION', text: 'Sala' }] } };
  const denied = await http.call('D426 editor', 'POST', '/marketing/content', body);
  assert.equal(denied.status, 422);
  assert.equal(denied.body.error.code, 'MKT_MEDIA_NOT_AUTHORIZED');

  const ok = await http.call('D426 editor', 'POST', path, { origin: 'equipe' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.fileId, file.id);
  assert.equal(ok.body.data.sha256, file.checksumSha256);
  assert.equal(ok.body.data.origin, 'EQUIPE');
  assert.ok(ok.body.data.authorizedAt);
  assert.ok(!JSON.stringify(ok.body).includes('storage'), 'a resposta não traz o caminho do arquivo');

  const created = await http.call('D426 editor', 'POST', '/marketing/content', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.status, 'PENDING_APPROVAL');
  const sky = await http.call('D426 editor', 'POST', '/marketing/content', { ...body, title: `${PREFIX} céu`, montagem: { midias: [file.id], operacoes: [{ op: 'SKY_REPLACE' }] } });
  assert.equal(sky.status, 422);
  assert.equal(sky.body.error.code, 'MKT_MEDIA_MATERIAL_ALTERATION');
  const unknown = await http.call('D426 editor', 'POST', '/marketing/content', { ...body, title: `${PREFIX} campo`, montagem: { midias: [file.id], truque: true } });
  assert.equal(unknown.status, 400);
});
