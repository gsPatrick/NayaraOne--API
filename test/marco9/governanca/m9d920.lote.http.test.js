'use strict';

// M9-D920 §3.3 — download em lote (zip): conta como exportação com volume = número de arquivos, passa sempre pelo guard e cada arquivo dentro leva a marca d'água do pedido.
// porta livre escolhida pelo SO (listen(0)): nem fixa (colide com outra API de pé) nem sorteada em 30000-49999 (cai na faixa efêmera do Linux, usada pelas conexões do próprio teste ao banco)
process.env.PORT = process.env.M9D920_LOTE_TEST_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d920Env');
const { File } = require('../../../src/models');
const { withTenantTransaction } = require('../../testHelpers');

let http; let A;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);

before(async () => {
  if (!env.DISPOSABLE) return;
  http = await env.start(process.env.PORT);
  A = http.tenants.A;
});
afterEach(async () => { if (env.DISPOSABLE) await env.reset(); });
after(async () => { if (env.DISPOSABLE) await env.reset(); await stopHttp({}); });

/** Entradas de um zip (nome e conteúdo) lendo o diretório central. */
function unzip(buffer) {
  const entries = [];
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buffer.readUInt32LE(end + 16);
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i += 1) {
    const nameLen = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const size = buffer.readUInt32LE(at + 20);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLen);
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    entries.push({ name, data: zlib.inflateRawSync(buffer.subarray(dataAt, dataAt + size)) });
    at += 46 + nameLen;
  }
  return entries;
}

const post = (body) => http.call('gestorA', 'POST', '/files/download-batch', { purpose: 'AUDITORIA', justification: env.JUSTIFICATION, ...body });
const fakeFiles = (count) => withTenantTransaction(A, async (transaction) => {
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const file = await File.create({ groupId: A.groupId, companyId: A.companyId, storageKey: `qa-m9/d920/${Date.now()}-${i}.pdf`, fileName: `anexo-${i}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, uploadedByUserId: A.userId, createdBy: A.userId, updatedBy: A.userId }, { transaction });
    ids.push(file.id);
  }
  return ids;
});

test('m9d920 zip em lote passa pelo guard com volume', { skip: skip() }, async () => {
  const ids = await fakeFiles(40);
  await env.grantMfa(A);
  const res = await post({ fileIds: ids });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const job = (await env.jobsOf('DOWNLOAD'))[0];
  assert.deepEqual([job.estimated_rows, job.status, job.classification, job.resource_type, job.action], [40, 'APPROVED', 'HIGH', 'files.file', 'EXPORT'], 'o volume é o número de arquivos');
  assert.equal(job.resource_ref.fileIds.length, 40);
  assert.match(res.body.data.downloadUrl, /^\/api\/v1\/files\/downloads\/[0-9a-f-]{36}\?exp=\d+&sig=[0-9a-f]{64}$/);

  await env.clearSignals(); // os 40 arquivos do pedido acima já passam do limiar de acesso em massa (M9-D824); o teste do teto de volume parte de um usuário sem suspensão
  await env.adminQuery("UPDATE governance.dlp_policies SET max_rows = 30 WHERE company_id = $1 AND classification = 'HIGH' AND action = 'EXPORT'", [A.companyId]);
  const tooMany = await post({ fileIds: ids });
  assert.deepEqual([tooMany.status, tooMany.body.error.code], [422, 'GOV_DLP_VOLUME_EXCEEDED'], 'o teto de volume da classe vale para o lote');
  const blocked = (await env.jobsOf('DOWNLOAD')).find((j) => j.id === tooMany.body.error.details.exportJobId);
  assert.deepEqual([blocked.status, blocked.block_reason, blocked.estimated_rows], ['BLOCKED', 'VOLUME', 40]);
});

test('m9d920 o lote entrega um zip com cada arquivo marcado e o original intacto', { skip: skip() }, async () => {
  const a = await env.uploadPdf(http, 'gestorA', { pages: 1, fileName: 'contrato.pdf' });
  const b = await env.uploadPdf(http, 'gestorA', { pages: 2, fileName: 'contrato.pdf' });
  await env.grantMfa(A);
  const asked = await post({ fileIds: [a.id, b.id], watermark: true });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.data.watermark, true);
  const got = await env.raw(http, 'gestorA', asked.body.data.downloadUrl);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/zip');
  const entries = unzip(Buffer.from(await got.arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['contrato.pdf', 'contrato-2.pdf'], 'nome repetido ganha número');
  assert.ok(entries[0].data.subarray(0, a.buffer.length).equals(a.buffer) && entries[0].data.length > a.buffer.length);
  assert.ok(entries[1].data.subarray(0, b.buffer.length).equals(b.buffer) && entries[1].data.toString('latin1').includes('Nayara One'));
  assert.equal((await env.fileRow(a.id)).checksum_sha256, a.sha256);
  const audit = (await env.adminQuery("SELECT after_json FROM audit.audit_log WHERE action = 'files.downloaded' AND entity_id = $1", [asked.body.data.exportJobId])).rows[0];
  assert.deepEqual([audit.after_json.count, audit.after_json.fileIds.length, audit.after_json.watermark], [2, 2, true]);
});

test('m9d920 lote inválido, arquivo ilegível ou sem MFA é recusado inteiro', { skip: skip() }, async () => {
  const a = await env.uploadPdf(http, 'gestorA');
  await env.grantMfa(A);
  for (const body of [{ fileIds: [] }, { fileIds: [a.id, a.id] }, { fileIds: ['x'] }, {}]) {
    const bad = await post(body);
    assert.deepEqual([bad.status, bad.body.error.code], [400, 'GOV_DOWNLOAD_BATCH_INVALID']);
  }
  await env.setSetting(A, 'governanca.dlp.download.lote_max', 1);
  try {
    const b = await env.uploadPdf(http, 'gestorA');
    const over = await post({ fileIds: [a.id, b.id] });
    assert.deepEqual([over.status, over.body.error.code, over.body.error.details.max], [400, 'GOV_DOWNLOAD_BATCH_INVALID', 1], 'o tamanho do lote é parâmetro');
  } finally { await env.clearSetting(A, 'governanca.dlp.download.lote_max'); }
  const maker = await http.call('makerA', 'POST', '/files/download-batch', { fileIds: [a.id], purpose: 'AUDITORIA', justification: env.JUSTIFICATION });
  assert.deepEqual([maker.status, maker.body.error.code], [403, 'FILE_ATTACH_FORBIDDEN'], 'quem não lê um dos arquivos não baixa o lote (o guard de vínculo recusa antes: o lote traz ids de arquivo)');
  const foreign = await http.call('gestorB', 'POST', '/files/download-batch', { fileIds: [a.id], purpose: 'AUDITORIA', justification: env.JUSTIFICATION });
  assert.equal(foreign.status, 404);
  await env.revokeMfa(A.userId);
  const noMfa = await post({ fileIds: [a.id] });
  assert.deepEqual([noMfa.status, noMfa.body.error.code], [403, 'MFA_STEP_UP_REQUIRED']);
  assert.equal((await env.jobsOf('DOWNLOAD')).at(-1).status, 'BLOCKED');
});

test('m9d920 lote de LOW e MEDIUM também passa pelo guard e registra o pedido', { skip: skip() }, async () => {
  const a = await env.uploadPdf(http, 'gestorA', { classification: 'LOW' });
  const b = await env.uploadPdf(http, 'gestorA', { classification: 'MEDIUM' });
  const res = await http.call('gestorA', 'POST', '/files/download-batch', { fileIds: [a.id, b.id] });
  const job = (await env.jobsOf('DOWNLOAD'))[0];
  assert.equal(res.status, 201, JSON.stringify([res.body, job && job.decision_trace]));
  assert.deepEqual([job.classification, job.estimated_rows, job.status], ['MEDIUM', 2, 'APPROVED']);
  const got = await env.raw(http, 'gestorA', res.body.data.downloadUrl);
  assert.equal(unzip(Buffer.from(await got.arrayBuffer())).length, 2);
});
