'use strict';

/**
 * Fixtures controladas do drill de restore jurídico (F05, conferência Nayara 18/10/2026).
 *
 * Roda num processo filho com DATABASE_URL apontando para o banco de ORIGEM descartável do
 * drill (role de runtime, sem BYPASSRLS) e UPLOADS_DIR apontando para o storage de origem.
 * Tudo é criado pelos serviços reais da aplicação — upload cifrado em disco, contrato com
 * partes, versão com documento, assinaturas via adapter sandbox + webhook, checklist satisfeito
 * com arquivo, vistoria concluída com mídia, assinaturas e relatório PDF, processo jurídico e
 * dossiê montado automaticamente a partir dos anexos. Um segundo tenant (B) recebe um contrato
 * próprio, para os testes de isolamento pós-restore.
 *
 * Saída: JSON com os ids criados, gravado em --out.
 */

const fs = require('fs');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) { out.out = argv[i + 1]; i += 1; }
  }
  return out;
}

const { sequelize, Group, Company, User } = require('../../src/models');
const filesService = require('../../src/features/files/files.service');
const peopleService = require('../../src/features/people/people.service');
const propertiesService = require('../../src/features/properties/properties.service');
const contractsService = require('../../src/features/legal/contracts.service');
const contractVersionsService = require('../../src/features/legal/contractVersions.service');
const requirementsService = require('../../src/features/legal/requirements.service');
const signaturesService = require('../../src/features/legal/signatures.service');
const inspectionsService = require('../../src/features/legal/inspections.service');
const legalCasesService = require('../../src/features/legal/legalCases.service');
const evidencePackagesService = require('../../src/features/legal/evidencePackages.service');

async function inTenant(tenant, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true)', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SELECT set_config(\'app.company_id\', :c, true)', { replacements: { c: tenant.companyId }, transaction });
    await sequelize.query('SELECT set_config(\'app.user_id\', :u, true)', { replacements: { u: tenant.userId }, transaction });
    return fn(transaction);
  });
}

// Conteúdo binário real e distinto por arquivo — o drill compara o SHA-256 destes bytes depois
// do restore, então cada arquivo precisa de conteúdo próprio e não trivial.
function pdfBytes(label) {
  const body = `%PDF-1.4\n% Drill restore Nayara One — ${label}\n${crypto.randomBytes(2048).toString('base64')}\n%%EOF\n`;
  return Buffer.from(body, 'utf8');
}

function pngBytes(label) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.from(`drill:${label}:`), crypto.randomBytes(4096)]);
}

async function upload(tenant, transaction, fileName, mimeType, bytes, category) {
  return filesService.uploadFile(
    { groupId: tenant.groupId, companyId: tenant.companyId, fileName, mimeType, contentBase64: bytes.toString('base64'), category },
    tenant.userId,
    transaction
  );
}

async function person(tenant, transaction, legalName) {
  return peopleService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName }, tenant.userId, transaction);
}

async function seedTenantA(tenant) {
  return inTenant(tenant, async (t) => {
    const ids = { files: [], persons: [] };

    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 3500 },
      tenant.userId,
      t
    );
    ids.contractId = contract.id;

    const landlord = await person(tenant, t, 'DRILL Locador Ficticio');
    const lessee = await person(tenant, t, 'DRILL Locatario Ficticio');
    ids.persons.push(landlord.id, lessee.id);
    await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, t);
    await contractsService.addContractParty(contract.id, { personId: lessee.id, partyRole: 'TENANT' }, tenant.userId, t);

    // Checklist: o primeiro item é satisfeito com um arquivo real (entra no dossiê); o resto
    // é dispensado com motivo, para o contrato poder avançar até a assinatura.
    await requirementsService.generateRequirementsForContract(contract.id, {}, tenant.userId, t);
    const requirements = await requirementsService.listRequirements(contract.id, t);
    let satisfiedWithFile = false;
    for (const requirement of requirements) {
      if (requirement.status !== 'PENDING') continue;
      if (!satisfiedWithFile) {
        const reqFile = await upload(tenant, t, 'drill-documento-checklist.pdf', 'application/pdf', pdfBytes('checklist'), 'contracts');
        ids.files.push(reqFile.id);
        await requirementsService.satisfyRequirement(requirement.id, { satisfiedByFileId: reqFile.id }, tenant.userId, t);
        ids.requirementWithFileId = requirement.id;
        satisfiedWithFile = true;
      } else {
        await requirementsService.satisfyRequirement(requirement.id, { waivedReason: 'Drill de restore — item fora do escopo do cenário' }, tenant.userId, t);
      }
    }

    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, t);
    const versionFile = await upload(tenant, t, 'drill-contrato-v1.pdf', 'application/pdf', pdfBytes('contrato-v1'), 'contracts');
    ids.files.push(versionFile.id);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content: 'Contrato de locação — corpo da versão 1 (drill de restore).', documentFileId: versionFile.id },
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

    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: 'DRILL Imovel Ficticio', internalCode: `DRILL-${Date.now()}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      t
    );
    const inspection = await inspectionsService.createInspection(
      { groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, contractId: contract.id, inspectionType: 'CHECK_IN' },
      tenant.userId,
      t
    );
    ids.inspectionId = inspection.id;
    ids.inspectionItemIds = [];
    for (const [itemName, condition] of [['Piso da sala', 'GOOD'], ['Parede da cozinha', 'GOOD']]) {
      const item = await inspectionsService.addInspectionItem(inspection.id, { itemName, condition }, tenant.userId, t);
      ids.inspectionItemIds.push(item.id);
      const media = await upload(tenant, t, `drill-foto-${ids.inspectionItemIds.length}.png`, 'image/png', pngBytes(itemName), 'inspections');
      ids.files.push(media.id);
      await inspectionsService.attachInspectionItemMedia(item.id, { fileId: media.id, mediaType: 'PHOTO' }, tenant.userId, t);
    }
    await inspectionsService.completeInspection(inspection.id, tenant.userId, t);
    for (const partyRole of ['LANDLORD', 'TENANT']) {
      await inspectionsService.signInspection(inspection.id, { partyRole, signaturePayload: `assinatura-${partyRole}-drill`, signedByUserId: tenant.userId }, tenant.userId, t);
    }
    await inspectionsService.generateInspectionReport(inspection.id, tenant.userId, t);

    const legalCase = await legalCasesService.createLegalCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, caseType: 'LITIGATION', summary: 'DRILL processo ficticio para dossie' },
      tenant.userId,
      t
    );
    ids.legalCaseId = legalCase.id;
    const pkg = await evidencePackagesService.createEvidencePackageFromContractAttachments(legalCase.id, tenant.userId, t);
    ids.evidencePackageId = pkg.id;
    ids.evidencePackageHash = pkg.packageHash;
    // Um acesso registrado antes do backup — a cadeia de custódia também tem que sobreviver.
    await evidencePackagesService.viewEvidencePackage(pkg.id, tenant.userId, t);

    return ids;
  });
}

// Pagamento bancário confirmado ANTES do backup (F06: replay do callback depois do restore não
// pode liquidar de novo). Fluxo real: lançamento → intenção → aprovação por outro usuário →
// submissão ao banco (adapter sandbox) → callback CONFIRMED.
async function seedConfirmedBankPayment(tenant) {
  const { CostCenter, BankAccount } = require('../../src/models');
  const { createFinancialEntry } = require('../../src/features/finance/financialEntries.service');
  const { createPaymentIntent, approvePaymentIntent } = require('../../src/features/finance/paymentIntents.service');
  const { submitPaymentIntentToBank, confirmBankPayment } = require('../../src/features/finance/bankPayments.service');
  const approver = await User.create({ name: 'DRILL Aprovador de pagamento', email: `drill-approver-${Date.now()}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' });
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
    await approvePaymentIntent(intent.id, approver.id, t);
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

  const a = await seedTenantA(tenantA);
  const bankPayment = await seedConfirmedBankPayment(tenantA);
  const b = await createTenantB(tenantA);

  fs.writeFileSync(out, JSON.stringify({ tenantA: { ...tenantA, ...a, bankPayment }, tenantB: b }, null, 2));
  console.log(`Fixtures criadas: ${a.files.length} arquivos, ${a.signatureIds.length} assinaturas de contrato, ${a.inspectionItemIds.length} itens de vistoria, dossiê ${a.evidencePackageId}, pagamento bancário confirmado ${bankPayment.externalSubmissionId}.`);
  await sequelize.close();
}

main().catch(async (err) => {
  console.error(err.stack || err.message);
  await sequelize.close().catch(() => {});
  process.exitCode = 1;
});
