'use strict';

/**
 * Fechamento M5 (vistorias e prazos) — cadeia de custódia (livro JUR-010 "Arquivo, áudio, foto e documento mantêm
 * hash/origem/acessos"; §16 "Manifesto do dossiê lista arquivos, hashes, origem..."; "Acesso/exportação são auditados"):
 *  - M5-A0307: a leitura individual de uma prova do Jurídico (GET /files/:id e /files/:id/content) é registrada em QUALQUER
 *    classe de arquivo (LOW, MEDIUM, HIGH), com hash e origem; arquivo que não é prova do Jurídico não gera esse registro;
 *  - M5-A0207: a origem e o hash de cada item do manifesto vêm do servidor (o chamador não escolhe);
 *  - M5-A0117: a lista de dossiês do processo grava o acesso na cadeia de custódia e na auditoria.
 * Fixtures COMMITADAS (as requisições HTTP rodam em transações próprias), no banco descartável do teste.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.PORT = process.env.M5VP_EVIDENCIAS_HTTP_TEST_PORT || '32251';

require('../app');
const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const filesService = require('../src/features/files/files.service');
const caseDocuments = require('../src/modules/legal/cases/legalCaseDocuments.service');
const evidencePackagesService = require('../src/modules/legal/cases/evidence-package.service');
const { AuditLog, EvidencePackageAccessLog } = require('../src/models');
const { newCase } = require('./m5fech.juridico.helpers');

let tenant;
let baseUrl;
before(async () => {
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 300));
});
after(async () => {
  await sequelize.close();
  process.exit(0);
});

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const token = (permissions) => signAccessToken({ sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['m5vp'], permissions });

async function get(path, permissions) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token(permissions)}` } });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  return { status: res.status, body: isJson ? await res.json() : await res.arrayBuffer() };
}

const accessAudits = (fileId) => withTenantTransaction(tenant, (t) => AuditLog.findAll({ where: { action: 'legal.evidence.file_access', entityId: fileId }, order: [['created_at', 'ASC']], transaction: t }));

async function uploadAs(classification, name) {
  return withTenantTransaction(tenant, (t) => filesService.uploadFile(
    { ...base(), fileName: name, mimeType: 'application/pdf', contentBase64: Buffer.from(`${name} ${uniqueSuffix()}`).toString('base64'), category: 'generic', classification },
    tenant.userId,
    t
  ));
}

test('M5-A0307/JUR-010: ler uma prova do processo (dados e conteúdo) fica registrado em toda classe de arquivo, com hash e origem', async () => {
  const legalCase = await withTenantTransaction(tenant, (t) => newCase(tenant, t));
  for (const classification of ['LOW', 'MEDIUM', 'HIGH']) {
    const file = await uploadAs(classification, `prova-${classification}.pdf`);
    await withTenantTransaction(tenant, (t) => caseDocuments.linkCaseDocument(legalCase.id, { fileId: file.id, purpose: 'EVIDENCE' }, tenant.userId, t));
    assert.equal((await accessAudits(file.id)).length, 0);

    const meta = await get(`/files/${file.id}`, ['legal:read']);
    assert.equal(meta.status, 200, JSON.stringify(meta.body));
    const content = await get(`/files/${file.id}/content`, ['legal:read']);
    assert.equal(content.status, 200);

    const audits = await accessAudits(file.id);
    assert.deepEqual(audits.map((a) => a.afterJson.acesso), ['METADATA', 'CONTENT'], `classe ${classification}`);
    for (const a of audits) {
      assert.equal(a.afterJson.classificacao, classification);
      assert.equal(a.afterJson.sha256, file.checksumSha256);
      assert.ok(a.afterJson.origem.includes('people.file_links:LegalCase'), 'origem: documento do processo');
      assert.equal(a.userId, tenant.userId);
    }
  }
  // Arquivo que não é prova do Jurídico não entra nessa cadeia de custódia.
  const plain = await uploadAs('LOW', 'rascunho-qualquer.pdf');
  assert.equal((await get(`/files/${plain.id}/content`, ['legal:read'])).status, 200);
  assert.equal((await accessAudits(plain.id)).length, 0);
});

test('M5-A0207/Guia §13: origem e hash do manifesto vêm do servidor — o chamador não escolhe a origem nem o hash do item sem arquivo', async () => {
  await withTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const linked = await filesService.uploadFile({ ...base(), fileName: 'laudo.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from(`laudo ${uniqueSuffix()}`).toString('base64'), category: 'generic' }, tenant.userId, t);
    await caseDocuments.linkCaseDocument(legalCase.id, { fileId: linked.id, purpose: 'EVIDENCE' }, tenant.userId, t);
    const loose = await filesService.uploadFile({ ...base(), fileName: 'solto.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from(`solto ${uniqueSuffix()}`).toString('base64'), category: 'generic' }, tenant.userId, t);
    const pkg = await evidencePackagesService.createEvidencePackage(
      legalCase.id,
      [
        { type: 'EVIDENCE', description: 'Laudo', fileId: linked.id, source: 'cartorio.inventado', hash: 'f'.repeat(64) },
        { type: 'EVIDENCE', description: 'Solto', fileId: loose.id, source: 'perito.externo' },
        { type: 'NOTE', description: 'Ata da audiência', referenceId: 'ATA-7', hash: 'abc', source: 'tribunal' },
      ],
      tenant.userId,
      t
    );
    const [a, b, c] = pkg.manifestJson;
    assert.equal(a.source, 'people.file_links:LegalCase');
    assert.equal(a.hash, linked.checksumSha256);
    assert.equal(b.source, 'people.files', 'arquivo sem vínculo: origem é o upload');
    assert.equal(c.source, 'declaracao_manual');
    assert.equal(c.hash, crypto.createHash('sha256').update(JSON.stringify({ type: 'NOTE', description: 'Ata da audiência', referenceId: 'ATA-7' })).digest('hex'));
    assert.equal(pkg.packageHash, evidencePackagesService.computePackageHash(pkg.manifestJson));
  });
});

test('M5-A0117/§16: a lista de dossiês do processo grava o acesso (cadeia de custódia + auditoria), também pela rota HTTP', async () => {
  const { legalCase, pkg } = await withTenantTransaction(tenant, async (t) => {
    const lc = await newCase(tenant, t);
    const p = await evidencePackagesService.createEvidencePackage(lc.id, [{ type: 'NOTE', description: 'Nota do dossiê' }], tenant.userId, t);
    return { legalCase: lc, pkg: p };
  });
  const custody = () => withTenantTransaction(tenant, (t) => EvidencePackageAccessLog.count({ where: { evidencePackageId: pkg.id, action: 'VIEWED' }, transaction: t }));
  assert.equal(await custody(), 0);

  const res = await get(`/legal/cases/${legalCase.id}/evidence-packages`, ['legal:read']);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
  assert.equal(await custody(), 1, 'a listagem entra na cadeia de custódia');
  const audits = await withTenantTransaction(tenant, (t) => AuditLog.findAll({ where: { action: 'legal.evidence_package.list', entityId: legalCase.id }, transaction: t }));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].afterJson.pacotes[0].id, pkg.id);

  await get(`/legal/cases/${legalCase.id}/evidence-packages`, ['legal:read']);
  assert.equal(await custody(), 2, 'cada listagem é um acesso novo (histórico nunca sobrescrito)');
});
