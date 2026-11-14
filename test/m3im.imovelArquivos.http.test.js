'use strict';

/**
 * Marco 3 — documento e mídia do imóvel com ARQUIVO REAL, passado pelo antivírus (verificação independente de 11/11/2026: M3-06 e
 * CAD-06). Antes, o documento era só metadado e a mídia aceitava qualquer `storageKey` digitado, com a qualidade vinda do corpo.
 * HTTP real; antivírus ClamAV real (ANTIVIRUS_PROVIDER=clamav, clamd em CLAMAV_HOST/CLAMAV_PORT). Só em banco descartável.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M3IM_ARQ_HTTP_PORT || '36102';
process.env.ANTIVIRUS_PROVIDER = 'clamav';

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { AuditLog } = require('../src/models');
const { storeInvoiceFiles } = require('../src/features/correspondent/fiscal/nfse/nfse.files');
const { EICAR_SIGNATURE } = require('../src/features/people/adapters/AntivirusAdapter');
const { ENDERECO } = require('./helpers/m3imPublicavel');

let tenant;
let baseUrl;
let token;
let tokenSoPessoas;
let tokenSoImoveis;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF m3im foto da fachada')]).toString('base64');
const PDF = Buffer.from('%PDF-1.4\n% matricula do imovel m3im\n').toString('base64');

before(async () => {
  tenant = await getSeedTenant();
  const claims = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'] };
  token = signAccessToken({ ...claims, permissions: ['properties:create', 'properties:read', 'properties:update'] });
  // Outro usuário (não é quem enviou): só lê o arquivo quem tem a leitura do módulo dono.
  const [[leitor]] = await sequelize.query("SELECT id FROM core.users WHERE email = 'ci-a-leitura@ci.nayaraone.test'");
  assert.ok(leitor, 'usuário de leitura do tenant A (scripts/seed-ci-two-tenants.js)');
  const outro = { ...claims, sub: leitor.id, roles: ['broker'] };
  tokenSoPessoas = signAccessToken({ ...outro, permissions: ['people:read'] });
  tokenSoImoveis = signAccessToken({ ...outro, permissions: ['properties:read'] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, p, body, t = token) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const subir = (contentBase64, fileName, mimeType, category) => http('POST', '/files', { fileName, mimeType, contentBase64, category });

async function imovel() {
  const s = uniqueSuffix();
  const r = await http('POST', '/properties', { title: `Arquivos ${s}`, internalCode: `AR-${s}`, propertyType: 'RESIDENTIAL', ...ENDERECO });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

test('mídia: exige o arquivo real, ignora storageKey e tipo do corpo, recusa qualidade no envio e nasce PENDENTE, auditada com o antivírus', async () => {
  const casa = await imovel();
  const up = await subir(JPEG, 'fachada.jpg', 'image/jpeg', 'property-media');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const file = up.body.data;

  const semArquivo = await http('POST', `/properties/${casa.id}/media`, { mediaType: 'IMAGE', storageKey: 'qualquer/coisa.jpg', mimeType: 'image/jpeg' });
  assert.equal(semArquivo.status, 400);
  assert.equal(semArquivo.body.error.code, 'PROPERTY_FILE_REQUIRED');

  const aprovadaNoCorpo = await http('POST', `/properties/${casa.id}/media`, { mediaType: 'IMAGE', fileId: file.id, qualityStatus: 'APPROVED' });
  assert.equal(aprovadaNoCorpo.status, 400);
  assert.equal(aprovadaNoCorpo.body.error.code, 'PROPERTY_MEDIA_QUALITY_STATUS_NOT_ALLOWED');

  const comoVideo = await http('POST', `/properties/${casa.id}/media`, { mediaType: 'VIDEO', fileId: file.id });
  assert.equal(comoVideo.status, 400);
  assert.equal(comoVideo.body.error.code, 'PROPERTY_FILE_TYPE_MISMATCH');

  const ok = await http('POST', `/properties/${casa.id}/media`, { mediaType: 'IMAGE', fileId: file.id, storageKey: 'ignorado/forjado.jpg', mimeType: 'video/mp4' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.fileId, file.id);
  assert.equal(ok.body.data.storageKey, file.storageKey, 'a chave vem do arquivo, nunca do corpo');
  assert.equal(ok.body.data.mimeType, 'image/jpeg');
  assert.equal(ok.body.data.qualityStatus, 'PENDING');
  const aud = await withTenantTransaction(tenant, (t) => AuditLog.findOne({ where: { entityId: ok.body.data.id, action: 'property.media.create' }, transaction: t }));
  assert.equal(aud.afterJson.antivirus.clean, true);
  assert.equal(aud.afterJson.antivirus.engine, 'clamav');

  const lista = await http('GET', `/properties/${casa.id}/media`);
  assert.equal(lista.body.data.length, 1, 'as tentativas recusadas não gravaram nada');
});

test('antivírus: malware não entra pelo envio e o arquivo que entrou sem exame é examinado no vínculo e recusado', async () => {
  const casa = await imovel();
  const eicar = Buffer.from(EICAR_SIGNATURE).toString('base64');
  const up = await subir(eicar, 'matricula.pdf', 'application/pdf', 'property-documents');
  assert.equal(up.status, 422);
  assert.equal(up.body.error.code, 'FILE_UPLOAD_MALWARE_DETECTED');

  // Arquivo gravado por um caminho que não passa pelo POST /files (PDF de NFS-e, scan_status vazio) e com malware.
  const { pdfFile } = await withTenantTransaction(tenant, (t) => storeInvoiceFiles({ groupId: tenant.groupId, companyId: tenant.companyId, documentNumber: `M3IM-${uniqueSuffix()}`, documents: { pdf: EICAR_SIGNATURE } }, t));
  assert.equal(pdfFile.scanStatus, null);
  const doc = await http('POST', `/properties/${casa.id}/documents`, { documentType: 'REGISTRY', fileId: pdfFile.id, valueNumber: '12345' });
  assert.equal(doc.status, 422, JSON.stringify(doc.body));
  assert.equal(doc.body.error.code, 'PROPERTY_FILE_MALWARE_DETECTED');
  const midia = await http('POST', `/properties/${casa.id}/media`, { mediaType: 'FLOORPLAN', fileId: pdfFile.id });
  assert.equal(midia.body.error.code, 'PROPERTY_FILE_MALWARE_DETECTED');

  const inexistente = await http('POST', `/properties/${casa.id}/documents`, { documentType: 'IPTU', fileId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(inexistente.status, 404);
  assert.equal(inexistente.body.error.code, 'PROPERTY_FILE_NOT_FOUND');
  assert.equal((await http('GET', `/properties/${casa.id}/documents`)).body.data.length, 0);
});

test('documento: exige o arquivo, guarda o vínculo, só lê o arquivo quem tem a leitura de Imóveis e apagar é auditado', async () => {
  const casa = await imovel();
  const semArquivo = await http('POST', `/properties/${casa.id}/documents`, { documentType: 'IPTU', valueNumber: '021.045.0123-4' });
  assert.equal(semArquivo.status, 400);
  assert.equal(semArquivo.body.error.code, 'PROPERTY_FILE_REQUIRED');

  const up = await subir(PDF, 'matricula.pdf', 'application/pdf', 'property-documents');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const doc = await http('POST', `/properties/${casa.id}/documents`, { documentType: 'REGISTRY', fileId: up.body.data.id, valueNumber: 'MAT-77', label: '1º Cartório' });
  assert.equal(doc.status, 201, JSON.stringify(doc.body));
  assert.equal(doc.body.data.fileId, up.body.data.id);

  const ficha = await http('GET', `/properties/${casa.id}`);
  assert.equal(ficha.body.data.documents[0].fileId, up.body.data.id, 'a ficha traz o documento com o arquivo');

  assert.equal((await http('GET', `/files/${up.body.data.id}/content`, undefined, tokenSoPessoas)).status, 403, 'sem properties:read não lê');
  assert.equal((await http('GET', `/files/${up.body.data.id}`, undefined, tokenSoImoveis)).status, 200, 'o arquivo pertence ao imóvel');

  const apagado = await http('DELETE', `/properties/${casa.id}/documents/${doc.body.data.id}`);
  assert.equal(apagado.status, 200);
  const aud = await withTenantTransaction(tenant, (t) => AuditLog.findAll({ where: { entityId: doc.body.data.id }, order: [['occurred_at', 'ASC']], transaction: t }));
  assert.deepEqual(aud.map((a) => a.action), ['property.document.create', 'property.document.delete']);
  assert.equal(aud[1].beforeJson.fileId, up.body.data.id);
});

test('§6 separação Property x Offer x Media no banco: imóvel sem preço, oferta sem endereço/matrícula e com condições, mídia com arquivo e sem regra comercial', async () => {
  const [cols] = await sequelize.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'real_estate' AND table_name IN ('properties', 'property_offers', 'property_media', 'property_documents')`
  );
  const de = (t) => cols.filter((c) => c.table_name === t).map((c) => c.column_name);
  const property = de('properties');
  const offer = de('property_offers');
  const media = de('property_media');
  assert.ok(!property.some((c) => /price|preco|asking/.test(c)), 'Property não guarda preço comercial');
  for (const c of ['offer_type', 'asking_price', 'conditions', 'status', 'accepts_financing', 'accepts_trade']) assert.ok(offer.includes(c), `Offer tem ${c}`);
  assert.ok(!offer.some((c) => /address|street|zip|registry|city|neighborhood/.test(c)), 'Offer não duplica endereço nem matrícula');
  for (const c of ['file_id', 'position', 'classification', 'quality_status']) assert.ok(media.includes(c), `Media tem ${c}`);
  assert.ok(!media.some((c) => /price|financing|trade|offer/.test(c)), 'Media não tem regra comercial');
  assert.ok(de('property_documents').includes('file_id'), 'documento do imóvel aponta para o arquivo');
});
