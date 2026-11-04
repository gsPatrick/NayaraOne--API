'use strict';

// M9-D920 §3.3 e §3.4 — download de anexos pela API real (banco descartável): guard por classe, endereço assinado de uso único com prazo, marca d'água por usuário com o hash do
// original intacto, falha segura, tipo sem suporte, detector de anomalia e isolamento entre empresas.
// porta livre escolhida pelo SO (listen(0)): nem fixa (colide com outra API de pé) nem sorteada em 30000-49999 (cai na faixa efêmera do Linux, usada pelas conexões do próprio teste ao banco)
process.env.PORT = process.env.M9D920_DOWNLOAD_TEST_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d920Env');
const { pdfText } = require('../_helpers/exportsEnv');
const { jpegBuffer } = require('../_helpers/m9d920Pdf');

let http; let A; let B; let restore;
const VIEW_RESTRICTED = 'governance:dlp:view-restricted';
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);

before(async () => {
  if (!env.DISPOSABLE) return;
  // o token leva as permissões do momento do login: o gestor ganha a permissão dedicada de RESTRICTED antes de a API subir
  restore = await env.withRolePermissions({ 'CI GESTOR': { [VIEW_RESTRICTED]: true } });
  http = await env.start(process.env.PORT);
  A = http.tenants.A; B = http.tenants.B;
});
afterEach(async () => { if (env.DISPOSABLE) await env.reset(); });
after(async () => { if (env.DISPOSABLE) { await env.reset(); await restore(); } await stopHttp({}); });

const ask = (who, id, over) => http.call(who, 'GET', `/files/${id}/download?${env.query(over)}`);

test('m9d920 download HIGH com marca pedida aplica a marca por usuário e mantém o hash do original', { skip: skip() }, async () => {
  const file = await env.uploadPdf(http, 'gestorA', { classification: 'HIGH', pages: 2 });
  await env.grantMfa(A);
  const asked = await ask('gestorA', file.id, { watermark: '1' });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.data.classification, 'HIGH');
  assert.equal(asked.body.data.watermark, true);
  assert.match(asked.body.data.downloadUrl, new RegExp(`^/api/v1/files/downloads/${asked.body.data.exportJobId}\\?exp=\\d+&sig=[0-9a-f]{64}$`));
  const got = await env.raw(http, 'gestorA', asked.body.data.downloadUrl);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('x-watermark'), 'applied');
  assert.equal(got.headers.get('x-original-sha256'), file.sha256, 'o hash informado é o do original');
  assert.match(got.headers.get('content-disposition'), /^attachment; filename="contrato.pdf"/);
  const delivered = Buffer.from(await got.arrayBuffer());
  assert.ok(delivered.subarray(0, file.buffer.length).equals(file.buffer), 'a marca é uma atualização no fim: o original segue byte a byte');
  assert.match(delivered.toString('latin1'), /Nayara One \xb7 .+ \xb7 \d{4}-\d{2}-\d{2} \d{2}:\d{2} \xb7 [0-9a-f-]{36}/, 'texto da marca: usuário, data e pedido');
  assert.equal((await env.fileRow(file.id)).checksum_sha256, file.sha256, 'o hash guardado do original não muda');
  const again = await env.raw(http, 'gestorA', `/files/${file.id}/content`);
  assert.equal(again.status, 200, 'o original continua sendo servido sem marca (leitura em tela de HIGH)');
  assert.ok(Buffer.from(await again.arrayBuffer()).equals(file.buffer));
  const audits = await env.adminQuery("SELECT after_json FROM audit.audit_log WHERE action = 'files.downloaded' AND entity_id = $1", [file.id]);
  assert.equal(audits.rows.length, 1);
  assert.ok(audits.rows[0].after_json.ip && audits.rows[0].after_json.userAgent && audits.rows[0].after_json.watermark === true);
  assert.deepEqual(audits.rows[0].after_json.originalSha256, [file.sha256]);
  const job = (await env.jobsOf('DOWNLOAD'))[0];
  assert.deepEqual([job.status, job.download_count, job.watermark, job.estimated_rows, job.resource_type], ['READY', 1, true, 1, 'files.file']);
});

test('m9d920 falha na marca d\'água recusa o download', { skip: skip() }, async () => {
  const broken = await env.upload(http, 'gestorA', { buffer: Buffer.from('%PDF-1.4\nnão é um PDF de verdade, sem referência cruzada'), fileName: 'quebrado.pdf' });
  await env.grantMfa(A);
  const asked = await ask('gestorA', broken.id, { watermark: '1' });
  assert.equal(asked.status, 200, 'o pedido é aprovado: o tipo (PDF) aceita marca');
  const got = await env.raw(http, 'gestorA', asked.body.data.downloadUrl);
  assert.equal(got.status, 422);
  const body = await got.json();
  assert.equal(body.error.code, 'GOV_FILE_WATERMARK_FAILED');
  assert.equal(body.error.message, 'Não foi possível aplicar a marca d\'água; o download foi recusado.');
  const job = (await env.jobsOf('DOWNLOAD'))[0];
  assert.deepEqual([job.status, job.error_code, job.download_count], ['FAILED', 'GOV_FILE_WATERMARK_FAILED', 0], 'nada foi entregue e o endereço não vale mais');
  const retry = await env.raw(http, 'gestorA', asked.body.data.downloadUrl);
  assert.equal(retry.status, 409);
  assert.equal((await env.adminQuery("SELECT 1 FROM audit.audit_log WHERE action = 'files.downloaded' AND entity_id = $1", [broken.id])).rowCount, 0, 'não houve download para auditar');
});

test('m9d920 download em tipo sem suporte a marca d\'água devolve 422 GOV_FILE_WATERMARK_UNSUPPORTED', { skip: skip() }, async () => {
  const doc = await env.upload(http, 'gestorA', { buffer: Buffer.from('conteudo do word'), fileName: 'proposta.doc', mimeType: 'application/msword' });
  await env.grantMfa(A);
  const asked = await ask('gestorA', doc.id, { watermark: '1' });
  assert.equal(asked.status, 422);
  assert.equal(asked.body.error.code, 'GOV_FILE_WATERMARK_UNSUPPORTED');
  assert.equal(asked.body.error.message, 'Este tipo de arquivo não aceita marca d\'água.');
  assert.equal((await env.jobsOf('DOWNLOAD'))[0].status, 'FAILED');
  const plain = await ask('gestorA', doc.id);
  assert.equal(plain.status, 200, 'sem marca pedida nem ligada pela política, o mesmo arquivo baixa normalmente');
  const text = await env.upload(http, 'gestorA', { buffer: Buffer.from('a;b\n1;2'), fileName: 'dados.csv', mimeType: 'text/csv' });
  const csv = await ask('gestorA', text.id, { watermark: 'true' });
  assert.equal(csv.status, 200, 'CSV aceita a marca (linha final)');
});

test('m9d920 política da classe que liga a marca marca sem o usuário pedir; padrão fica desligado em RESTRICTED', { skip: skip() }, async () => {
  const file = await env.uploadPdf(http, 'gestorA', { classification: 'RESTRICTED' });
  await env.grantMfa(A);
  const asked = await ask('gestorA', file.id);
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const row = (await env.adminQuery("SELECT require_watermark FROM governance.dlp_policies WHERE company_id = $1 AND classification = 'RESTRICTED' AND action = 'EXPORT'", [A.companyId])).rows[0];
  assert.equal(row.require_watermark, false, 'o padrão da marca é só o da M9-D820: desligado');
  assert.equal(asked.body.data.watermark, false);
  const got = await env.raw(http, 'gestorA', asked.body.data.downloadUrl);
  assert.equal(got.headers.get('x-watermark'), 'none');
  assert.ok(Buffer.from(await got.arrayBuffer()).equals(file.buffer), 'sem marca, o arquivo sai igual ao original');
  await env.adminQuery("UPDATE governance.dlp_policies SET require_watermark = true WHERE company_id = $1 AND classification = 'RESTRICTED' AND action = 'EXPORT'", [A.companyId]);
  try {
    const on = await ask('gestorA', file.id);
    assert.equal(on.body.data.watermark, true, 'a política da classe liga a marca');
    const marked = await env.raw(http, 'gestorA', on.body.data.downloadUrl);
    assert.equal(marked.headers.get('x-watermark'), 'applied');
    assert.equal(marked.status, 200);
  } finally { await env.adminQuery('DELETE FROM governance.dlp_policies WHERE company_id = $1', [A.companyId]); }
});

test('m9d920 download HIGH devolve URL assinada que expira no prazo e vale uma vez só', { skip: skip() }, async () => {
  const file = await env.uploadPdf(http, 'gestorA', { classification: 'HIGH' });
  await env.grantMfa(A);
  const before = Date.now();
  const asked = await ask('gestorA', file.id);
  const job = (await env.jobsOf('DOWNLOAD'))[0];
  const minutes = (new Date(job.expires_at) - before) / 60000;
  assert.ok(minutes > 14.5 && minutes < 15.5, `expira em 15 minutos (o menor entre 15 min e as 48 h da classe), deu ${minutes}`);
  assert.ok(Math.abs(new Date(asked.body.data.expiresAt) - new Date(job.expires_at)) < 1500, 'a resposta e o pedido dizem o mesmo prazo');
  const ok = await env.raw(http, 'gestorA', asked.body.data.downloadUrl);
  assert.equal(ok.status, 200);
  const second = await env.raw(http, 'gestorA', asked.body.data.downloadUrl);
  assert.equal(second.status, 410);
  assert.equal((await second.json()).error.code, 'GOV_DOWNLOAD_ALREADY_USED');
  const other = await env.raw(http, 'makerA', asked.body.data.downloadUrl);
  assert.equal(other.status, 403, 'o endereço é de quem pediu');

  const fresh = await ask('gestorA', file.id);
  await env.adminQuery("UPDATE governance.export_jobs SET expires_at = now() - interval '1 second' WHERE id = $1", [fresh.body.data.exportJobId]);
  const gone = await env.raw(http, 'gestorA', fresh.body.data.downloadUrl);
  assert.equal(gone.status, 410);
  assert.equal((await gone.json()).error.code, 'GOV_EXPORT_EXPIRED');
  assert.equal((await env.jobsOf('DOWNLOAD')).find((j) => j.id === fresh.body.data.exportJobId).status, 'EXPIRED');

  const forged = await ask('gestorA', file.id);
  const bad = await env.raw(http, 'gestorA', forged.body.data.downloadUrl.replace(/sig=[0-9a-f]{64}/, `sig=${'0'.repeat(64)}`));
  assert.deepEqual([bad.status, (await bad.json()).error.code], [403, 'GOV_EXPORT_LINK_INVALID']);
});

test('m9d920 o prazo é o menor entre o endereço e o teto da classe', { skip: skip() }, async () => {
  const file = await env.uploadPdf(http, 'gestorA', { classification: 'HIGH' });
  await env.grantMfa(A);
  await env.setSetting(A, 'governanca.dlp.download.url_min', 600);
  await env.adminQuery("UPDATE governance.dlp_policies SET max_expiry_hours = 1 WHERE company_id = $1 AND classification = 'HIGH' AND action = 'EXPORT'", [A.companyId]).catch(() => null);
  try {
    await ask('gestorA', file.id);
    const hours = (new Date((await env.jobsOf('DOWNLOAD')).at(-1).expires_at) - Date.now()) / 3600000;
    assert.ok(hours < 1.02 && hours > 0.9, `vale o teto de 1 h, não os 600 minutos; deu ${hours}`);
  } finally { await env.clearSetting(A, 'governanca.dlp.download.url_min'); await env.adminQuery('DELETE FROM governance.dlp_policies WHERE company_id = $1', [A.companyId]); }
});

test('m9d920 download alimenta o detector de anomalia', { skip: skip() }, async () => {
  const file = await env.uploadPdf(http, 'gestorA', { classification: 'HIGH' });
  await env.grantMfa(A);
  const before = (await env.adminQuery("SELECT count(*)::int AS n FROM governance.access_signals WHERE user_id = $1 AND action = 'EXPORT'", [A.userId])).rows[0].n;
  assert.equal((await ask('gestorA', file.id)).status, 200);
  const blocked = await ask('gestorA', file.id, { justification: 'curta' });
  assert.equal(blocked.status, 422);
  const after = (await env.adminQuery("SELECT count(*)::int AS n FROM governance.access_signals WHERE user_id = $1 AND action = 'EXPORT'", [A.userId])).rows[0];
  assert.equal(after.n - before, 2, 'o download aprovado e o bloqueado viram sinal de exportação');
});

test('m9d920 isolamento entre empresas: outra empresa não vê o anexo nem usa o endereço', { skip: skip() }, async () => {
  const file = await env.uploadPdf(http, 'gestorA', { classification: 'HIGH' });
  await env.grantMfa(A);
  const foreign = await ask('gestorB', file.id);
  assert.equal(foreign.status, 404);
  const asked = await ask('gestorA', file.id);
  const stolen = await env.raw(http, 'gestorB', asked.body.data.downloadUrl);
  assert.equal(stolen.status, 404, 'o pedido da empresa A não existe para a B');
  assert.equal((await env.jobsOf('DOWNLOAD')).filter((j) => j.company_id === B.companyId).length, 0);
});

test('m9d920 LOW e MEDIUM baixam direto com auditoria simples e sem pedido', { skip: skip() }, async () => {
  const file = await env.uploadPdf(http, 'gestorA', { classification: 'MEDIUM' });
  const res = await env.raw(http, 'gestorA', `/files/${file.id}/download`);
  assert.equal(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(file.buffer));
  assert.equal((await env.jobsOf('DOWNLOAD')).length, 0, 'LOW e MEDIUM não geram pedido do guard');
  assert.ok((await env.adminQuery("SELECT 1 FROM audit.audit_log WHERE action = 'files.downloaded' AND entity_id = $1", [file.id])).rowCount >= 1);
});

test('m9d920 imagem HIGH com marca sai como PDF marcado e o hash do original não muda', { skip: skip() }, async () => {
  const image = await env.upload(http, 'gestorA', { buffer: jpegBuffer(), fileName: 'fachada.jpg', mimeType: 'image/jpeg' });
  await env.grantMfa(A);
  const asked = await ask('gestorA', image.id, { watermark: '1' });
  const got = await env.raw(http, 'gestorA', asked.body.data.downloadUrl);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/pdf');
  assert.match(got.headers.get('content-disposition'), /filename="fachada.pdf"/);
  const buffer = Buffer.from(await got.arrayBuffer());
  assert.match(pdfText(buffer), /Nayara One/);
  assert.equal((await env.fileRow(image.id)).checksum_sha256, env.sha(jpegBuffer()));
});

test('m9d920 pedido de download que ninguém usou até o prazo vira EXPIRED na passada do job de expiração', { skip: skip() }, async () => {
  const file = await env.uploadPdf(http, 'gestorA', { classification: 'HIGH' });
  await env.grantMfa(A);
  const asked = await ask('gestorA', file.id);
  const id = asked.body.data.exportJobId;
  await env.adminQuery("UPDATE governance.export_jobs SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
  const { expireCompany } = require('../../../src/features/core-governance/dlp/exports/export.expiry');
  const { withOwnTenantTransaction } = require('../../../src/features/core-governance/dlp/guard.tx');
  const out = await withOwnTenantTransaction(A, A.userId, (tx) => expireCompany({ groupId: A.groupId, companyId: A.companyId }, tx));
  assert.ok(out.grantsExpired >= 1);
  assert.equal((await env.jobsOf('DOWNLOAD')).find((j) => j.id === id).status, 'EXPIRED');
  const late = await env.raw(http, 'gestorA', asked.body.data.downloadUrl);
  assert.deepEqual([late.status, (await late.json()).error.code], [410, 'GOV_EXPORT_EXPIRED']);
});
