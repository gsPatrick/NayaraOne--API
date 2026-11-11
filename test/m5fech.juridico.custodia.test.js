'use strict';

/**
 * Fechamento do Marco 5 — Jurídico, cadeia de custódia e dossiê (Caderno M5 §16, JUR-010/011,
 * Guia §13). Postgres real com RLS, transação desfeita no fim.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { newCase, fakeFile, sha256 } = require('./m5fech.juridico.helpers');
const filesService = require('../src/features/files/files.service');
const legalCasesService = require('../src/modules/legal/cases/legal-case.service');
const evidencePackagesService = require('../src/modules/legal/cases/evidence-package.service');
const legalHoldGuard = require('../src/features/core-governance/data-quality/legalHold.guard');
const legalRouter = require('../src/modules/legal/shared/legal.routes');
const { AuditLog, EvidencePackageAccessLog, File } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const codeIs = (code) => (err) => { assert.equal(err.code, code); return true; };
const upload = (t, name, text) => filesService.uploadFile(
  { groupId: tenant.groupId, companyId: tenant.companyId, fileName: name, mimeType: 'application/pdf', contentBase64: Buffer.from(text).toString('base64'), category: 'generic' },
  tenant.userId,
  t
);

test('JR custódia: original preservado com SHA-256; versão derivada é outro arquivo e o original não muda; conteúdo que não bate com o hash é recusado (§16)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const originalText = `%PDF-1.4 prova original JR ${crypto.randomUUID()}`;
    const original = await upload(t, 'foto-original.pdf', originalText);
    assert.equal(original.checksumSha256, sha256(Buffer.from(originalText)));
    const derivedText = `${originalText} (recorte com contraste)`;
    const derived = await upload(t, 'foto-recorte.pdf', derivedText);
    assert.notEqual(derived.id, original.id, 'a derivada é um arquivo separado');
    assert.notEqual(derived.checksumSha256, original.checksumSha256);
    const read = await filesService.getFileContent(original.id, t, tenant.userId);
    assert.equal(read.getDataValue('content').toString(), originalText, 'o original continua byte a byte');
    assert.equal((await File.findByPk(original.id, { transaction: t })).checksumSha256, sha256(Buffer.from(originalText)));
    // Hash gravado diferente do conteúdo (prova alterada): a leitura é bloqueada.
    await File.update({ checksumSha256: sha256('outro conteúdo') }, { where: { id: original.id }, transaction: t });
    await assert.rejects(filesService.getFileContent(original.id, t, tenant.userId), codeIs('FILE_INTEGRITY_VIOLATION'));
  });
});

test('JR dossiê: item com fileId usa hash, nome e data do servidor (o hash do chamador é ignorado); arquivo inexistente é 400; pacote antigo de 4 campos mantém o hash (§16/Guia §13)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const file = await fakeFile(tenant, t, { name: 'laudo.pdf' });
    const pkg = await evidencePackagesService.createEvidencePackage(
      legalCase.id,
      [{ type: 'EVIDENCE', description: 'Laudo pericial', fileId: file.id, hash: 'hash-inventado-pelo-cliente' }, { type: 'NOTE', description: 'Nota sem arquivo', hash: 'abc' }],
      tenant.userId,
      t
    );
    const [fileItem, noteItem] = pkg.manifestJson;
    assert.equal(fileItem.hash, file.checksumSha256);
    assert.equal(fileItem.originalName, 'laudo.pdf');
    assert.equal(fileItem.fileId, file.id);
    assert.equal(fileItem.source, 'people.files');
    assert.ok(Date.parse(fileItem.createdAt));
    assert.deepEqual(Object.keys(noteItem).sort(), ['description', 'hash', 'referenceId', 'type'], 'item sem arquivo segue com os 4 campos');
    assert.equal(pkg.packageHash, evidencePackagesService.computePackageHash(pkg.manifestJson));
    const legacy = [{ type: 'CONTRACT', description: 'x', referenceId: null, hash: 'h' }];
    assert.equal(evidencePackagesService.computePackageHash(legacy), crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex'), 'hash dos pacotes antigos não muda');
    await assert.rejects(
      evidencePackagesService.createEvidencePackage(legalCase.id, [{ type: 'EVIDENCE', description: 'x', fileId: '00000000-0000-4000-8000-000000000000' }], tenant.userId, t),
      codeIs('LEGAL_EVIDENCE_PACKAGE_FILE_NOT_FOUND')
    );
  });
});

test('JR dossiê: cada exportação gera package_id e hash de manifesto novos; acesso e exportação ficam na cadeia de custódia e na auditoria (§16)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const pkg = await evidencePackagesService.createEvidencePackage(legalCase.id, [{ type: 'NOTE', description: 'Prova fictícia' }], tenant.userId, t);
    await evidencePackagesService.viewEvidencePackage(pkg.id, tenant.userId, t);
    const e1 = await evidencePackagesService.exportEvidencePackage(pkg.id, tenant.userId, t);
    const e2 = await evidencePackagesService.exportEvidencePackage(pkg.id, tenant.userId, t);
    assert.notEqual(e1.exportPackageId, e2.exportPackageId);
    assert.notEqual(e1.exportManifestHash, e2.exportManifestHash);
    assert.match(e1.exportManifestHash, /^[0-9a-f]{64}$/);
    assert.equal(e1.packageHash, pkg.packageHash);
    assert.equal(evidencePackagesService.verifyEvidencePackageIntegrity(e1, pkg.packageHash).valid, true);
    const log = await EvidencePackageAccessLog.findAll({ where: { evidencePackageId: pkg.id }, order: [['accessed_at', 'ASC']], transaction: t });
    assert.deepEqual(log.map((l) => l.action), ['VIEWED', 'EXPORTED', 'EXPORTED']);
    assert.ok(log.every((l) => l.accessedByUserId === tenant.userId));
    assert.equal(await AuditLog.count({ where: { action: 'legal.evidence_package.access', entityId: log.map((l) => l.id) }, transaction: t }), 3);
  });
});

test('JR legal hold: processo em hold bloqueia descarte (409 GOV_HOLD_BLOCKS_DISPOSAL) e mudança de status; liberado, a checagem passa (§16)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    await assert.rejects(legalCasesService.setLegalHold(legalCase.id, { legalHold: true }, tenant.userId, t), codeIs('LEGAL_CASE_LEGAL_HOLD_REASON_REQUIRED'));
    await legalCasesService.setLegalHold(legalCase.id, { legalHold: true, reason: 'Litígio fictício' }, tenant.userId, t);
    assert.deepEqual(await legalHoldGuard.heldIds('LEGAL_CASE', [legalCase.id], { transaction: t }), [legalCase.id]);
    await assert.rejects(legalHoldGuard.assertNotOnHold('LEGAL_CASE', legalCase.id, t, tenant), codeIs('GOV_HOLD_BLOCKS_DISPOSAL'));
    await assert.rejects(legalCasesService.updateLegalCase(legalCase.id, { status: 'CLOSED' }, tenant.userId, t), codeIs('LEGAL_CASE_ON_LEGAL_HOLD'));
    await legalCasesService.setLegalHold(legalCase.id, { legalHold: false }, tenant.userId, t);
    await legalHoldGuard.assertNotOnHold('LEGAL_CASE', legalCase.id, t, tenant);
  });
});

test('JR sem exclusão destrutiva: a API jurídica não tem rota DELETE de processo, prazo, contrato, assinatura, vistoria, dossiê ou prova; os serviços não exportam exclusão (JUR-011)', () => {
  const deletes = [];
  for (const layer of legalRouter.stack) {
    if (layer.route && layer.route.methods.delete) deletes.push(layer.route.path);
  }
  assert.deepEqual(deletes, ['/legal/guarantees/:id'], 'só a garantia (fora da lista do JUR-011 e guardada pela retenção legal) tem DELETE');
  for (const file of ['cases/legal-case', 'cases/deadline', 'cases/evidence-package', 'contracts/application/contract', 'signatures/signature', 'inspections/inspection', 'contracts/application/contractVersions', 'cases/legalCaseDocuments']) {
    const service = require(`../src/modules/legal/${file}.service`);
    const destructive = Object.keys(service).filter((name) => /^(delete|remove|destroy|purge)/i.test(name));
    assert.deepEqual(destructive, [], `${file}.service exporta exclusão: ${destructive.join(', ')}`);
  }
});
