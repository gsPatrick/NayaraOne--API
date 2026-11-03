'use strict';

/**
 * Fixtures controladas do drill de restore jurídico (F05, conferência Nayara 18/10/2026 —
 * revisado após a revisão independente do mesmo dia).
 *
 * Roda num processo filho com DATABASE_URL apontando para o banco de ORIGEM descartável do
 * drill (role de runtime, sem BYPASSRLS) e UPLOADS_DIR apontando para o storage de origem.
 * Tudo é criado pelos serviços reais da aplicação:
 *   - imóvel, pessoas (partes e signatários) com data de nascimento;
 *   - contrato com imóvel, início e fim de vigência, partes e garantia;
 *   - biblioteca de cláusulas: uma cláusula fixa e uma CONDICIONAL aprovada por outra pessoa;
 *     modelo LEASE com as duas; versão 1 gerada pelo SERVIDOR a partir do modelo (preenche
 *     template_id, clause_version_ids, condition_context e excluded_clauses);
 *   - checklist: um item satisfeito com arquivo real e os demais dispensados com motivo;
 *   - assinaturas das duas partes via adapter sandbox + webhook, e o fechamento do envelope
 *     gravando um DOCUMENTO ASSINADO com bytes próprios (ver nota abaixo);
 *   - vistoria com itens com observação, fotos, assinaturas e relatório PDF;
 *   - processo jurídico com responsável, escalonamento e legal hold; dossiê montado dos anexos;
 *   - pagamento bancário confirmado; segundo tenant (B) com contrato próprio.
 *
 * Nota sobre o documento assinado: o adapter sandbox de assinatura não tem provedor real e por
 * isso `downloadSignedDocument` devolve null. Neste processo (e só nele) o método é substituído
 * por um que devolve um PDF de bytes conhecidos — o resto do caminho é o handler real
 * `handleEnvelopeClosedWebhook` (grava o arquivo cifrado em contracts-signed, cria o File e
 * preenche signed_document_file_id), que é o que o restore precisa preservar.
 *
 * Cada arquivo gerado tem seu SHA-256 calculado AQUI, sobre os bytes originais, e gravado na
 * saída (`expectedFileSha256`) — a verificação compara o conteúdo restaurado com esse valor
 * independente, não só com o checksum que o próprio serviço de upload gravou.
 *
 * Proteção: recusa rodar fora de um banco local de drill (host 127.0.0.1/localhost e nome
 * começando com "drill_"), para nunca criar dados no banco compartilhado.
 *
 * Saída: JSON com os ids criados, gravado em --out.
 */

const fs = require('fs');
const crypto = require('crypto');
const { assertDrillDatabase } = require('./drillGuard');

assertDrillDatabase(process.env.DATABASE_URL, 'seedLegalFixtures');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) { out.out = argv[i + 1]; i += 1; }
  }
  return out;
}

const { sequelize, Group, Company, User } = require('../../src/models');
const guaranteesService = require('../../src/features/legal/guarantees.service');
const filesService = require('../../src/features/files/files.service');
const peopleService = require('../../src/features/people/people.service');
const propertiesService = require('../../src/features/properties/properties.service');
const contractsService = require('../../src/features/legal/contracts.service');
const contractVersionsService = require('../../src/features/legal/contractVersions.service');
const contractClausesService = require('../../src/features/legal/contractClauses.service');
const contractTemplatesService = require('../../src/features/legal/contractTemplates.service');
const requirementsService = require('../../src/features/legal/requirements.service');
const signaturesService = require('../../src/features/legal/signatures.service');
const inspectionsService = require('../../src/features/legal/inspections.service');
const legalCasesService = require('../../src/features/legal/legalCases.service');
const evidencePackagesService = require('../../src/features/legal/evidencePackages.service');
const { SandboxSignatureAdapter } = require('../../src/features/legal/adapters/SignatureAdapter');

const SIGNED_PDF = Buffer.from(
  `%PDF-1.4\n% Drill restore Nayara One — CONTRATO ASSINADO pelas duas partes\n${crypto.randomBytes(3072).toString('base64')}\n%%EOF\n`,
  'utf8'
);
SandboxSignatureAdapter.prototype.downloadSignedDocument = async function drillSignedDocument() {
  return { buffer: SIGNED_PDF, fileName: 'drill-contrato-assinado.pdf' };
};

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

async function inTenant(tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true)', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SELECT set_config(\'app.company_id\', :c, true)', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SELECT set_config(\'app.user_id\', :u, true)', { replacements: { u: tenant.userId }, transaction });
    return fn(transaction);
  });
}

// Conteúdo binário real e distinto por arquivo — cada arquivo precisa de conteúdo próprio e não
// trivial para a comparação de bytes depois do restore ter valor.
function pdfBytes(label) {
  return Buffer.from(`%PDF-1.4\n% Drill restore Nayara One — ${label}\n${crypto.randomBytes(2048).toString('base64')}\n%%EOF\n`, 'utf8');
}

function pngBytes(label) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.from(`drill:${label}:`), crypto.randomBytes(4096)]);
}

async function seedTenantA(tenant, approverId) {
  const ids = { files: [], expectedFileSha256: {}, persons: [], auditEntityIds: [] };
  async function upload(t, fileName, mimeType, bytes, category) {
    const file = await filesService.uploadFile(
      { groupId: tenant.groupId, companyId: tenant.companyId, fileName, mimeType, contentBase64: bytes.toString('base64'), category },
      tenant.userId,
      t
    );
    ids.files.push(file.id);
    ids.expectedFileSha256[file.id] = sha256(bytes);
    return file;
  }

  // Cláusulas e modelo. A cláusula condicional nasce PENDENTE e é aprovada por OUTRA pessoa
  // (o autor não aprova a própria condição).
  const clauseIds = await inTenant(tenant, async (t) => {
    const fixed = await contractClausesService.createClause(
      { groupId: tenant.groupId, companyId: tenant.companyId, code: `DRILL-PAGTO-${Date.now()}`, title: 'Pagamento do aluguel', bodyText: 'O aluguel vence todo dia 10.', category: 'PAYMENT' },
      tenant.userId,
      t
    );
    const conditional = await contractClausesService.createClause(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        code: `DRILL-RESID-${Date.now()}`,
        title: 'Uso residencial',
        bodyText: 'O imóvel destina-se exclusivamente a uso residencial.',
        category: 'GENERAL',
        condition: { match: 'all', rules: [{ variable: 'contractType', operator: 'eq', value: 'LEASE' }] },
      },
      tenant.userId,
      t
    );
    const excluded = await contractClausesService.createClause(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        code: `DRILL-VENDA-${Date.now()}`,
        title: 'Cláusula só de venda',
        bodyText: 'Esta cláusula só se aplica a contratos de venda.',
        category: 'GENERAL',
        condition: { match: 'all', rules: [{ variable: 'contractType', operator: 'eq', value: 'SALE' }] },
      },
      tenant.userId,
      t
    );
    return { fixed: fixed.id, conditional: conditional.id, excluded: excluded.id };
  });
  await inTenant({ ...tenant, userId: approverId }, async (t) => {
    await contractClausesService.approveClauseCondition(clauseIds.conditional, approverId, t);
    await contractClausesService.approveClauseCondition(clauseIds.excluded, approverId, t);
  });

  await inTenant(tenant, async (t) => {
    const template = await contractTemplatesService.createTemplate(
      { groupId: tenant.groupId, companyId: tenant.companyId, name: `DRILL Modelo de locação ${Date.now()}`, contractType: 'LEASE' },
      tenant.userId,
      t
    );
    ids.templateId = template.id;
    for (const contractClauseId of [clauseIds.fixed, clauseIds.conditional, clauseIds.excluded]) {
      await contractTemplatesService.addClauseToTemplate(template.id, { contractClauseId }, tenant.userId, t);
    }

    const property = await propertiesService.createProperty(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        title: 'DRILL Imovel Ficticio',
        internalCode: `DRILL-${Date.now()}`,
        propertyType: 'RESIDENTIAL',
        addressLine: 'Rua do Drill, 100',
        city: 'Ribeirão Preto',
        state: 'SP',
        zipCode: '14000000',
        description: 'Imóvel fictício do drill de restore',
        bedrooms: 2,
        parkingSpots: 1,
      },
      tenant.userId,
      t
    );
    ids.propertyId = property.id;

    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, contractType: 'LEASE', totalValue: 3500, startsAt: '2026-11-01', endsAt: '2027-10-31' },
      tenant.userId,
      t
    );
    ids.contractId = contract.id;

    const landlord = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: 'DRILL Locador Ficticio', birthOrFoundationDate: '1970-05-10' }, tenant.userId, t);
    const lessee = await peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: 'DRILL Locatario Ficticio', birthOrFoundationDate: '1988-09-21' }, tenant.userId, t);
    ids.persons.push(landlord.id, lessee.id);
    await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, t);
    await contractsService.addContractParty(contract.id, { personId: lessee.id, partyRole: 'TENANT' }, tenant.userId, t);

    // Checklist: o primeiro item é satisfeito com um arquivo real (entra no dossiê); os demais
    // são dispensados com motivo, para o contrato poder avançar até a assinatura.
    await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, t);
    const requirements = await requirementsService.listRequirements(contract.id, t);
    let satisfiedWithFile = false;
    ids.waivedRequirementIds = [];
    for (const requirement of requirements) {
      if (requirement.status !== 'PENDING') continue;
      if (!satisfiedWithFile) {
        const reqFile = await upload(t, 'drill-documento-checklist.pdf', 'application/pdf', pdfBytes('checklist'), 'contracts');
        await requirementsService.satisfyRequirement(requirement.id, { satisfiedByFileId: reqFile.id }, tenant.userId, t);
        ids.requirementWithFileId = requirement.id;
        satisfiedWithFile = true;
      } else {
        await requirementsService.satisfyRequirement(requirement.id, { waivedReason: 'Drill de restore — item fora do escopo do cenário' }, tenant.userId, t);
        ids.waivedRequirementIds.push(requirement.id);
      }
    }

    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, t);
    const versionFile = await upload(t, 'drill-contrato-v1.pdf', 'application/pdf', pdfBytes('contrato-v1'), 'contracts');
    // Versão gerada pelo SERVIDOR a partir do modelo: o texto, as cláusulas incluídas/excluídas
    // e o contexto da condição são calculados no serviço (o cliente só manda variáveis).
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { templateId: template.id, variables: {}, documentFileId: versionFile.id },
      tenant.userId,
      t
    );
    ids.contractVersionId = version.id;

    await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, t);
    await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, t);
    await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, t);

    const signatures = await signaturesService.initiateSignature(version.id, [landlord.id, lessee.id], tenant.userId, t);
    ids.signatureIds = signatures.map((s) => s.id);
    for (const signature of signatures) {
      await signaturesService.handleSignatureWebhook(signature.externalSignatureId, { signedAt: new Date('2026-10-18T13:00:00.000Z') }, t);
    }
    // Fechamento do envelope: grava o documento ASSINADO (bytes próprios) pelo handler real.
    const closed = await signaturesService.handleEnvelopeClosedWebhook(signatures[0].providerEnvelopeId, tenant, t);
    if (!closed.processed || !closed.fileId) throw new Error(`Documento assinado não gravado: ${JSON.stringify(closed)}`);
    ids.signedDocumentFileId = closed.fileId;
    ids.files.push(closed.fileId);
    ids.expectedFileSha256[closed.fileId] = sha256(SIGNED_PDF);

    // Garantia ativa (entra no contexto da condição e no encerramento).
    const guarantee = await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'INSURANCE', value: 10500, status: 'ACTIVE', startsAt: '2026-11-01', endsAt: '2027-10-31' },
      tenant.userId,
      t
    );
    ids.guaranteeId = guarantee.id;

    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      t
    );
    ids.inspectionId = inspection.id;
    ids.inspectionItemIds = [];
    for (const [itemName, notes] of [['Piso da sala', 'Piso de madeira sem riscos'], ['Parede da cozinha', 'Pintura nova, sem manchas']]) {
      const item = await inspectionsService.addInspectionItem(inspection.id, { itemName, condition: 'GOOD', notes }, tenant.userId, t);
      ids.inspectionItemIds.push(item.id);
      const media = await upload(t, `drill-foto-${ids.inspectionItemIds.length}.png`, 'image/png', pngBytes(itemName), 'inspections');
      await inspectionsService.attachInspectionItemMedia(item.id, { fileId: media.id, mediaType: 'PHOTO' }, tenant.userId, t);
    }
    await inspectionsService.completeInspection(inspection.id, tenant.userId, t);
    for (const partyRole of ['LANDLORD', 'TENANT']) {
      await inspectionsService.signInspection(inspection.id, { partyRole, signaturePayload: `assinatura-${partyRole}-drill`, signedByUserId: tenant.userId }, tenant.userId, t);
    }
    await inspectionsService.generateInspectionReport(inspection.id, tenant.userId, t);

    const legalCase = await legalCasesService.createLegalCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractId: contract.id,
        propertyId: property.id,
        responsibleUserId: tenant.userId,
        escalationUserId: approverId,
        caseType: 'LITIGATION',
        summary: 'DRILL processo ficticio para dossie',
      },
      tenant.userId,
      t
    );
    ids.legalCaseId = legalCase.id;
    await legalCasesService.setLegalHold(legalCase.id, { legalHold: true, reason: 'Drill de restore — retenção legal ativa' }, tenant.userId, t);
    const pkg = await evidencePackagesService.createEvidencePackageFromContractAttachments(legalCase.id, tenant.userId, t);
    ids.evidencePackageId = pkg.id;
    ids.evidencePackageHash = pkg.packageHash;
    // Um acesso registrado antes do backup — a cadeia de custódia também tem que sobreviver.
    await evidencePackagesService.viewEvidencePackage(pkg.id, tenant.userId, t);

    ids.clauseIds = clauseIds;
    ids.auditEntityIds = [contract.id, version.id, legalCase.id, inspection.id, pkg.id, ...ids.signatureIds, clauseIds.conditional];
    return null;
  });
  return ids;
}

// Pagamento bancário confirmado ANTES do backup (F06: replay do callback depois do restore não
// pode liquidar de novo). Fluxo real: lançamento → intenção → aprovação por outro usuário →
// submissão ao banco (adapter sandbox) → callback CONFIRMED.
async function seedConfirmedBankPayment(tenant, approverId) {
  const { CostCenter, BankAccount } = require('../../src/models');
  const { createFinancialEntry } = require('../../src/features/finance/financialEntries.service');
  const { createPaymentIntent, approvePaymentIntent } = require('../../src/features/finance/paymentIntents.service');
  const { submitPaymentIntentToBank, confirmBankPayment } = require('../../src/features/finance/bankPayments.service');
  return inTenant(tenant, async (t) => {
    const costCenter = await CostCenter.create({ groupId: tenant.groupId, companyId: tenant.companyId, code: `CC-DRILL-${Date.now()}`, name: 'DRILL Centro de custo' }, { transaction: t });
    const bankAccount = await BankAccount.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `DRILL-${Date.now()}`, pixKey: 'drill@nayaraone.dev', status: 'ACTIVE' },
      { transaction: t }
    );
    const entry = await createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE', amount: 1234.56, description: 'DRILL pagamento bancário confirmado', dueAt: new Date(Date.now() + 86400000), costCenterId: costCenter.id, bankAccountId: bankAccount.id },
      tenant.userId,
      t
    );
    const intent = await createPaymentIntent({ financialEntryId: entry.id }, tenant.userId, t);
    await approvePaymentIntent(intent.id, approverId, t);
    const submitted = await submitPaymentIntentToBank(intent.id, 'PIX', { userId: tenant.userId }, t);
    await confirmBankPayment(submitted.externalSubmissionId, 'CONFIRMED', t);
    return { financialEntryId: entry.id, paymentIntentId: intent.id, externalSubmissionId: submitted.externalSubmissionId };
  });
}

async function createTenantB(tenantA) {
  // core.groups não tem RLS; core.companies é filtrada por grupo — a criação acontece dentro
  // do contexto do grupo novo, pelo próprio role de runtime.
  const group = await Group.create({ name: 'DRILL Grupo B' });
  const company = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true)', { replacements: { g: group.id }, transaction });
    return Company.create({ groupId: group.id, name: 'DRILL Empresa B' }, { transaction });
  });
  const tenantB = { groupId: group.id, companyId: company.id, userId: tenantA.userId };
  const contractB = await inTenant(tenantB, (t) => contractsService.createContract(
    { groupId: tenantB.groupId, companyId: tenantB.companyId, contractType: 'LEASE', totalValue: 999 },
    tenantB.userId,
    t
  ));
  return { ...tenantB, contractId: contractB.id };
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  if (!out) throw new Error('Uso: node scripts/restoreDrill/seedLegalFixtures.js --out <arquivo.json>');

  const group = await Group.findOne({ where: { name: 'Nayara One — Grupo Dev' } });
  if (!group) throw new Error('Tenant de seed não encontrado no banco de origem do drill (rode seed-dev antes).');
  const company = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true)', { replacements: { g: group.id }, transaction });
    return Company.findOne({ where: { groupId: group.id }, transaction });
  });
  const admin = await User.findOne({ where: { email: 'admin@nayaraone.dev' } });
  const tenantA = { groupId: group.id, companyId: company.id, userId: admin.id };
  const approver = await User.create({ name: 'DRILL Aprovador', email: `drill-approver-${Date.now()}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' });

  const a = await seedTenantA(tenantA, approver.id);
  const bankPayment = await seedConfirmedBankPayment(tenantA, approver.id);
  const b = await createTenantB(tenantA);

  const userIds = [admin.id, approver.id];
  fs.writeFileSync(out, JSON.stringify({ tenantA: { ...tenantA, ...a, bankPayment, userIds }, tenantB: b }, null, 2));
  console.log(
    `Fixtures criadas: ${a.files.length} arquivos (inclui o documento assinado), ${a.signatureIds.length} assinaturas de contrato, ` +
    `versão gerada pelo modelo ${a.templateId}, ${a.inspectionItemIds.length} itens de vistoria, dossiê ${a.evidencePackageId}, ` +
    `pagamento bancário confirmado ${bankPayment.externalSubmissionId}.`
  );
  await sequelize.close();
}

main().catch(async (err) => {
  console.error(err.stack || err.message);
  await sequelize.close().catch(() => {});
  process.exitCode = 1;
});
