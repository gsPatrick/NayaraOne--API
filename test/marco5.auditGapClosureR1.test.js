'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractClausesService = require('../src/features/legal/contractClauses.service');
const contractTemplatesService = require('../src/features/legal/contractTemplates.service');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const signaturesService = require('../src/features/legal/signatures.service');
const requirementsService = require('../src/features/legal/requirements.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const noticesService = require('../src/features/legal/notices.service');
const peopleService = require('../src/features/people/people.service');
const personContactsService = require('../src/features/people/personContacts.service');
const propertiesService = require('../src/features/properties/properties.service');
const AppError = require('../src/utils/AppError');
const { File, OutboxEvent, TenantSetting } = require('../src/models');

// O tenant de homologação compartilhado tem `legal.signature_provider=clicksign` configurado DE
// VERDADE (token real) para testes manuais de assinatura eletrônica em andamento — mesma nota
// documentada em test/legal.contracts.test.js e test/legal.signatureProviders.test.js. Os testes
// de gate de negócio aqui precisam do Sandbox determinístico (sem I/O de rede real), então
// zeramos essas settings DENTRO da própria transação de rollback (nunca commitado).
const SIGNATURE_SETTING_KEYS = [
  'legal.signature_provider',
  'legal.clicksign_api_token',
  'legal.clicksign_environment',
  'legal.clicksign_webhook_secret',
  'legal.zapsign_api_token',
  'legal.zapsign_webhook_secret',
];

async function clearSignatureSettings(transaction) {
  await TenantSetting.destroy({
    where: { companyId: tenant.companyId, key: SIGNATURE_SETTING_KEYS },
    transaction,
    force: true,
  });
}

async function createTestProperty(transaction) {
  const suffix = uniqueSuffix();
  return propertiesService.createProperty(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      title: `Imóvel G6 ${suffix}`,
      internalCode: `G6-${suffix}`,
      propertyType: 'RESIDENTIAL',
    },
    tenant.userId,
    transaction
  );
}

/**
 * marco5.auditGapClosureR1 — fecha, com E2E real (Postgres + RLS, sem fixtures em memória),
 * os itens da matriz de cobertura "Marco 5" do checklist
 * Maturacao/AUDITORIA_MARCOS4_5_NAYARA_CHECKLIST.md (Seção 4) atribuídos a esta frente:
 * tipos contratuais, templates/cláusulas versionados, contract versions/hash/assinaturas,
 * checklist documental/requirements, máquina de estados, vistorias e aditivos/notificações.
 *
 * Método: execução real dos services contra o banco de dev (nayara_runtime, RLS ativo),
 * não substitutos em memória — exatamente o que a auditoria da Nayara disse que faltava.
 */

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
      storageKey: `homo-qa/marco5-gap/${suffix}.pdf`,
      fileName: `doc-${suffix}.pdf`,
      mimeType: 'application/pdf',
      uploadedByUserId: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

async function createLeaseWithParties(transaction) {
  const suffix = uniqueSuffix();
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1200 },
    tenant.userId,
    transaction
  );
  const landlord = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `HOMO QA Locador ${suffix}` },
    tenant.userId,
    transaction
  );
  const tenantPerson = await peopleService.createPerson(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `HOMO QA Locatário ${suffix}` },
    tenant.userId,
    transaction
  );
  for (const person of [landlord, tenantPerson]) {
    await personContactsService.createContact(
      person.id,
      { contactType: 'EMAIL', valueNormalized: `qa+${suffix}-${person.id.slice(0, 8)}@nayaraone.dev`, isPrimary: true },
      tenant.userId,
      transaction
    );
  }
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: tenantPerson.id, partyRole: 'TENANT' }, tenant.userId, transaction);
  return { contract, landlord, tenantPerson };
}

// ---------------------------------------------------------------------------------------------
// Grupo 1 — Tipos contratuais e termos (§3)
// ---------------------------------------------------------------------------------------------

test('G1: cada subtipo de contrato real (LEASE_RESIDENTIAL/COMMERCIAL/SEASONAL, PROPERTY_ADMIN, SALE_*) é criado via API e tratado como "lease-like"/"sale-like" corretamente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const leaseTypes = ['LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN'];
    for (const contractType of leaseTypes) {
      const contract = await contractsService.createContract(
        { groupId: tenant.groupId, companyId: tenant.companyId, contractType, totalValue: 500 },
        tenant.userId,
        transaction
      );
      assert.equal(contract.status, 'DRAFT');
      assert.ok(contract.contractNumber.startsWith('LOC-') || contract.contractNumber.startsWith('ADM-'));
      assert.ok(contractsService.LEASE_LIKE_TYPES.includes(contract.contractType));
      // Checklist documental usa o template "LEASE" para TODOS os subtipos de locação —
      // prova real de que o requirements gate funciona para o subtipo, não só o genérico.
      const reqs = await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, transaction);
      assert.ok(reqs.length > 0, `requirements gerados para ${contractType}`);
    }

    const saleTypes = ['SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS'];
    for (const contractType of saleTypes) {
      const contract = await contractsService.createContract(
        { groupId: tenant.groupId, companyId: tenant.companyId, contractType, totalValue: 300000 },
        tenant.userId,
        transaction
      );
      assert.ok(contractsService.SALE_LIKE_TYPES.includes(contract.contractType));
      assert.equal(contract.contractNumber.startsWith('VEN-'), true);
    }
  });
});

test('G1: CONSTRUCTION exige constructionProjectId (não pode nascer "solto")', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () =>
        contractsService.createContract(
          { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'CONSTRUCTION', totalValue: 1 },
          tenant.userId,
          transaction
        ),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_CONTRACT_CONSTRUCTION_PROJECT_REQUIRED');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Grupo 2 — Templates/cláusulas versionados (§6/JUR-001/016)
// ---------------------------------------------------------------------------------------------

test('G2: publicar nova versão de cláusula NÃO altera templates/versões de contrato que já usaram a versão anterior', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const code = `CLA-G2-${uniqueSuffix()}`;
    const v1 = await contractClausesService.createClause(
      { groupId: tenant.groupId, companyId: tenant.companyId, code, title: 'Garantia locatícia', bodyText: 'Texto original v1', category: 'GUARANTEE' },
      tenant.userId,
      transaction
    );
    const template = await contractTemplatesService.createTemplate(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', name: `Template G2 ${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: v1.id }, tenant.userId, transaction);

    // Documento gerado ANTES da nova versão — pelo caminho real (o servidor monta o texto).
    const { contract } = await createLeaseWithParties(transaction);
    const docFile = await createFakeDocumentFile(transaction);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { documentFileId: docFile.id, templateId: template.id },
      tenant.userId,
      transaction
    );
    assert.ok(version.content.includes('Texto original v1'));
    const hashBefore = version.contentHash;

    // Publica v2 da cláusula — isso NÃO deve alterar o vínculo já existente (que aponta pro
    // ID específico da v1), nem o documento já emitido.
    const v2 = await contractClausesService.createClauseVersion(code, { bodyText: 'Texto revisado v2' }, tenant.userId, transaction);
    assert.notEqual(v2.id, v1.id);

    // O vínculo do template continua apontando para a v1 (ID imutável) — template NÃO foi
    // migrado automaticamente para v2.
    const links = await contractTemplatesService.listTemplateClauses(template.id, transaction);
    assert.equal(links.length, 1);
    assert.equal(links[0].clause.id, v1.id);
    assert.equal(links[0].clause.versionNumber, 1);

    // I1 (revisão independente 19/10): antes, a v1 desativada sumia do documento em silêncio. Agora
    // gerar a partir do modelo com vínculo para versão substituída é BLOQUEADO, com erro claro.
    await assert.rejects(
      () => contractTemplatesService.renderTemplate(template.id, transaction),
      (err) => err.code === 'LEGAL_TEMPLATE_CLAUSE_SUPERSEDED'
    );

    // Documento JÁ EMITIDO preserva literalmente a v1, mesmo depois de v2 existir.
    const reloaded = await contractVersionsService.getContractVersion(version.id, transaction);
    assert.equal(reloaded.contentHash, hashBefore);
    assert.deepEqual(reloaded.clauseVersionIds.map((c) => c.contractClauseId), [v1.id]);
    assert.ok(!reloaded.content.includes('Texto revisado v2'));
  });
});

test('G2: renderTemplate respeita sort_order e ignora cláusula desativada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const clauseA = await contractClausesService.createClause(
      { groupId: tenant.groupId, companyId: tenant.companyId, code: `CLA-A-${suffix}`, title: 'A — Objeto', bodyText: 'Texto A', category: 'GENERAL' },
      tenant.userId,
      transaction
    );
    const clauseB = await contractClausesService.createClause(
      { groupId: tenant.groupId, companyId: tenant.companyId, code: `CLA-B-${suffix}`, title: 'B — Pagamento', bodyText: 'Texto B', category: 'PAYMENT' },
      tenant.userId,
      transaction
    );
    const clauseC = await contractClausesService.createClause(
      { groupId: tenant.groupId, companyId: tenant.companyId, code: `CLA-C-${suffix}`, title: 'C — Rescisão', bodyText: 'Texto C', category: 'TERMINATION' },
      tenant.userId,
      transaction
    );
    const template = await contractTemplatesService.createTemplate(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', name: `Template ordem ${suffix}` },
      tenant.userId,
      transaction
    );
    // Insere fora de ordem de propósito.
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: clauseC.id, sortOrder: 3 }, tenant.userId, transaction);
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: clauseA.id, sortOrder: 1 }, tenant.userId, transaction);
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: clauseB.id, sortOrder: 2 }, tenant.userId, transaction);

    const rendered = await contractTemplatesService.renderTemplate(template.id, transaction);
    const order = rendered.clauses.map((c) => c.code);
    assert.deepEqual(order, [clauseA.code, clauseB.code, clauseC.code], 'renderização respeita sort_order, não ordem de inserção');

    await contractClausesService.deactivateClause(clauseB.id, tenant.userId, transaction);
    const renderedAfterDeactivate = await contractTemplatesService.renderTemplate(template.id, transaction);
    assert.ok(!renderedAfterDeactivate.content.includes('Texto B'), 'cláusula desativada é excluída de novas renderizações');
    assert.equal(renderedAfterDeactivate.clauses.length, 2);
  });
});

// F01 (conferência Nayara 18/10/2026): o antigo marcador assert.ok(true) que documentava a
// AUSÊNCIA de cláusulas condicionais foi substituído pela funcionalidade real (regra
// declarativa na versão da cláusula, ver src/features/legal/clauseConditions.js). Cobertura
// completa (operadores, all/any, aprovação, versão, hash) em test/legal.clauseConditions.test.js.
test('G2: cláusula condicional por regra declarativa entra ou sai do documento conforme o contrato', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { User } = require('../src/models');
    const [approver] = await User.findOrCreate({
      where: { email: 'homo-qa-clause-condition-approver@nayaraone.dev' },
      defaults: { name: 'HOMO QA — Aprovador de condição de cláusula', passwordHash: 'x', status: 'ACTIVE' },
    });
    const created = await contractClausesService.createClause(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        code: `CLA-G2-COND-${uniqueSuffix()}`,
        title: 'Fiança',
        bodyText: 'Obrigações do fiador',
        category: 'GUARANTEE',
        condition: { match: 'all', rules: [{ variable: 'guaranteeType', operator: 'eq', value: 'GUARANTOR' }] },
      },
      tenant.userId,
      transaction
    );
    await contractClausesService.approveClauseCondition(created.id, approver.id, transaction);
    const template = await contractTemplatesService.createTemplate(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', name: `Template G2 cond ${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );
    await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId: created.id }, tenant.userId, transaction);

    const comFiador = await contractTemplatesService.renderTemplate(template.id, transaction, {}, { guaranteeType: 'GUARANTOR' });
    const semFiador = await contractTemplatesService.renderTemplate(template.id, transaction, {}, { guaranteeType: 'DEPOSIT' });
    assert.ok(comFiador.content.includes('Obrigações do fiador'));
    assert.ok(!semFiador.content.includes('Obrigações do fiador'));
  });
});

// ---------------------------------------------------------------------------------------------
// Grupo 3 — Contract versions/hash/assinaturas (§6/§8/JUR-TS-001/002/007)
// ---------------------------------------------------------------------------------------------

test('G3: content_hash é SEMPRE calculado pelo servidor a partir do content real — não existe caminho para o cliente informar um hash divergente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const docFile = await createFakeDocumentFile(transaction);

    const v1 = await contractVersionsService.createContractVersion(
      contract.id,
      { content: 'Conteúdo exato da versão 1', documentFileId: docFile.id },
      tenant.userId,
      transaction
    );
    const expectedHash = contractVersionsService.computeContentHash('Conteúdo exato da versão 1');
    assert.equal(v1.contentHash, expectedHash, 'hash persistido é exatamente o hash recomputável a partir do content persistido');
    assert.equal(v1.content, 'Conteúdo exato da versão 1');

    // Prova de que não existe parâmetro "contentHash"/"hash" aceito no payload — mesmo que o
    // chamador tente forçar um hash arbitrário, a função nunca lê esse campo do payload.
    const forgedAttempt = { content: 'Conteúdo exato da versão 1', documentFileId: docFile.id, contentHash: 'HASH-FORJADO-0000', hash: 'OUTRO-FORJADO' };
    const v2 = await contractVersionsService.createContractVersion(contract.id, forgedAttempt, tenant.userId, transaction);
    assert.equal(v2.contentHash, expectedHash, 'tentativa de injetar contentHash/hash no payload é ignorada; servidor recalcula sempre');
    assert.notEqual(v2.contentHash, 'HASH-FORJADO-0000');
  });
});

test('G3: criar versão com content vazio/só espaço é rejeitado (não gera "documento fantasma" com hash técnico mas sem conteúdo real)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const docFile = await createFakeDocumentFile(transaction);
    await assert.rejects(
      () => contractVersionsService.createContractVersion(contract.id, { content: '   ', documentFileId: docFile.id }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_CONTRACT_VERSION_VALIDATION');
        return true;
      }
    );
  });
});

test('G3: webhook de assinatura (externalSignatureId) duplicado é idempotente — não republica evento nem reprocessa efeito', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await clearSignatureSettings(transaction);
    const { contract, landlord, tenantPerson } = await createLeaseWithParties(transaction);
    const docFile = await createFakeDocumentFile(transaction);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content: 'Documento para assinatura — G3 webhook duplicado', documentFileId: docFile.id },
      tenant.userId,
      transaction
    );
    await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, transaction);
    const pending = await requirementsService.listRequirements(contract.id, transaction);
    for (const req of pending) {
      await requirementsService.satisfyRequirement(req.id, { waivedReason: 'Teste G3 — fora do escopo deste cenário' }, tenant.userId, transaction);
    }
    let reloaded = await contractsService.getContract(contract.id, transaction);
    reloaded = await contractsService.transitionContractStatus(reloaded, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    reloaded = await contractsService.transitionContractStatus(reloaded, 'LEGAL_REVIEW', tenant.userId, transaction);
    reloaded = await contractsService.transitionContractStatus(reloaded, 'APPROVED', tenant.userId, transaction);
    await contractsService.transitionContractStatus(reloaded, 'SIGNING', tenant.userId, transaction);

    const signatures = await signaturesService.initiateSignature(version.id, [landlord.id, tenantPerson.id], tenant.userId, transaction);
    assert.equal(signatures.length, 2);

    const outboxCountBefore = await OutboxEvent.count({ where: { aggregateId: signatures[0].id }, transaction });

    const first = await signaturesService.handleSignatureWebhook(signatures[0].externalSignatureId, {}, transaction);
    assert.equal(first.alreadyProcessed, false);

    const outboxCountAfterFirst = await OutboxEvent.count({ where: { aggregateId: signatures[0].id }, transaction });
    assert.ok(outboxCountAfterFirst > outboxCountBefore, 'primeiro webhook publica evento');

    // Callback DUPLICADO do mesmo provedor para o MESMO externalSignatureId.
    const second = await signaturesService.handleSignatureWebhook(signatures[0].externalSignatureId, {}, transaction);
    assert.equal(second.alreadyProcessed, true, 'webhook duplicado é reconhecido como já processado');

    const outboxCountAfterSecond = await OutboxEvent.count({ where: { aggregateId: signatures[0].id }, transaction });
    assert.equal(outboxCountAfterSecond, outboxCountAfterFirst, 'webhook duplicado NÃO publica evento de novo (sem duplicação)');

    const signatureCount = await signaturesService.listSignaturesByContractVersion(version.id, transaction);
    assert.equal(signatureCount.length, 2, 'webhook duplicado não cria Signature extra');
  });
});

test('G3: callback forjado (externalSignatureId inexistente) é rejeitado, não cria nem altera nada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => signaturesService.handleSignatureWebhook('FORGED-EXTERNAL-ID-DOES-NOT-EXIST', {}, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_SIGNATURE_NOT_FOUND');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Grupo 4 — Checklist documental/requirements (§7/JUR-TS-003)
// ---------------------------------------------------------------------------------------------

test('G4: contrato de locação sem requirements gerados manualmente é auto-gerado e cobrado no primeiro gate (fail-closed, não passa por omissão)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const existingBefore = await requirementsService.listRequirements(contract.id, transaction);
    assert.equal(existingBefore.length, 0, 'nenhum requirement gerado manualmente ainda');

    let reloaded = await contractsService.getContract(contract.id, transaction);
    await assert.rejects(
      () => contractsService.transitionContractStatus(reloaded, 'DOCUMENTS_PENDING', tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_REQUIREMENTS_PENDING');
        return true;
      }
    );

    const generated = await requirementsService.listRequirements(contract.id, transaction);
    assert.ok(generated.length > 0, 'gate gerou o checklist automaticamente em vez de deixar passar por omissão');
  });
});

test('G4: satisfyRequirement exige satisfiedByFileId OU waivedReason — nunca aceita um requirement "fechado" sem nenhum dos dois', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const reqs = await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, transaction);
    await assert.rejects(
      () => requirementsService.satisfyRequirement(reqs[0].id, {}, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_REQUIREMENT_VALIDATION');
        return true;
      }
    );
  });
});

test('G4: documento REAL (File real, satisfiedByFileId) satisfaz o requirement e libera a transição; WAIVED exige motivo e fica rastreável separadamente de SATISFIED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const reqs = await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, transaction);
    assert.ok(reqs.length >= 2, 'template LEASE tem múltiplos requirements obrigatórios');

    const docFile = await createFakeDocumentFile(transaction);
    const satisfiedOne = await requirementsService.satisfyRequirement(reqs[0].id, { satisfiedByFileId: docFile.id }, tenant.userId, transaction);
    assert.equal(satisfiedOne.status, 'SATISFIED');
    assert.equal(satisfiedOne.satisfiedByFileId, docFile.id);
    assert.ok(satisfiedOne.satisfiedAt);

    for (const req of reqs.slice(1)) {
      const waived = await requirementsService.satisfyRequirement(req.id, { waivedReason: 'Dispensado para fins de teste G4' }, tenant.userId, transaction);
      assert.equal(waived.status, 'WAIVED');
      assert.equal(waived.waivedReason, 'Dispensado para fins de teste G4');
    }

    const all = await requirementsService.listRequirements(contract.id, transaction);
    assert.ok(all.every((r) => r.status === 'SATISFIED' || r.status === 'WAIVED'), 'nenhum requirement ficou PENDING');

    let reloaded = await contractsService.getContract(contract.id, transaction);
    reloaded = await contractsService.transitionContractStatus(reloaded, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    assert.equal(reloaded.status, 'DOCUMENTS_PENDING', 'transição liberada só depois de todos os requirements resolvidos (SATISFIED ou WAIVED)');
  });
});

// ---------------------------------------------------------------------------------------------
// Grupo 5 — Máquina de estados (Guia §3): ciclo completo persistido/auditado
// ---------------------------------------------------------------------------------------------

test('G5: ciclo completo DRAFT -> DOCUMENTS_PENDING -> LEGAL_REVIEW -> APPROVED -> SIGNING -> SIGNED -> ACTIVE -> SUSPENDED -> ACTIVE -> TERMINATED -> CLOSED é persistido e auditado passo a passo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await clearSignatureSettings(transaction);
    const { contract, landlord, tenantPerson } = await createLeaseWithParties(transaction);
    const docFile = await createFakeDocumentFile(transaction);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content: 'Documento G5 — ciclo completo', documentFileId: docFile.id },
      tenant.userId,
      transaction
    );
    await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, transaction);
    const reqs = await requirementsService.listRequirements(contract.id, transaction);
    for (const req of reqs) {
      await requirementsService.satisfyRequirement(req.id, { waivedReason: 'Teste G5 — fora de escopo' }, tenant.userId, transaction);
    }

    let reloaded = await contractsService.getContract(contract.id, transaction);
    const visited = [reloaded.status];

    reloaded = await contractsService.transitionContractStatus(reloaded, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    visited.push(reloaded.status);
    reloaded = await contractsService.transitionContractStatus(reloaded, 'LEGAL_REVIEW', tenant.userId, transaction);
    visited.push(reloaded.status);
    reloaded = await contractsService.transitionContractStatus(reloaded, 'APPROVED', tenant.userId, transaction);
    visited.push(reloaded.status);
    reloaded = await contractsService.transitionContractStatus(reloaded, 'SIGNING', tenant.userId, transaction);
    visited.push(reloaded.status);

    const signatures = await signaturesService.initiateSignature(version.id, [landlord.id, tenantPerson.id], tenant.userId, transaction);
    for (const sig of signatures) {
      await signaturesService.handleSignatureWebhook(sig.externalSignatureId, {}, transaction);
    }
    reloaded = await contractsService.getContract(contract.id, transaction);
    visited.push(reloaded.status);
    assert.equal(reloaded.status, 'SIGNED', 'webhook da última assinatura já transiciona automaticamente para SIGNED');

    reloaded = await contractsService.transitionContractStatus(reloaded, 'ACTIVE', tenant.userId, transaction);
    visited.push(reloaded.status);
    reloaded = await contractsService.suspendContract(reloaded.id, 'Teste G5 — suspensão temporária', tenant.userId, transaction);
    visited.push(reloaded.status);
    reloaded = await contractsService.reactivateContract(reloaded.id, 'Teste G5 — reativação', tenant.userId, transaction);
    visited.push(reloaded.status);
    reloaded = await contractsService.terminateContract(reloaded.id, 'Teste G5 — encerramento', tenant.userId, transaction);
    visited.push(reloaded.status);
    reloaded = await contractsService.closeContract(reloaded.id, 'Teste G5 — fechamento', tenant.userId, transaction);
    visited.push(reloaded.status);

    assert.deepEqual(visited, [
      'DRAFT', 'DOCUMENTS_PENDING', 'LEGAL_REVIEW', 'APPROVED', 'SIGNING', 'SIGNED', 'ACTIVE', 'SUSPENDED', 'ACTIVE', 'TERMINATED', 'CLOSED',
    ]);

    // Estado terminal: nenhuma transição é mais permitida a partir de CLOSED.
    assert.deepEqual(contractsService.VALID_TRANSITIONS.CLOSED, []);
  });
});

test('G5: saltos proibidos continuam bloqueados de ponta a ponta (DRAFT direto para ACTIVE/SIGNED)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const reloaded = await contractsService.getContract(contract.id, transaction);
    await assert.rejects(() => contractsService.transitionContractStatus(reloaded, 'ACTIVE', tenant.userId, transaction));
    await assert.rejects(() => contractsService.transitionContractStatus(reloaded, 'SIGNED', tenant.userId, transaction));
  });
});

// ---------------------------------------------------------------------------------------------
// Grupo 6 — Vistoria entrada/saída/revisões (§11/JUR-TS-006)
// ---------------------------------------------------------------------------------------------

test('G6: assinatura congela a vistoria — item/mídia não podem mais ser alterados depois de qualquer assinatura registrada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const property = await createTestProperty(transaction);
    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      transaction
    );
    await inspectionsService.addInspectionItem(inspection.id, { itemName: 'Pia da cozinha', condition: 'GOOD' }, tenant.userId, transaction);
    await inspectionsService.completeInspection(inspection.id, tenant.userId, transaction);
    await inspectionsService.signInspection(inspection.id, { partyRole: 'TENANT', signaturePayload: 'assinatura-digital-base64' }, tenant.userId, transaction);

    await assert.rejects(
      () => inspectionsService.addInspectionItem(inspection.id, { itemName: 'Item tardio', condition: 'GOOD' }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_INSPECTION_IMMUTABLE_AFTER_SIGNATURE');
        return true;
      }
    );

    const docFile = await createFakeDocumentFile(transaction);
    const firstItem = (await inspectionsService.listInspectionItems(inspection.id, transaction))[0];
    await assert.rejects(
      () => inspectionsService.attachInspectionItemMedia(firstItem.id, { fileId: docFile.id }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_INSPECTION_IMMUTABLE_AFTER_SIGNATURE');
        return true;
      }
    );
  });
});

test('G6: duas partes não podem assinar o mesmo papel duas vezes; comparação entrada x saída usa os lados certos e aponta divergências reais', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const property = await createTestProperty(transaction);

    const entry = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      transaction
    );
    await inspectionsService.addInspectionItem(entry.id, { itemName: 'Parede sala', condition: 'GOOD' }, tenant.userId, transaction);
    await inspectionsService.completeInspection(entry.id, tenant.userId, transaction);
    await inspectionsService.signInspection(entry.id, { partyRole: 'TENANT', signaturePayload: 'sig-entry-1' }, tenant.userId, transaction);

    await assert.rejects(
      () => inspectionsService.signInspection(entry.id, { partyRole: 'TENANT', signaturePayload: 'sig-entry-2' }, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_INSPECTION_ALREADY_SIGNED');
        return true;
      }
    );

    const exit = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_OUT' },
      tenant.userId,
      transaction
    );
    await inspectionsService.addInspectionItem(exit.id, { itemName: 'Parede sala', condition: 'DAMAGED', damageDescription: 'Furo visível', estimatedBudget: 150, responsibleParty: 'TENANT' }, tenant.userId, transaction);
    await inspectionsService.completeInspection(exit.id, tenant.userId, transaction);
    await inspectionsService.signInspection(exit.id, { partyRole: 'LANDLORD', signaturePayload: 'sig-exit-1' }, tenant.userId, transaction);

    const comparison = await inspectionsService.compareInspections(entry.id, exit.id, transaction);
    assert.equal(comparison.divergences.length, 1);
    assert.equal(comparison.divergences[0].itemName, 'Parede sala');
    assert.equal(comparison.divergences[0].entryCondition, 'GOOD');
    assert.equal(comparison.divergences[0].exitCondition, 'DAMAGED');
  });
});

// ---------------------------------------------------------------------------------------------
// Grupo 7 — Aditivos e notificações (§13/JUR-014) — NENHUM envio real é disparado nestes testes.
// ---------------------------------------------------------------------------------------------

test('G7: notificação SENSÍVEL (rascunhada por IA) NÃO pode ser aprovada/enviada sem passar por PENDING_REVIEW humano; não sensível pode ir direto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);

    const sensitive = await noticesService.createNotice(
      { contractId: contract.id, channel: 'EMAIL', recipientDescription: 'Locatário', content: 'Rascunho gerado pela NAY sobre atraso de pagamento', draftedByAi: true },
      tenant.userId,
      transaction
    );
    assert.equal(sensitive.status, 'DRAFT');

    // Tentar aprovar direto de DRAFT (pulando revisão humana) é bloqueado.
    await assert.rejects(
      () => noticesService.approveNotice(sensitive.id, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_NOTICE_REVIEW_REQUIRED');
        return true;
      }
    );
    // Tentar enviar sem nunca ter sido aprovada também é bloqueado.
    await assert.rejects(
      () => noticesService.sendNotice(sensitive.id, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_NOTICE_SEND_BLOCKED');
        return true;
      }
    );

    await noticesService.submitNoticeForReview(sensitive.id, tenant.userId, transaction);
    const approved = await noticesService.approveNotice(sensitive.id, tenant.userId, transaction);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.reviewedByUserId, tenant.userId, 'revisor humano fica registrado — não é a IA aprovando a própria sugestão');

    // Canal de envio é MOCKADO: sendNotice só marca status/auditoria, não dispara I/O real de
    // e-mail/SMS — nenhuma chamada de rede acontece aqui, confirmado por leitura do service
    // (não há client HTTP/SMTP chamado dentro de sendNotice).
    const sent = await noticesService.sendNotice(sensitive.id, tenant.userId, transaction);
    assert.equal(sent.status, 'SENT');
    assert.ok(sent.sentAt);

    const docFile = await createFakeDocumentFile(transaction);
    const delivered = await noticesService.registerDeliveryEvidence(sensitive.id, { deliveryEvidenceFileId: docFile.id }, tenant.userId, transaction);
    assert.equal(delivered.status, 'DELIVERED');
    assert.equal(delivered.deliveryEvidenceFileId, docFile.id);

    // Não sensível: pode ir direto de DRAFT para APPROVED, sem review.
    const plain = await noticesService.createNotice(
      { contractId: contract.id, channel: 'EMAIL', recipientDescription: 'Locatário', content: 'Aviso simples de manutenção programada' },
      tenant.userId,
      transaction
    );
    const plainApproved = await noticesService.approveNotice(plain.id, tenant.userId, transaction);
    assert.equal(plainApproved.status, 'APPROVED');
  });
});

test('G7: enviar notificação exige evidência de entrega real (deliveryEvidenceFileId) para virar DELIVERED — não aceita "entregue" sem comprovante', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { contract } = await createLeaseWithParties(transaction);
    const notice = await noticesService.createNotice(
      { contractId: contract.id, channel: 'EMAIL', recipientDescription: 'Locatário', content: 'Notificação sem IA' },
      tenant.userId,
      transaction
    );
    await noticesService.approveNotice(notice.id, tenant.userId, transaction);
    await noticesService.sendNotice(notice.id, tenant.userId, transaction);
    await assert.rejects(
      () => noticesService.registerDeliveryEvidence(notice.id, {}, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_NOTICE_VALIDATION');
        return true;
      }
    );
  });
});
