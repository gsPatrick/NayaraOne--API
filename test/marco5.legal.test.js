'use strict';

/**
 * marco5.legal.test.js — testes reais (banco de homologação, RLS ativo, tudo dentro de
 * transação com rollback) dos itens do Caderno CURRENT, Marco 5 — Contratos/Locação/Jurídico:
 * M5-01 (templates e cláusulas versionadas), M5-07 (versão contratual exige documento),
 * M5-25 (aditivos), M5-26 (partes e fases do processo), M5-27 (escalonamento de prazos),
 * M5-28 (cadeia de custódia do dossiê), M5-29 (export + verificação de integridade) e
 * M5-21 (responsabilidade pelo dano na vistoria).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const contractClausesService = require('../src/features/legal/contractClauses.service');
const contractTemplatesService = require('../src/features/legal/contractTemplates.service');
const contractAmendmentsService = require('../src/features/legal/contractAmendments.service');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const evidencePackagesService = require('../src/features/legal/evidencePackages.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const { processDeadlinesInTransaction } = require('../src/engines/jobs/legalDeadlineAlertJob');
const { File, ContractClause, ContractAmendment, Notification, LegalDeadline } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createFakeDocumentFile(transaction) {
  const suffix = uniqueSuffix();
  return File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      storageKey: `m5-legal/${suffix}.pdf`,
      fileName: `doc-${suffix}.pdf`,
      mimeType: 'application/pdf',
      uploadedByUserId: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

async function createContract(transaction) {
  return contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
    tenant.userId,
    transaction
  );
}

// ---------------------------------------------------------------------------
// M5-01 — Templates contratuais e biblioteca de cláusulas versionados
// ---------------------------------------------------------------------------

test('M5-01: nova versão de cláusula PRESERVA a anterior (append-only) e desativa a antiga', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const code = `CLAUSE-MULTA-${uniqueSuffix()}`;
    const v1 = await contractClausesService.createClause(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        code,
        title: 'Multa por rescisão antecipada',
        bodyText: 'Multa de 3 (três) aluguéis vigentes.',
        category: 'PAYMENT',
      },
      tenant.userId,
      transaction
    );
    assert.equal(v1.versionNumber, 1);
    assert.equal(v1.isActive, true);

    const v2 = await contractClausesService.createClauseVersion(
      code,
      { bodyText: 'Multa de 2 (dois) aluguéis vigentes, proporcional ao prazo restante.' },
      tenant.userId,
      transaction
    );
    assert.equal(v2.versionNumber, 2);
    assert.notEqual(v2.id, v1.id);

    // A versão 1 continua existindo, com o TEXTO ORIGINAL intacto — só saiu de circulação.
    const persistedV1 = await ContractClause.findByPk(v1.id, { transaction });
    assert.equal(persistedV1.bodyText, 'Multa de 3 (três) aluguéis vigentes.');
    assert.equal(persistedV1.isActive, false);

    const history = await contractClausesService.listClauseVersions(code, transaction);
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((c) => c.versionNumber), [1, 2]);
  });
});

test('M5-01: cláusula com código duplicado é rejeitada (obriga a criar VERSÃO, não outra cláusula)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const code = `CLAUSE-DUP-${uniqueSuffix()}`;
    const base = {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      code,
      title: 'Cláusula base',
      bodyText: 'Texto.',
      category: 'GENERAL',
    };
    await contractClausesService.createClause(base, tenant.userId, transaction);
    await assert.rejects(
      () => contractClausesService.createClause(base, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_CLAUSE_DUPLICATE_CODE');
        return true;
      }
    );
  });
});

test('M5-01: renderTemplate monta o texto na ordem certa e ignora cláusula desativada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const clauseA = await contractClausesService.createClause(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        code: `CLAUSE-PAG-${suffix}`,
        title: 'DO PAGAMENTO',
        bodyText: 'O aluguel vence todo dia 10.',
        category: 'PAYMENT',
      },
      tenant.userId,
      transaction
    );
    const clauseB = await contractClausesService.createClause(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        code: `CLAUSE-GAR-${suffix}`,
        title: 'DA GARANTIA',
        bodyText: 'Caução de 3 aluguéis.',
        category: 'GUARANTEE',
      },
      tenant.userId,
      transaction
    );
    const clauseC = await contractClausesService.createClause(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        code: `CLAUSE-OLD-${suffix}`,
        title: 'CLÁUSULA REVOGADA',
        bodyText: 'Texto que não deve aparecer.',
        category: 'GENERAL',
      },
      tenant.userId,
      transaction
    );

    const template = await contractTemplatesService.createTemplate(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `Locação Residencial ${suffix}`, contractType: 'LEASE' },
      tenant.userId,
      transaction
    );

    // Vinculadas fora de ordem de propósito: a ordem do documento vem de sortOrder.
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: clauseB.id, sortOrder: 2 }, tenant.userId, transaction);
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: clauseA.id, sortOrder: 1 }, tenant.userId, transaction);
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: clauseC.id, sortOrder: 3 }, tenant.userId, transaction);

    await contractClausesService.deactivateClause(clauseC.id, tenant.userId, transaction);

    const rendered = await contractTemplatesService.renderTemplate(template.id, transaction);
    const expected = [
      `Locação Residencial ${suffix}`,
      'DO PAGAMENTO\nO aluguel vence todo dia 10.',
      'DA GARANTIA\nCaução de 3 aluguéis.',
    ].join('\n\n');
    assert.equal(rendered.content, expected);
    assert.deepEqual(rendered.clauses.map((c) => c.title), ['DO PAGAMENTO', 'DA GARANTIA']);

    // O texto renderizado serve direto como `content` de uma ContractVersion (M5-01 x M5-07).
    const contract = await createContract(transaction);
    const file = await createFakeDocumentFile(transaction);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content: rendered.content, documentFileId: file.id },
      tenant.userId,
      transaction
    );
    assert.ok(version.contentHash);
  });
});

// ---------------------------------------------------------------------------
// M5-07 — versão contratual exige documento JÁ NA CRIAÇÃO (default do tenant)
// ---------------------------------------------------------------------------

test('M5-07: com o padrão do tenant (true), criar versão SEM documentFileId é rejeitado na hora da criação', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createContract(transaction);
    await assert.rejects(
      () =>
        contractVersionsService.createContractVersion(
          contract.id,
          { content: `corpo sem documento ${uniqueSuffix()}` },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_VERSION_DOCUMENT_REQUIRED');
        return true;
      }
    );

    // Com o arquivo real anexado, a criação passa normalmente.
    const file = await createFakeDocumentFile(transaction);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content: `corpo com documento ${uniqueSuffix()}`, documentFileId: file.id },
      tenant.userId,
      transaction
    );
    assert.equal(version.documentFileId, file.id);
  });
});

test('M5-07: override explícito requireDocument:false permite rascunho sem documento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createContract(transaction);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content: `rascunho ${uniqueSuffix()}`, requireDocument: false },
      tenant.userId,
      transaction
    );
    assert.equal(version.documentFileId, null);
  });
});

// ---------------------------------------------------------------------------
// M5-25 — Aditivos contratuais versionados
// ---------------------------------------------------------------------------

test('M5-25: aditivos têm numeração sequencial por contrato e histórico nunca é editado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contractA = await createContract(transaction);
    const contractB = await createContract(transaction);

    const a1 = await contractAmendmentsService.createAmendment(
      contractA.id,
      { reason: 'Reajuste anual IGPM', changes: [{ field: 'totalValue', oldValue: 1000, newValue: 1200 }] },
      tenant.userId,
      transaction
    );
    const a2 = await contractAmendmentsService.createAmendment(
      contractA.id,
      { reason: 'Prorrogação de prazo', changes: [{ field: 'endDate', oldValue: '2026-12-31', newValue: '2027-12-31' }] },
      tenant.userId,
      transaction
    );
    // A numeração é POR CONTRATO: o primeiro aditivo do contrato B volta a ser o nº 1.
    const b1 = await contractAmendmentsService.createAmendment(
      contractB.id,
      { reason: 'Troca de fiador', changes: [{ field: 'guarantorPersonId', oldValue: 'x', newValue: 'y' }] },
      tenant.userId,
      transaction
    );

    assert.equal(a1.amendmentNumber, 1);
    assert.equal(a2.amendmentNumber, 2);
    assert.equal(b1.amendmentNumber, 1);

    const listA = await contractAmendmentsService.listAmendments(contractA.id, transaction);
    assert.deepEqual(listA.map((a) => a.amendmentNumber), [1, 2]);

    // Append-only: o serviço não expõe update/delete, e o conteúdo do 1º aditivo permanece
    // exatamente como criado mesmo depois de assinado o 2º.
    assert.equal(typeof contractAmendmentsService.updateAmendment, 'undefined');
    assert.equal(typeof contractAmendmentsService.deleteAmendment, 'undefined');

    const file = await createFakeDocumentFile(transaction);
    await contractAmendmentsService.signAmendment(a2.id, { documentFileId: file.id }, tenant.userId, transaction);

    const persistedA1 = await ContractAmendment.findByPk(a1.id, { transaction });
    assert.equal(persistedA1.reason, 'Reajuste anual IGPM');
    assert.equal(persistedA1.status, 'DRAFT');
    assert.deepEqual(persistedA1.changesJson, [{ field: 'totalValue', oldValue: 1000, newValue: 1200 }]);

    const persistedA2 = await ContractAmendment.findByPk(a2.id, { transaction });
    assert.equal(persistedA2.status, 'SIGNED');
    assert.equal(persistedA2.documentFileId, file.id);
  });
});

test('M5-25: aditivo SIGNED sem documento assinado é rejeitado, e aditivo sem "changes" também', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createContract(transaction);
    await assert.rejects(
      () =>
        contractAmendmentsService.createAmendment(
          contract.id,
          { reason: 'Aditivo já assinado', changes: [{ field: 'totalValue', newValue: 1 }], status: 'SIGNED' },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_AMENDMENT_DOCUMENT_REQUIRED');
        return true;
      }
    );
    await assert.rejects(
      () => contractAmendmentsService.createAmendment(contract.id, { reason: 'Sem mudanças', changes: [] }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_AMENDMENT_VALIDATION');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// M5-26 — Processos jurídicos com partes e fases formais
// ---------------------------------------------------------------------------

test('M5-26: processo aceita partes formais e mudança de fase auditada (antes/depois)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const legalCase = await legalCasesService.createLegalCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        caseType: 'LITIGATION',
        summary: `Ação de despejo ${suffix}`,
        phase: 'INITIAL_PETITION',
        responsibleUserId: tenant.userId,
      },
      tenant.userId,
      transaction
    );
    assert.equal(legalCase.phase, 'INITIAL_PETITION');

    const plaintiff = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M5 Autor ${suffix}` },
      tenant.userId,
      transaction
    );
    const defendant = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `M5 Réu ${suffix}` },
      tenant.userId,
      transaction
    );

    await legalCasesService.addLegalCaseParty(legalCase.id, { personId: plaintiff.id, partyRole: 'PLAINTIFF' }, tenant.userId, transaction);
    await legalCasesService.addLegalCaseParty(legalCase.id, { personId: defendant.id, partyRole: 'DEFENDANT' }, tenant.userId, transaction);

    const parties = await legalCasesService.listLegalCaseParties(legalCase.id, transaction);
    assert.equal(parties.length, 2);
    assert.deepEqual(parties.map((p) => p.partyRole).sort(), ['DEFENDANT', 'PLAINTIFF']);

    // Mesma pessoa no mesmo papel não duplica.
    await assert.rejects(
      () => legalCasesService.addLegalCaseParty(legalCase.id, { personId: plaintiff.id, partyRole: 'PLAINTIFF' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CASE_PARTY_DUPLICATE');
        return true;
      }
    );
    // Papel inválido é rejeitado.
    await assert.rejects(
      () => legalCasesService.addLegalCaseParty(legalCase.id, { personId: plaintiff.id, partyRole: 'JUIZ' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CASE_PARTY_VALIDATION');
        return true;
      }
    );

    const updated = await legalCasesService.updateLegalCase(legalCase.id, { phase: 'DISCOVERY' }, tenant.userId, transaction);
    assert.equal(updated.phase, 'DISCOVERY');

    const [auditRows] = await sequelize.query(
      `SELECT action, before_json, after_json FROM audit.audit_log
         WHERE entity_type = 'LegalCase' AND entity_id = :id AND action = 'legal.case.phase_change'
         ORDER BY created_at DESC LIMIT 1`,
      { replacements: { id: legalCase.id }, transaction }
    );
    assert.equal(auditRows.length, 1, 'mudança de fase gera registro de auditoria dedicado');
    assert.equal(auditRows[0].before_json.phase, 'INITIAL_PETITION');
    assert.equal(auditRows[0].after_json.phase, 'DISCOVERY');

    // Fase fora da lista conhecida é rejeitada sem o opt-in explícito.
    await assert.rejects(
      () => legalCasesService.updateLegalCase(legalCase.id, { phase: 'FASE_INVENTADA' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CASE_VALIDATION');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// M5-27 — Escalonamento real de prazos jurídicos
// ---------------------------------------------------------------------------

test('M5-27: prazo OVERDUE há mais de 24h sem ação escala para o escalationUserId', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const legalCase = await legalCasesService.createLegalCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        caseType: 'LITIGATION',
        summary: `Escalonamento ${suffix}`,
        responsibleUserId: tenant.userId,
        escalationUserId: tenant.userId,
      },
      tenant.userId,
      transaction
    );

    const deadline = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: `Contestação ${suffix}`, dueAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) },
      tenant.userId,
      transaction
    );

    const notificationsBefore = await Notification.count({ where: { userId: tenant.userId }, transaction });

    // 1ª rodada do job: detecta OVERDUE, notifica o responsável e marca o primeiro alerta.
    const firstRun = await processDeadlinesInTransaction(transaction);
    assert.ok(firstRun.alerted >= 1);
    assert.equal(firstRun.escalated, 0, 'não escala na primeira rodada — o responsável acabou de ser avisado');

    await deadline.reload({ transaction });
    assert.equal(deadline.lastAlertedSeverity, 'OVERDUE');
    assert.ok(deadline.firstOverdueAlertedAt, 'primeiro alerta de OVERDUE é carimbado');
    assert.equal(deadline.escalatedAt, null);

    // Envelhece o primeiro alerta para 25h atrás — o prazo continua vencido e sem tratativa.
    await LegalDeadline.update(
      { firstOverdueAlertedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      { where: { id: deadline.id }, transaction }
    );

    const secondRun = await processDeadlinesInTransaction(transaction);
    assert.equal(secondRun.escalated, 1, 'segunda rodada escala o prazo ignorado');

    await deadline.reload({ transaction });
    assert.ok(deadline.escalatedAt, 'escalated_at marcado');

    const escalationNotifications = await Notification.findAll({
      where: { userId: tenant.userId, title: 'ESCALONAMENTO — prazo jurídico vencido sem tratativa' },
      transaction,
    });
    assert.ok(escalationNotifications.length >= 1, 'notificação extra criada para o alvo de escalonamento');
    const notificationsAfter = await Notification.count({ where: { userId: tenant.userId }, transaction });
    assert.ok(notificationsAfter > notificationsBefore);

    // Idempotência: uma terceira rodada não escala de novo o mesmo prazo.
    const thirdRun = await processDeadlinesInTransaction(transaction);
    assert.equal(thirdRun.escalated, 0);
  });
});

// ---------------------------------------------------------------------------
// M5-28 / M5-29 — Cadeia de custódia + export verificável do dossiê de provas
// ---------------------------------------------------------------------------

async function createEvidencePackageForTest(transaction) {
  const suffix = uniqueSuffix();
  const legalCase = await legalCasesService.createLegalCase(
    { groupId: tenant.groupId, companyId: tenant.companyId, caseType: 'LITIGATION', summary: `Dossiê ${suffix}` },
    tenant.userId,
    transaction
  );
  return evidencePackagesService.createEvidencePackage(
    legalCase.id,
    [
      { type: 'CONTRACT', description: `Contrato assinado ${suffix}`, referenceId: null, hash: 'abc123' },
      { type: 'INSPECTION', description: `Vistoria de saída ${suffix}`, referenceId: null, hash: 'def456' },
    ],
    tenant.userId,
    transaction
  );
}

test('M5-28: cada acesso ao dossiê grava uma linha nova na cadeia de custódia (histórico nunca sobrescrito)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const pkg = await createEvidencePackageForTest(transaction);

    let log = await evidencePackagesService.listEvidenceAccessLog(pkg.id, transaction);
    assert.equal(log.length, 0, 'criar o dossiê não é um acesso');

    await evidencePackagesService.viewEvidencePackage(pkg.id, tenant.userId, transaction);
    await evidencePackagesService.viewEvidencePackage(pkg.id, tenant.userId, transaction);
    await evidencePackagesService.exportEvidencePackage(pkg.id, tenant.userId, transaction);

    log = await evidencePackagesService.listEvidenceAccessLog(pkg.id, transaction);
    assert.equal(log.length, 3, 'três acessos = três linhas, nada deduplicado');
    assert.deepEqual(log.map((l) => l.action), ['VIEWED', 'VIEWED', 'EXPORTED']);
    for (const entry of log) {
      assert.equal(entry.accessedByUserId, tenant.userId);
      assert.ok(entry.accessedAt);
    }

    // getEvidencePackage (leitura interna) NÃO polui a cadeia de custódia — decisão documentada.
    await evidencePackagesService.getEvidencePackage(pkg.id, transaction);
    log = await evidencePackagesService.listEvidenceAccessLog(pkg.id, transaction);
    assert.equal(log.length, 3);
  });
});

test('M5-29: export do dossiê é verificável e a adulteração de qualquer campo é detectada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const pkg = await createEvidencePackageForTest(transaction);
    const exported = await evidencePackagesService.exportEvidencePackage(pkg.id, tenant.userId, transaction);

    assert.equal(exported.evidencePackageId, pkg.id);
    assert.equal(exported.itemCount, 2);
    assert.equal(exported.packageHash, pkg.packageHash);
    assert.equal(exported.manifest.length, 2);

    // Export íntegro: hash recalculado bate com o gravado no banco.
    const ok = evidencePackagesService.verifyEvidencePackageIntegrity(exported, pkg.packageHash);
    assert.equal(ok.valid, true);
    assert.equal(ok.recomputedHash, pkg.packageHash);

    // Simula adulteração no arquivo exportado (round-trip por JSON, como um arquivo real).
    const tampered = JSON.parse(JSON.stringify(exported));
    tampered.manifest[0].description = 'Contrato ADULTERADO';
    const tamperedResult = evidencePackagesService.verifyEvidencePackageIntegrity(tampered, pkg.packageHash);
    assert.equal(tamperedResult.valid, false, 'adulteração detectada: hash recalculado não bate mais');
    assert.notEqual(tamperedResult.recomputedHash, pkg.packageHash);

    // Adulterar o hash junto com o conteúdo engana a autoverificação, mas NÃO a comparação
    // com o hash persistido no banco (por isso expectedHash existe).
    tampered.packageHash = evidencePackagesService.computePackageHash(tampered.manifest);
    assert.equal(evidencePackagesService.verifyEvidencePackageIntegrity(tampered).valid, true);
    assert.equal(evidencePackagesService.verifyEvidencePackageIntegrity(tampered, pkg.packageHash).valid, false);
  });
});

// ---------------------------------------------------------------------------
// M5-21 — Responsabilidade pelo dano na vistoria
// ---------------------------------------------------------------------------

test('M5-21: item DAMAGED exige responsibleParty válido', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: `Imóvel M5-21 ${suffix}`,
        internalCode: `M521-${suffix}`,
        propertyType: 'RESIDENTIAL',
      },
      tenant.userId,
      transaction
    );
    const inspection = await inspectionsService.createInspection(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        inspectionType: 'CHECK_OUT',
        inspectorUserId: tenant.userId,
        scheduledAt: new Date(),
      },
      tenant.userId,
      transaction
    );

    // Sem responsibleParty: rejeitado.
    await assert.rejects(
      () =>
        inspectionsService.addInspectionItem(
          inspection.id,
          { itemName: `Porta ${suffix}`, condition: 'DAMAGED', damageDescription: 'Fechadura quebrada', estimatedBudget: 320 },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'LEGAL_INSPECTION_ITEM_VALIDATION');
        assert.match(err.message, /responsibleParty/);
        return true;
      }
    );

    // Com valor fora do domínio: também rejeitado.
    await assert.rejects(
      () =>
        inspectionsService.addInspectionItem(
          inspection.id,
          {
            itemName: `Porta ${suffix}`,
            condition: 'DAMAGED',
            damageDescription: 'Fechadura quebrada',
            estimatedBudget: 320,
            responsibleParty: 'SINDICO',
          },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.equal(err.code, 'LEGAL_INSPECTION_ITEM_VALIDATION');
        return true;
      }
    );

    // Com responsável válido: funciona e persiste.
    const item = await inspectionsService.addInspectionItem(
      inspection.id,
      {
        itemName: `Porta ${suffix}`,
        condition: 'DAMAGED',
        damageDescription: 'Fechadura quebrada',
        estimatedBudget: 320,
        responsibleParty: 'TENANT',
      },
      tenant.userId,
      transaction
    );
    assert.equal(item.responsibleParty, 'TENANT');

    // Item não danificado continua sem exigir responsável.
    const okItem = await inspectionsService.addInspectionItem(
      inspection.id,
      { itemName: `Janela ${suffix}`, condition: 'GOOD' },
      tenant.userId,
      transaction
    );
    assert.equal(okItem.responsibleParty, null);
  });
});
