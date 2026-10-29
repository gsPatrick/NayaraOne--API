'use strict';

// M9-D822 — formatos e marca d'água. Parte pura (sem banco): CSV, XLSX e PDF a partir de linhas. Parte com banco: o pedido real com watermark: true, a política que liga a marca e a
// coluna técnica _wm.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const env = require('../_helpers/exportsEnv');
const { renderFile } = require('../../../src/features/core-governance/dlp/exports/render');
const { downloadExport } = require('../../../src/features/core-governance/dlp/exports/export.download');
const { signDownloadUrl } = require('../../../src/features/core-governance/dlp/exports/export.url');
const policyService = require('../../../src/features/core-governance/dlp/policy.service');

const COLUMNS = [{ key: 'id', label: 'Id', classification: 'HIGH' }, { key: 'amount', label: 'Valor', classification: 'HIGH', numeric: true }, { key: 'description', label: 'Descrição', classification: 'RESTRICTED' }];
const ROWS = [{ id: 'a1', amount: '-10.50', description: '=1+1' }, { id: 'a2', amount: '20', description: 'normal; com "aspas"' }];
const ENTRY = { label: 'Lançamentos' };
const WM = { enabled: true, text: 'Nayara One · {usuario} · {data} · {job}', csvText: '# Exportado por {usuario} em {data} (job {job})', vars: { usuario: 'Ana', data: '2026-10-29 10:00', job: 'JOB-1' } };
const render = (format, watermark) => renderFile({ format, entry: ENTRY, columns: COLUMNS, rows: ROWS, separator: ';', now: '2026-10-29 10:00', watermark });

/** Lê as entradas de um zip pelo diretório central (inflando cada uma). */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let pos = buffer.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(pos + 10); const size = buffer.readUInt32LE(pos + 20); const nameLen = buffer.readUInt16LE(pos + 28); const offset = buffer.readUInt32LE(pos + 42);
    const name = buffer.slice(pos + 46, pos + 46 + nameLen).toString('utf8');
    const localName = buffer.readUInt16LE(offset + 26); const localExtra = buffer.readUInt16LE(offset + 28);
    const data = buffer.slice(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + size);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    pos += 46 + nameLen;
  }
  return out;
}

test('m9d822 CSV sem marca: cabeçalho, números intactos e fórmulas neutralizadas', async () => {
  const { buffer, mimeType, extension } = await render('CSV', null);
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  assert.deepEqual([mimeType, extension], ['text/csv', 'csv']);
  assert.deepEqual(text.trimEnd().split('\n'), ['Id;Valor;Descrição', 'a1;-10.50;\'=1+1', 'a2;20;"normal; com ""aspas"""']);
});

test('m9d822 marca d\'água presente no CSV e no PDF (e no XLSX)', async () => {
  const csv = (await render('CSV', WM)).buffer.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split('\n');
  assert.equal(csv[0], 'Id;Valor;Descrição;_wm', 'coluna técnica _wm');
  assert.ok(csv[1].endsWith(';Nayara One · Ana · 2026-10-29 10:00 · JOB-1'));
  assert.equal(csv.at(-1), '# Exportado por Ana em 2026-10-29 10:00 (job JOB-1)', 'linha final');

  const pdf = (await render('PDF', WM)).buffer;
  assert.equal(pdf.slice(0, 5).toString(), '%PDF-');
  assert.match(env.pdfText(pdf), /Nayara One · Ana · 2026-10-29 10:00 · JOB-1/u);
  assert.doesNotMatch(env.pdfText((await render('PDF', null)).buffer), /JOB-1/);

  const xlsx = unzip((await render('XLSX', WM)).buffer);
  assert.match(xlsx['xl/worksheets/sheet1.xml'], /Nayara One · Ana · 2026-10-29 10:00 · JOB-1/u);
  assert.match(xlsx['xl/styles.xml'], /textRotation="45"/, 'texto na diagonal');
  assert.match(xlsx['xl/worksheets/sheet1.xml'], /<oddHeader>/);
});

test('m9d822 XLSX: pacote válido, número como número e texto neutralizado', async () => {
  const { buffer, mimeType } = await render('XLSX', null);
  assert.equal(mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(buffer.slice(0, 2).toString(), 'PK');
  const files = unzip(buffer);
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<c r="B2"><v>-10.50<\/v><\/c>/);
  assert.match(sheet, /<t xml:space="preserve">'=1\+1<\/t>/);
  assert.doesNotMatch(sheet, /JOB-1/);
});

test('m9d822 arquivo pronto (DIMOB) só ganha a linha final da marca', async () => {
  const ready = { text: '# layout;v1\nid;valor\n1;2\n' };
  const marked = await renderFile({ format: 'CSV', entry: ENTRY, ready, watermark: WM, separator: ';', now: 'x' });
  assert.equal(marked.buffer.toString('utf8'), '# layout;v1\nid;valor\n1;2\n# Exportado por Ana em 2026-10-29 10:00 (job JOB-1)\n');
  const plain = await renderFile({ format: 'CSV', entry: ENTRY, ready, watermark: { ...WM, enabled: false }, separator: ';', now: 'x' });
  assert.equal(plain.buffer.toString('utf8'), ready.text);
});

env.useMonth('1999-02');
let A;
let restore;
before(async () => {
  if (!env.DISPOSABLE) return;
  A = (await env.loadTenants()).A;
  restore = await env.withRolePermissions({ 'CI GESTOR': { 'finance:read': true, 'governance:dlp:export': true } });
  await env.cleanExports();
  await env.seedEntries(A, 2);
});
after(async () => {
  if (env.DISPOSABLE) {
    await env.cleanExports();
    await restore();
  }
  await env.sequelize.close();
});
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const { afterEach } = require('node:test');
afterEach(async () => { if (env.DISPOSABLE) await env.cleanExports(); });
const fetchFile = async (job) => {
  const u = new URL(signDownloadUrl({ jobId: job.id, userId: job.actorUserId, now: new Date(), urlMinutes: 15, fileExpiresAt: job.expiresAt }).url, 'http://x');
  return downloadExport({ tenant: { groupId: A.groupId, companyId: A.companyId }, actorUserId: A.userId, permissions: [], id: job.id, exp: u.searchParams.get('exp'), sig: u.searchParams.get('sig') });
};

test('m9d822 pedido real com watermark: true entrega CSV, XLSX e PDF marcados; sem o pedido nem a política, sem marca', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const marked = {};
  for (const format of ['CSV', 'XLSX', 'PDF']) {
    const { job } = await env.askAndGenerate(A, { format, watermark: true });
    assert.equal(job.status, 'READY', format);
    marked[format] = await fetchFile(job);
    assert.equal(job.fileName.endsWith(format.toLowerCase()), true);
  }
  assert.match(marked.CSV.buffer.toString('utf8'), /_wm[\s\S]*# Exportado por .* \(job [0-9a-f-]{36}\)/u);
  assert.match(env.pdfText(marked.PDF.buffer), /Nayara One · /u);
  assert.match(unzip(marked.XLSX.buffer)['xl/worksheets/sheet1.xml'], /Nayara One · /u);
  const { job: plain } = await env.askAndGenerate(A, { format: 'CSV' });
  assert.doesNotMatch((await fetchFile(plain)).buffer.toString('utf8'), /_wm|# Exportado por/);
});

test('m9d822 a política da classe que liga a marca d\'água vale sem o pedido pedir', { skip: skip() }, async () => {
  await env.grantMfa(A);
  const tenant = { groupId: A.groupId, companyId: A.companyId };
  await env.inBusinessTx(A, (tx) => policyService.updatePolicy(tenant, { userId: A.userId }, 'HIGH', 'EXPORT', { require_watermark: true }, tx));
  const { job } = await env.askAndGenerate(A, { format: 'CSV' });
  assert.match((await fetchFile(job)).buffer.toString('utf8'), /# Exportado por/u);
});
