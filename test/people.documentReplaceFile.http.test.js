'use strict';

/**
 * Pedido da cliente (Marco 3 — Documentos e CRM): "A troca de arquivo validado passou no teste do serviço. Falta confirmar
 * pela rota que o original fica preservado, a nova versão nasce pendente e o novo arquivo passa por antivírus, leitura e
 * revisão próprias." Tudo aqui é HTTP real contra o app (auth JWT + tenant + rotas reais), sem chamar service:
 *   POST /people, POST /people/:id/documents/ingest, POST /files, PATCH /people/:id/documents/:documentId,
 *   GET /people/:id/documents.
 * Grava de verdade: rodar só em banco descartável (scripts/withDisposableDb.js).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M3_DOC_REPLACE_HTTP_PORT || '21611';

require('../app');
const { getSeedTenant, withTenantTransaction, uniqueSuffix, sequelize } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { File, Task, AuditLog } = require('../src/models');
const { storeInvoiceFiles } = require('../src/features/correspondent/fiscal/nfse/nfse.files');
const { EICAR_SIGNATURE } = require('../src/features/people/adapters/AntivirusAdapter');

let tenant;
let baseUrl;
let token;
const CPF = '52998224725';
const b64 = (fields) => Buffer.from(JSON.stringify({ __mockOcr: { fields, confidence: 0.95 } }), 'utf8').toString('base64');

before(async () => {
  tenant = await getSeedTenant();
  token = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: ['people:create', 'people:read', 'people:update', 'governance:dlp:view-restricted'],
  });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  await sequelize.close();
  process.exit(0);
});

async function http(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Pessoa com um IR VERIFIED pela rota (envio -> leitura -> confirmação humana). */
async function pessoaComDocumentoVerificado() {
  const p = await http('POST', '/people', { personType: 'PF', legalName: `Troca HTTP ${uniqueSuffix()}`, allowDuplicate: true });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const personId = p.body.data.id;
  const ing = await http('POST', `/people/${personId}/documents/ingest`, {
    fileName: 'ir-2025.pdf', mimeType: 'application/pdf', documentType: 'IR', contentBase64: b64({ name: 'Fulano de Tal', taxId: CPF, income: 5000 }),
  });
  assert.equal(ing.status, 201, JSON.stringify(ing.body));
  const ver = await http('PATCH', `/people/${personId}/documents/${ing.body.data.document.id}`, { verificationStatus: 'VERIFIED' });
  assert.equal(ver.status, 200, JSON.stringify(ver.body));
  assert.equal(ver.body.data.verificationStatus, 'VERIFIED');
  return { personId, original: ver.body.data };
}

async function subirArquivo(contentBase64, fileName = 'ir-2025-retificada.pdf') {
  return http('POST', '/files', { fileName, mimeType: 'application/pdf', contentBase64, category: 'people-documents' });
}

test('ROTA: trocar o arquivo de um documento VERIFIED preserva o original e cria nova versão PENDENTE com antivírus, leitura e revisão do arquivo novo', async () => {
  const { personId, original } = await pessoaComDocumentoVerificado();
  const up = await subirArquivo(b64({ name: 'Fulano de Tal', taxId: CPF, income: 9100 }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const novoFileId = up.body.data.id;

  const troca = await http('PATCH', `/people/${personId}/documents/${original.id}`, { fileId: novoFileId });
  assert.equal(troca.status, 200, JSON.stringify(troca.body));
  const nova = troca.body.data;
  assert.notEqual(nova.id, original.id, 'a troca cria outra linha, não reescreve o original');
  assert.equal(nova.fileId, novoFileId);
  assert.equal(nova.verificationStatus, 'PENDING');
  assert.equal(nova.verifiedBy, null);
  assert.equal(nova.versionNo, original.versionNo + 1);
  // leitura própria: veio do arquivo novo (renda 9100), nunca herdada do original (renda 5000)
  assert.equal(nova.extractedDataJson.sourceFileId, novoFileId);
  assert.equal(nova.extractedDataJson.fields.income, 9100);
  assert.equal(nova.extractedDataJson.manualFields, undefined);
  // antivírus próprio: o conteúdo do arquivo novo foi examinado na troca
  assert.equal(nova.extractedDataJson.antivirus.clean, true);
  assert.equal(nova.extractedDataJson.antivirus.checksumSha256, up.body.data.checksumSha256);

  const lista = await http('GET', `/people/${personId}/documents`);
  assert.equal(lista.status, 200);
  const antigo = lista.body.data.find((d) => d.id === original.id);
  assert.ok(antigo, 'original continua consultável pela rota');
  assert.equal(antigo.fileId, original.fileId);
  assert.equal(antigo.verificationStatus, 'VERIFIED');
  assert.equal(antigo.versionNo, original.versionNo);
  assert.equal(antigo.extractedDataJson.fields.income, 5000);

  // revisão própria: verificar junto com a troca é recusado; a nova versão é confirmada sozinha, sobre o arquivo novo
  const junto = await http('PATCH', `/people/${personId}/documents/${original.id}`, { fileId: novoFileId, verificationStatus: 'VERIFIED' });
  assert.equal(junto.status, 422);
  assert.equal(junto.body.error.code, 'PERSON_DOCUMENT_REPLACE_FILE_WITH_STATUS');
  const conf = await http('PATCH', `/people/${personId}/documents/${nova.id}`, { verificationStatus: 'VERIFIED' });
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  assert.equal(conf.body.data.verificationStatus, 'VERIFIED');
  assert.equal(conf.body.data.fileId, novoFileId);

  const aud = await withTenantTransaction(tenant, (t) => AuditLog.findOne({ where: { entityId: nova.id, action: 'people.document.replace_file' }, transaction: t }));
  assert.ok(aud, 'troca auditada');
  assert.equal(aud.beforeJson.id, original.id);
  assert.equal(aud.afterJson.id, nova.id);
});

test('ROTA: arquivo novo ilegível vira versão PENDENTE com pendência de revisão aberta, e não pode ser verificado', async () => {
  const { personId, original } = await pessoaComDocumentoVerificado();
  const up = await subirArquivo(Buffer.from('%PDF-1.4 digitalizacao borrada sem texto').toString('base64'));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const troca = await http('PATCH', `/people/${personId}/documents/${original.id}`, { fileId: up.body.data.id });
  assert.equal(troca.status, 200, JSON.stringify(troca.body));
  assert.equal(troca.body.data.verificationStatus, 'PENDING');
  assert.equal(troca.body.data.extractedDataJson.illegible, true);
  assert.deepEqual(troca.body.data.extractedDataJson.fields, {});
  const tarefa = await withTenantTransaction(tenant, (t) => Task.findOne({ where: { relatedEntityType: 'people.persons', relatedEntityId: personId, status: 'OPEN' }, order: [['created_at', 'DESC']], transaction: t }));
  assert.ok(tarefa, 'pendência de revisão do arquivo novo');
  assert.match(tarefa.title, /nova versão \d+ do documento IR \(arquivo trocado\)/);
  const ver = await http('PATCH', `/people/${personId}/documents/${troca.body.data.id}`, { verificationStatus: 'VERIFIED' });
  assert.equal(ver.status, 422);
  assert.equal(ver.body.error.code, 'PERSON_DOCUMENT_ILLEGIBLE');
  const lista = await http('GET', `/people/${personId}/documents`);
  assert.equal(lista.body.data.find((d) => d.id === original.id).verificationStatus, 'VERIFIED');
});

test('ROTA: antivírus do arquivo novo — malware no envio nunca vira arquivo; arquivo que entrou sem exame é examinado na troca e recusado se infectado', async () => {
  const { personId, original } = await pessoaComDocumentoVerificado();
  const eicar = Buffer.from(EICAR_SIGNATURE).toString('base64');
  const up = await subirArquivo(eicar, 'virus.pdf');
  assert.equal(up.status, 422);
  assert.equal(up.body.error.code, 'FILE_UPLOAD_MALWARE_DETECTED');

  // Arquivo gravado por um caminho que não passa pelo POST /files (XML de NFS-e, scan_status vazio) e com malware.
  const { xmlFile } = await withTenantTransaction(tenant, (t) => storeInvoiceFiles({ groupId: tenant.groupId, companyId: tenant.companyId, documentNumber: `INF-${uniqueSuffix()}`, documents: { xml: EICAR_SIGNATURE } }, t));
  assert.equal(xmlFile.scanStatus, null);
  const infectada = await http('PATCH', `/people/${personId}/documents/${original.id}`, { fileId: xmlFile.id });
  assert.equal(infectada.status, 422, JSON.stringify(infectada.body));
  assert.equal(infectada.body.error.code, 'PERSON_DOCUMENT_FILE_MALWARE_DETECTED');

  // Metadado sem binário e nunca examinado: não há o que examinar, então a troca é recusada.
  const semBinario = await withTenantTransaction(tenant, (t) => File.create({ groupId: tenant.groupId, companyId: tenant.companyId, storageKey: `local-db/sem-binario-${uniqueSuffix()}`, fileName: 'sem-binario.pdf', mimeType: 'application/pdf', sizeBytes: 0 }, { transaction: t }));
  const naoExaminado = await http('PATCH', `/people/${personId}/documents/${original.id}`, { fileId: semBinario.id });
  assert.equal(naoExaminado.status, 422, JSON.stringify(naoExaminado.body));
  assert.equal(naoExaminado.body.error.code, 'PERSON_DOCUMENT_FILE_NOT_SCANNED');

  // Nada mudou: só o original, ainda VERIFIED com o arquivo de sempre.
  const lista = await http('GET', `/people/${personId}/documents`);
  assert.equal(lista.body.data.length, 1);
  assert.equal(lista.body.data[0].id, original.id);
  assert.equal(lista.body.data[0].fileId, original.fileId);
  assert.equal(lista.body.data[0].verificationStatus, 'VERIFIED');
});

test('ROTA: arquivo de outra empresa ou inexistente é recusado e não cria versão', async () => {
  const { personId, original } = await pessoaComDocumentoVerificado();
  const r = await http('PATCH', `/people/${personId}/documents/${original.id}`, { fileId: '00000000-0000-4000-8000-000000000000' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'PERSON_DOCUMENT_FILE_NOT_FOUND');
  const lista = await http('GET', `/people/${personId}/documents`);
  assert.equal(lista.body.data.length, 1);
});
