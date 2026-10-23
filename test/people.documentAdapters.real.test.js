'use strict';

// Motores reais de antivírus (ClamAV) e leitura de documento (pdftotext + Tesseract) atrás dos
// adaptadores do Marco 3. Os testes que exigem os binários ou o daemon pulam sozinhos quando o
// ambiente não os tem (CI sem ClamAV/Tesseract), e rodam de verdade onde eles existem.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const personService = require('../src/features/people/person.service');
const { ingestPersonDocument } = require('../src/features/people/documentIngestion.service');
const { ClamAvAdapter } = require('../src/features/people/adapters/ClamAvAdapter');
const { LocalOcrAdapter, extractFields } = require('../src/features/people/adapters/LocalOcrAdapter');
const { resolveAntivirusAdapter, resolveOcrAdapter } = require('../src/features/people/adapters/resolveDocumentAdapters');
const { SandboxAntivirusAdapter, EICAR_SIGNATURE } = require('../src/features/people/adapters/AntivirusAdapter');
const { SandboxOcrAdapter } = require('../src/features/people/adapters/OcrAdapter');

let tenant;
let clamdUp = false;
let ocrTools = false;
let workDir;
let textPdf;
let textPng;
let scannedPdf;
let blankPng;

function have(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function clamdReachable() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 3310 });
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
    socket.on('connect', () => { socket.write('zPING\0'); });
    socket.on('data', (d) => { socket.destroy(); resolve(String(d).includes('PONG')); });
  });
}

function buildPdf(lines) {
  const content = `BT /F1 14 Tf 50 780 Td 18 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, '')}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

before(async () => {
  tenant = await getSeedTenant();
  clamdUp = await clamdReachable();
  ocrTools = have('pdftotext') && have('pdftoppm') && have('tesseract');
  if (ocrTools) {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nayara-ocr-fixtures-'));
    textPdf = buildPdf(['Nome: MARIA FICTICIA DA SILVA', 'CPF: 529.982.247-25', 'Renda mensal: R$ 4.500,00', 'Emissao: 10/01/2026', 'Validade: 10/01/2036']);
    const textPdfPath = path.join(workDir, 'texto.pdf');
    fs.writeFileSync(textPdfPath, textPdf);
    execFileSync('pdftoppm', ['-r', '200', '-png', '-singlefile', textPdfPath, path.join(workDir, 'texto')]);
    textPng = fs.readFileSync(path.join(workDir, 'texto.png'));
    if (have('sips')) {
      execFileSync('sips', ['-s', 'format', 'pdf', path.join(workDir, 'texto.png'), '--out', path.join(workDir, 'escaneado.pdf')], { stdio: 'ignore' });
      scannedPdf = fs.readFileSync(path.join(workDir, 'escaneado.pdf'));
    }
    const blankPdfPath = path.join(workDir, 'vazio.pdf');
    fs.writeFileSync(blankPdfPath, buildPdf([' ']));
    execFileSync('pdftoppm', ['-r', '100', '-png', '-singlefile', blankPdfPath, path.join(workDir, 'vazio')]);
    blankPng = fs.readFileSync(path.join(workDir, 'vazio.png'));
  }
});

after(async () => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  await sequelize.close();
});

test('resolvers: sem variável de ambiente continuam nos adaptadores de laboratório; com ela entram os reais', async () => {
  const before = { a: process.env.ANTIVIRUS_PROVIDER, o: process.env.OCR_PROVIDER };
  try {
    delete process.env.ANTIVIRUS_PROVIDER;
    delete process.env.OCR_PROVIDER;
    assert.ok((await resolveAntivirusAdapter({})) instanceof SandboxAntivirusAdapter);
    assert.ok((await resolveOcrAdapter({})) instanceof SandboxOcrAdapter);
    process.env.ANTIVIRUS_PROVIDER = 'clamav';
    process.env.OCR_PROVIDER = 'local';
    assert.ok((await resolveAntivirusAdapter({})) instanceof ClamAvAdapter);
    assert.ok((await resolveOcrAdapter({})) instanceof LocalOcrAdapter);
  } finally {
    if (before.a === undefined) delete process.env.ANTIVIRUS_PROVIDER; else process.env.ANTIVIRUS_PROVIDER = before.a;
    if (before.o === undefined) delete process.env.OCR_PROVIDER; else process.env.OCR_PROVIDER = before.o;
  }
});

test('ClamAV: antivírus fora do ar falha FECHADO (nunca aprova sem varredura)', async () => {
  const adapter = new ClamAvAdapter({ host: '127.0.0.1', port: 1, timeoutMs: 1500 });
  await assert.rejects(() => adapter.scan(Buffer.from('qualquer')), (err) => err.code === 'ANTIVIRUS_UNAVAILABLE');
});

test('ClamAV real: arquivo com a assinatura de teste EICAR é recusado e um arquivo comum passa', { skip: false }, async (t) => {
  if (!clamdUp) return t.skip('clamd não está rodando neste ambiente');
  const adapter = new ClamAvAdapter();
  const infected = await adapter.scan(Buffer.from(EICAR_SIGNATURE, 'utf8'));
  assert.equal(infected.clean, false);
  assert.match(infected.signature, /eicar/i);
  const clean = await adapter.scan(Buffer.from('Contrato de locação sem nada de malicioso.', 'utf8'));
  assert.equal(clean.clean, true);
  assert.equal(clean.signature, null);
});

test('extractFields: só preenche campo que está no texto, nunca inventa', () => {
  const { fields } = extractFields('Documento qualquer sem rótulos reconhecíveis');
  assert.deepEqual(fields, {});
  const found = extractFields('Nome: JOSE TESTE\nCPF: 529.982.247-25\nRenda mensal: R$ 1.234,56\nValidade: 31/12/2030');
  assert.equal(found.fields.name, 'JOSE TESTE');
  assert.equal(found.fields.taxId, '52998224725');
  assert.equal(found.fields.income, 1234.56);
  assert.equal(found.fields.expiresAt, '2030-12-31');
  assert.ok(found.sources.name.includes('JOSE TESTE'));
});

test('OCR real: PDF com texto é lido pelo pdftotext com origem e confiança', async (t) => {
  if (!ocrTools) return t.skip('pdftotext/tesseract não instalados');
  const result = await new LocalOcrAdapter().extract(textPdf, 'IR');
  assert.equal(result.illegible, false);
  assert.equal(result.raw.engine, 'pdftotext');
  assert.equal(result.raw.source, 'pdf-text');
  assert.ok(result.confidence >= 0.9);
  assert.equal(result.fields.name, 'MARIA FICTICIA DA SILVA');
  assert.equal(result.fields.taxId, '52998224725');
  assert.equal(result.fields.income, 4500);
  assert.equal(result.fields.issuedAt, '2026-01-10');
  assert.equal(result.fields.expiresAt, '2036-01-10');
  assert.ok(result.raw.fieldSources.taxId);
});

test('OCR real: imagem do mesmo documento é lida pelo Tesseract', async (t) => {
  if (!ocrTools) return t.skip('pdftotext/tesseract não instalados');
  const result = await new LocalOcrAdapter().extract(textPng, 'IR');
  assert.equal(result.illegible, false);
  assert.equal(result.raw.engine, 'tesseract');
  assert.equal(result.raw.source, 'image');
  assert.ok(result.confidence > 0.5, `confiança ${result.confidence}`);
  assert.equal(result.fields.taxId, '52998224725');
  assert.match(result.fields.name, /MARIA FICTICIA DA SILVA/i);
});

test('OCR real: PDF escaneado (sem texto) cai no Tesseract', async (t) => {
  if (!ocrTools || !scannedPdf) return t.skip('pdftotext/tesseract/sips não disponíveis');
  const result = await new LocalOcrAdapter().extract(scannedPdf, 'IR');
  assert.equal(result.illegible, false);
  assert.equal(result.raw.source, 'pdf-scan');
  assert.equal(result.fields.taxId, '52998224725');
});

test('OCR real: página em branco, bytes aleatórios e PDF corrompido viram ILEGÍVEL, sem campo inventado', async (t) => {
  if (!ocrTools) return t.skip('pdftotext/tesseract não instalados');
  const adapter = new LocalOcrAdapter();
  for (const sample of [blankPng, Buffer.from('isto nao e um documento'), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('lixo sem estrutura')])]) {
    const result = await adapter.extract(sample, 'RG');
    assert.equal(result.illegible, true);
    assert.deepEqual(result.fields, {});
  }
});

test('pipeline completo com motores reais: EICAR é recusado, PDF legível guarda origem e confiança, ilegível abre pendência', async (t) => {
  if (!ocrTools || !clamdUp) return t.skip('clamd e/ou OCR não disponíveis neste ambiente');
  const saved = { a: process.env.ANTIVIRUS_PROVIDER, o: process.env.OCR_PROVIDER };
  process.env.ANTIVIRUS_PROVIDER = 'clamav';
  process.env.OCR_PROVIDER = 'local';
  try {
    await withRollbackTenantTransaction(tenant, async (transaction) => {
      const person = await personService.createPerson(
        { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Ingestão real ${uniqueSuffix()}` },
        tenant.userId,
        transaction
      );
      const base = { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, mimeType: 'application/pdf' };

      await assert.rejects(
        () => ingestPersonDocument({ ...base, fileName: 'eicar.pdf', documentType: 'RG', contentBase64: Buffer.from(EICAR_SIGNATURE).toString('base64') }, tenant.userId, transaction),
        (err) => err.code === 'DOCUMENT_INGESTION_MALWARE_DETECTED'
      );

      const ok = await ingestPersonDocument({ ...base, fileName: 'ir.pdf', documentType: 'IR', contentBase64: textPdf.toString('base64') }, tenant.userId, transaction);
      const data = ok.personDocument.extractedDataJson;
      assert.equal(data.sourceFileId, ok.file.id);
      assert.ok(data.confidence >= 0.9);
      assert.equal(data.extractionMeta.engine, 'pdftotext');
      assert.equal(data.fields.taxId, '52998224725');
      assert.equal(ok.personDocument.verificationStatus, 'PENDING');
      assert.equal(ok.pendingTask, null);

      const bad = await ingestPersonDocument({ ...base, fileName: 'branco.png', mimeType: 'image/png', documentType: 'RG', contentBase64: blankPng.toString('base64') }, tenant.userId, transaction);
      assert.equal(bad.personDocument.extractedDataJson.illegible, true);
      assert.deepEqual(bad.personDocument.extractedDataJson.fields, {});
      assert.ok(bad.pendingTask, 'documento ilegível abre pendência de revisão');
    });
  } finally {
    if (saved.a === undefined) delete process.env.ANTIVIRUS_PROVIDER; else process.env.ANTIVIRUS_PROVIDER = saved.a;
    if (saved.o === undefined) delete process.env.OCR_PROVIDER; else process.env.OCR_PROVIDER = saved.o;
  }
});

test('auditoria: a leitura do documento e a validação humana gravam antes/depois', async () => {
  const { updateDocument } = require('../src/features/people/personDocuments.service');
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await personService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Auditoria doc ${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    const payload = { __mockOcr: { fields: { name: person.legalName }, confidence: 0.9 } };
    const { personDocument } = await ingestPersonDocument(
      { groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, fileName: 'rg.pdf', mimeType: 'application/pdf', documentType: 'RG', contentBase64: Buffer.from(JSON.stringify(payload)).toString('base64') },
      tenant.userId,
      transaction
    );
    await updateDocument(person.id, personDocument.id, { verificationStatus: 'VERIFIED' }, tenant.userId, transaction);
    const [rows] = await sequelize.query(
      `SELECT action, before_json, after_json FROM audit.audit_log WHERE entity_id = :id ORDER BY occurred_at`,
      { replacements: { id: personDocument.id }, transaction }
    );
    const actions = rows.map((r) => r.action);
    assert.ok(actions.includes('people.document.ingest'));
    const update = rows.find((r) => r.action === 'people.document.update');
    assert.ok(update);
    assert.equal(update.before_json.verificationStatus, 'PENDING');
    assert.equal(update.after_json.verificationStatus, 'VERIFIED');
  });
});

test('Marco 8: documento do caso passa pela leitura real; ilegível abre pendência e a sugestão traz origem e confiança', async (t) => {
  if (!ocrTools || !clamdUp) return t.skip('clamd e/ou OCR não disponíveis neste ambiente');
  const financingCases = require('../src/features/correspondent/cases/financingCases.service');
  const caseDocuments = require('../src/features/correspondent/cases/caseDocuments.service');
  const { uploadFile } = require('../src/features/files/files.service');
  const { Person, Task } = require('../src/models');
  const saved = { a: process.env.ANTIVIRUS_PROVIDER, o: process.env.OCR_PROVIDER };
  process.env.ANTIVIRUS_PROVIDER = 'clamav';
  process.env.OCR_PROVIDER = 'local';
  try {
    await withRollbackTenantTransaction(tenant, async (transaction) => {
      const ctx = { groupId: tenant.groupId, companyId: tenant.companyId };
      const principal = await Person.create(
        { ...ctx, personType: 'PF', legalName: `Proponente M8 ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
        { transaction }
      );
      const financingCase = await financingCases.createFinancingCase({ ...ctx, applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] }, tenant.userId, transaction);
      const send = async (docType, fileName, mimeType, buffer) => {
        const requirement = await caseDocuments.createRequirement(financingCase.id, { documentType: docType }, tenant.userId, ctx, transaction);
        const file = await uploadFile({ ...ctx, fileName, mimeType, contentBase64: buffer.toString('base64'), category: 'correspondent' }, tenant.userId, transaction);
        return caseDocuments.uploadDocument(financingCase.id, requirement.id, { fileId: file.id }, tenant.userId, ctx, transaction);
      };

      await assert.rejects(
        () => send('RG_CPF', 'eicar.pdf', 'application/pdf', Buffer.from(EICAR_SIGNATURE)),
        (err) => err.code === 'FILE_UPLOAD_MALWARE_DETECTED'
      );

      const legivel = await send('COMPROVANTE_RENDA', 'renda.pdf', 'application/pdf', textPdf);
      assert.match(legivel.suggestedNote, /Leitura automática \(texto do PDF, confiança de 95%\)/);
      assert.match(legivel.suggestedNote, /CPF\/CNPJ: 529\.982\.247-25/);

      const ilegivel = await send('IPTU', 'iptu.png', 'image/png', blankPng);
      assert.match(ilegivel.suggestedNote, /ilegível/i);
      const tasks = await Task.findAll({ where: { relatedEntityId: financingCase.id }, transaction });
      assert.equal(tasks.length, 1);
    });
  } finally {
    if (saved.a === undefined) delete process.env.ANTIVIRUS_PROVIDER; else process.env.ANTIVIRUS_PROVIDER = saved.a;
    if (saved.o === undefined) delete process.env.OCR_PROVIDER; else process.env.OCR_PROVIDER = saved.o;
  }
});
