'use strict';

/**
 * Fechamento do Marco 5 — Jurídico, testes adversariais JUR-TS-008, 009 e 010 (Caderno M5 §20) e
 * eventos mínimos do Jurídico (§18 / Guia §15). JUR-TS-011 (export sem permissão) é HTTP e está em
 * m5fech.juridico.rotas.test.js; JUR-TS-012 em m5fech.juridico.nay.test.js.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { newUser, newCase, newDeadline, outboxTypes, PAST } = require('./m5fech.juridico.helpers');
const evidencePackagesService = require('../src/features/legal/evidencePackages.service');
const { processDeadlinesInTransaction } = require('../src/engines/jobs/legalDeadlineAlertJob');
const { LegalDeadline, Notification, Task, EvidencePackage } = require('../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const codeIs = (code) => (err) => { assert.equal(err.code, code); return true; };

test('JUR-TS-008: criar prazo crítico sem origem verificável é bloqueado (DEADLINE_SOURCE_REQUIRED, Guia §12) e nada é gravado; texto de origem sozinho não basta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const before = await LegalDeadline.count({ where: { legalCaseId: legalCase.id }, transaction: t });
    await assert.rejects(newDeadline(legalCase.id, tenant, t, { criticality: 'CRITICAL', sourceDocument: undefined, sourceFileId: undefined }), codeIs('DEADLINE_SOURCE_REQUIRED'));
    await assert.rejects(newDeadline(legalCase.id, tenant, t, { criticality: 'CRITICAL', sourceFileId: undefined, sourceDocument: 'Intimação fictícia (só texto)', sourceEvent: 'Publicação (só texto)' }), codeIs('DEADLINE_SOURCE_REQUIRED'));
    assert.equal(await LegalDeadline.count({ where: { legalCaseId: legalCase.id }, transaction: t }), before);
    const ok = await newDeadline(legalCase.id, tenant, t, { criticality: 'CRITICAL', sourceEvent: 'Publicação DJe fictícia' });
    assert.equal(ok.sourceEvent, 'Publicação DJe fictícia');
    assert.ok(ok.sourceFileId, 'origem verificável gravada');
  });
});

test('JUR-TS-009: prazo crítico vencido sem conclusão alerta o responsável, abre UMA ocorrência CRITICAL, publica legal.deadline.overdue e escala após 24 h', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const owner = await newUser(tenant, t);
    const escalation = await newUser(tenant, t);
    const legalCase = await newCase(tenant, t, { responsibleUserId: owner.id, escalationUserId: escalation.id });
    const d = await newDeadline(legalCase.id, tenant, t, { criticality: 'CRITICAL', dueAt: PAST(2), responsibleUserId: owner.id });
    const now = new Date();
    await processDeadlinesInTransaction(t, now);
    await processDeadlinesInTransaction(t, new Date(now.getTime() + 60000)); // rodar de novo não duplica
    const after1 = await LegalDeadline.findByPk(d.id, { transaction: t });
    assert.equal(after1.lastAlertedSeverity, 'OVERDUE');
    assert.ok(after1.occurrenceTaskId);
    const occurrences = await Task.findAll({ where: { relatedEntityType: 'legal.legal_deadlines', relatedEntityId: d.id }, transaction: t });
    assert.equal(occurrences.length, 1);
    assert.equal(occurrences[0].priority, 'CRITICAL');
    assert.equal(await Notification.count({ where: { userId: owner.id }, transaction: t }), 1);
    assert.equal((await outboxTypes(d.id, t)).filter((x) => x === 'legal.deadline.overdue').length, 1);
    assert.equal(after1.escalatedAt, null, 'antes de 24 h não escala');
    await processDeadlinesInTransaction(t, new Date(now.getTime() + 25 * 3600000));
    const after2 = await LegalDeadline.findByPk(d.id, { transaction: t });
    assert.ok(after2.escalatedAt, 'escalado depois de 24 h sem ação');
    assert.equal(await Notification.count({ where: { userId: escalation.id }, transaction: t }), 1);
    assert.equal(after2.status, 'PENDING', 'escalonar não conclui nem troca o responsável');
    assert.equal(after2.responsibleUserId, owner.id);
  });
});

test('JUR-TS-010: prova alterada — o hash diverge e a integridade falha (export adulterado e linha do banco reescrita)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    const pkg = await evidencePackagesService.createEvidencePackage(legalCase.id, [{ type: 'PHOTO', description: 'Foto do dano', referenceId: null, hash: 'a'.repeat(64) }], tenant.userId, t);
    const exported = await evidencePackagesService.exportEvidencePackage(pkg.id, tenant.userId, t);
    assert.equal(evidencePackagesService.verifyEvidencePackageIntegrity(exported, pkg.packageHash).valid, true);
    const tampered = { ...exported, manifest: [{ ...exported.manifest[0], hash: 'b'.repeat(64) }] };
    assert.equal(evidencePackagesService.verifyEvidencePackageIntegrity(tampered, pkg.packageHash).valid, false);
    // Atacante que reescreve manifesto e hash juntos no arquivo ainda é pego pelo hash gravado no banco.
    const selfConsistent = { ...tampered, packageHash: evidencePackagesService.computePackageHash(tampered.manifest) };
    assert.equal(evidencePackagesService.verifyEvidencePackageIntegrity(selfConsistent).valid, true);
    assert.equal(evidencePackagesService.verifyEvidencePackageIntegrity(selfConsistent, pkg.packageHash).valid, false);
    // Reescrever o manifesto direto no banco: o hash recalculado não bate com o gravado.
    await EvidencePackage.update({ manifestJson: tampered.manifest }, { where: { id: pkg.id }, transaction: t });
    const reread = await evidencePackagesService.getEvidencePackage(pkg.id, t);
    assert.notEqual(evidencePackagesService.computePackageHash(reread.manifestJson), reread.packageHash);
  });
});

test('JR eventos mínimos: legal.case.created, legal.deadline.created, legal.deadline.overdue e evidence.package.created vão para o outbox na transação (§18/Guia §15)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const legalCase = await newCase(tenant, t);
    assert.ok((await outboxTypes(legalCase.id, t)).includes('legal.case.created'));
    const d = await newDeadline(legalCase.id, tenant, t, { dueAt: PAST(1), responsibleUserId: tenant.userId });
    assert.ok((await outboxTypes(d.id, t)).includes('legal.deadline.created'));
    await processDeadlinesInTransaction(t, new Date());
    assert.ok((await outboxTypes(d.id, t)).includes('legal.deadline.overdue'));
    const pkg = await evidencePackagesService.createEvidencePackage(legalCase.id, [{ type: 'NOTE', description: 'Nota' }], tenant.userId, t);
    const pkgEvents = await outboxTypes(pkg.id, t);
    assert.ok(pkgEvents.includes('evidence.package.created'));
    assert.ok(pkgEvents.includes('legal.evidence_package.created'));
  });
});
