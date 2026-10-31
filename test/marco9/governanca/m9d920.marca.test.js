'use strict';

// M9-D920 §3.4 — marca d'água de arquivo (PDF, imagens, CSV): o original não muda, a marca vai em todas as páginas, a estrutura que a marca não alcança é recusada.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { stampPdf } = require('../../../src/features/core-governance/dlp/watermark/pdf.stamp');
const { loadDocument } = require('../../../src/features/core-governance/dlp/watermark/pdf.document');
const { listPages } = require('../../../src/features/core-governance/dlp/watermark/pdf.pages');
const { markFile, canMark } = require('../../../src/features/core-governance/dlp/watermark/watermark.service');
const { pdfBuffer, xrefStreamPdf, pngBuffer, jpegBuffer } = require('../_helpers/m9d920Pdf');

const TEXT = 'Nayara One · Maria Souza · 2026-10-30 10:00 · job-abc';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const latin = (s) => Buffer.from(s, 'latin1');

test('m9d920 marca no PDF: o original fica intacto no começo, todas as páginas ganham a marca e o arquivo continua legível', async () => {
  const original = await pdfBuffer(3);
  const before = sha(original);
  const marked = stampPdf(original, TEXT);
  assert.equal(sha(original), before, 'o buffer original não é alterado');
  assert.ok(marked.subarray(0, original.length).equals(original), 'o original é o prefixo do arquivo marcado (atualização incremental)');
  assert.ok(marked.includes(latin(`(${TEXT})`)), 'o texto da marca (WinAnsi) está no arquivo');
  const doc = loadDocument(marked);
  const pages = listPages(doc, 10);
  assert.equal(pages.length, 3);
  for (const page of pages) {
    const dict = doc.resolve({ ref: page.num, gen: 0 }).dict;
    assert.equal(dict.Contents.length, 3, 'abre q, conteúdo original e a marca');
    assert.ok(doc.resolve(doc.resolve(dict.Resources).dict.Font).dict.NayWmF, 'a fonte da marca está nos recursos da página');
  }
  // as fontes e imagens que a página já tinha continuam lá
  const firstDict = doc.resolve({ ref: pages[0].num, gen: 0 }).dict;
  assert.ok(Object.keys(doc.resolve(doc.resolve(firstDict.Resources).dict.Font).dict).length >= 2);
});

test('m9d920 marca no PDF duas vezes: cada revisão encadeia a anterior e o arquivo segue legível', async () => {
  const original = await pdfBuffer(1);
  const once = stampPdf(original, 'primeira');
  const twice = stampPdf(once, 'segunda');
  assert.ok(twice.subarray(0, once.length).equals(once));
  assert.equal(listPages(loadDocument(twice), 10).length, 1);
  assert.equal(loadDocument(twice).resolve({ ref: listPages(loadDocument(twice), 10)[0].num, gen: 0 }).dict.Contents.length, 5);
});

test('m9d920 marca no PDF moderno (referência cruzada em fluxo, preditor PNG e objetos em fluxo)', () => {
  const original = xrefStreamPdf();
  const marked = stampPdf(original, TEXT);
  assert.ok(marked.subarray(0, original.length).equals(original));
  assert.ok(marked.latin1Slice(original.length, marked.length).includes('/Type/XRef'), 'a atualização usa fluxo de referência cruzada como o original');
  const doc = loadDocument(marked);
  const [page] = listPages(doc, 10);
  assert.equal(doc.resolve({ ref: page.num, gen: 0 }).dict.Contents.length, 3);
  assert.deepEqual(doc.resolve({ ref: page.num, gen: 0 }).dict.MediaBox, [0, 0, 400, 300], 'o resto do dicionário da página fica como estava');
});

test('m9d920 PDF cifrado, corrompido ou com páginas demais não aceita marca', async () => {
  const original = await pdfBuffer(3);
  const encrypted = Buffer.from(original.latin1Slice(0, original.length).replace('/Root', '/Encrypt <</Filter/Standard>> /Root'), 'latin1');
  await assert.rejects(() => markFile({ buffer: encrypted, mimeType: 'application/pdf', fileName: 'a.pdf' }, TEXT), (e) => e.code === 'GOV_FILE_WATERMARK_UNSUPPORTED');
  await assert.rejects(() => markFile({ buffer: original, mimeType: 'application/pdf', fileName: 'a.pdf' }, TEXT, { maxPages: 2 }), (e) => e.code === 'GOV_FILE_WATERMARK_UNSUPPORTED');
  await assert.rejects(() => markFile({ buffer: Buffer.from('%PDF-1.4\nlixo sem estrutura'), mimeType: 'application/pdf', fileName: 'a.pdf' }, TEXT), (e) => e.code === 'GOV_FILE_WATERMARK_FAILED' && e.statusCode === 422);
});

test('m9d920 imagem JPEG e PNG saem como PDF com a marca; GIF, Office e vídeo não aceitam marca', async () => {
  for (const [buffer, mimeType] of [[jpegBuffer(), 'image/jpeg'], [pngBuffer(), 'image/png']]) {
    const out = await markFile({ buffer, mimeType, fileName: 'foto.jpg' }, TEXT);
    assert.equal(out.mimeType, 'application/pdf');
    assert.equal(out.fileName, 'foto.pdf');
    assert.equal(out.buffer.latin1Slice(0, 5), '%PDF-');
    assert.equal(listPages(loadDocument(out.buffer), 5).length, 1);
  }
  for (const mimeType of ['image/gif', 'application/msword', 'video/mp4', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'audio/mpeg']) {
    assert.equal(canMark(mimeType), false, mimeType);
    await assert.rejects(() => markFile({ buffer: Buffer.from('x'), mimeType, fileName: 'x' }, TEXT), (e) => e.code === 'GOV_FILE_WATERMARK_UNSUPPORTED' && e.statusCode === 422);
  }
});

test('m9d920 CSV recebe a marca na linha final e o conteúdo anterior fica igual', async () => {
  const csv = Buffer.from('a;b\n1;2', 'utf8');
  const out = await markFile({ buffer: csv, mimeType: 'text/csv', fileName: 'x.csv' }, TEXT);
  assert.equal(out.buffer.toString('utf8'), `a;b\n1;2\n# ${TEXT}\n`);
  assert.equal(csv.toString('utf8'), 'a;b\n1;2');
});
