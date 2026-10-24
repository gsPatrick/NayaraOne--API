'use strict';

require('dotenv').config();

const { sequelize, Person, Property, PropertyOwner, Contract, ContractParty, FinancialEntry, BankAccount, CostCenter, ResultCenter } = require('../src/models');
const personService = require('../src/features/people/person.service');
const propertiesService = require('../src/features/properties/properties.service');
const propertyOwnersService = require('../src/features/properties/propertyOwners.service');
const contractsService = require('../src/features/legal/contracts.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const costCentersService = require('../src/features/finance/costCenters.service');
const resultCentersService = require('../src/features/finance/resultCenters.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const { registrarAuditoria } = require('../src/engines/audit/auditLog.service');

/**
 * Seed de homologação M45-RECONF (bloqueio 6b–6e, 19/10/2026) — idempotente, valores fictícios.
 *
 * A reconferência ao vivo não conseguiu testar repasse (duplicado, aprovação A/B, confirmar
 * pagamento) porque nenhum imóvel da lista tinha recebimento liquidado elegível. Este script cria,
 * pelos MESMOS serviços que a tela usa (cada um grava sua própria auditoria), a massa mínima:
 *   - pessoa "HOMO M45 Proprietário Repasse" (proprietário) e "HOMO M45 Locatário Repasse";
 *   - imóvel "HOMO M45 Imóvel Repasse" (código HOMO-M45-REP-01) com o proprietário vinculado;
 *   - contrato de locação residencial do imóvel, com as partes Locador/Locatário;
 *   - recebimento (a receber) de aluguel de R$ 2.500,00, competência do mês corrente, LIQUIDADO.
 * Cada criação também grava um evento "homolog_seed" com antes/depois. Rodar de novo não cria
 * nada repetido (procura pelo nome/código/chave de idempotência antes de criar).
 *
 * Uso: node scripts/seed-homo-m45-repasse.js   (recusa se DEPLOY_ENVIRONMENT=production)
 */

const GROUP_ID = '51cca01b-6a2e-4815-9aa1-70d40e3aba24';
const COMPANY_ID = '110723f9-4ad2-45fb-b6ec-1f2631821f32';
const ADMIN_USER_ID = '33477648-c752-4bed-83cb-a04114224f4d';
const TAG = 'HOMO M45';
const PROPERTY_CODE = 'HOMO-M45-REP-01';
const ENTRY_KEY = 'homo-m45-repasse-recebimento-1';

function currentMonthBR() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
}

async function audit(entityType, entity, reason, t) {
  await registrarAuditoria(
    {
      groupId: GROUP_ID, companyId: COMPANY_ID, actorUserId: ADMIN_USER_ID, action: 'homolog.seed.m45_repasse',
      entityType, entityId: entity.id, beforeJson: { situacao: 'não existia' }, afterJson: entity.toJSON ? entity.toJSON() : entity,
      reason: `Seed de homologação M45 (repasse): ${reason} — dados fictícios.`,
    },
    t
  );
}

async function findOrCreatePerson(legalName, t) {
  const existing = await Person.findOne({ where: { companyId: COMPANY_ID, legalName }, transaction: t });
  if (existing) return { person: existing, created: false };
  const person = await personService.createPerson({ groupId: GROUP_ID, companyId: COMPANY_ID, personType: 'PF', legalName, allowDuplicate: true }, ADMIN_USER_ID, t);
  await audit('Person', person, `pessoa "${legalName}" criada`, t);
  return { person, created: true };
}

async function main() {
  if (process.env.DEPLOY_ENVIRONMENT === 'production') throw new Error('Seed de homologação proibido em produção.');
  const t = await sequelize.transaction();
  const summary = {};
  try {
    await sequelize.query(
      "SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)",
      { replacements: { g: GROUP_ID, c: COMPANY_ID, u: ADMIN_USER_ID }, transaction: t }
    );

    const { person: owner } = await findOrCreatePerson(`${TAG} Proprietário Repasse`, t);
    const { person: tenant } = await findOrCreatePerson(`${TAG} Locatário Repasse`, t);
    summary.ownerPersonId = owner.id;
    summary.tenantPersonId = tenant.id;

    let property = await Property.findOne({ where: { companyId: COMPANY_ID, internalCode: PROPERTY_CODE }, transaction: t });
    if (!property) {
      property = await propertiesService.createProperty(
        {
          groupId: GROUP_ID, companyId: COMPANY_ID, title: `${TAG} Imóvel Repasse`, internalCode: PROPERTY_CODE, propertyType: 'RESIDENTIAL',
          addressLine: 'Rua da Homologação, 45', city: 'São Paulo', state: 'SP', zipCode: '01000045',
        },
        ADMIN_USER_ID, t
      );
    }
    summary.propertyId = property.id;

    const ownerLink = await PropertyOwner.findOne({ where: { propertyId: property.id, personId: owner.id }, transaction: t });
    if (!ownerLink) {
      const link = await propertyOwnersService.createOwner(property.id, { personId: owner.id, ownershipPercent: 100, roleCode: 'OWNER' }, ADMIN_USER_ID, t);
      await audit('PropertyOwner', link, 'proprietário vinculado ao imóvel (100%)', t);
    }

    let contract = await Contract.findOne({ where: { companyId: COMPANY_ID, propertyId: property.id, contractType: 'LEASE_RESIDENTIAL' }, transaction: t });
    if (!contract) {
      contract = await contractsService.createContract(
        {
          groupId: GROUP_ID, companyId: COMPANY_ID, propertyId: property.id, contractType: 'LEASE_RESIDENTIAL',
          totalValue: 30000, startsAt: new Date('2026-10-01T12:00:00Z'), endsAt: new Date('2027-09-30T12:00:00Z'),
        },
        ADMIN_USER_ID, t
      );
      await audit('Contract', contract, `contrato de locação ${contract.contractNumber} do imóvel ${PROPERTY_CODE}`, t);
    }
    summary.contractId = contract.id;
    summary.contractNumber = contract.contractNumber;
    for (const [personId, partyRole] of [[owner.id, 'LANDLORD'], [tenant.id, 'TENANT']]) {
      const party = await ContractParty.findOne({ where: { contractId: contract.id, personId, partyRole }, transaction: t });
      if (!party) await contractsService.addContractParty(contract.id, { personId, partyRole }, ADMIN_USER_ID, t);
    }

    let entry = await FinancialEntry.findOne({ where: { companyId: COMPANY_ID, idempotencyKey: ENTRY_KEY }, transaction: t });
    if (!entry) {
      let account = await BankAccount.findOne({ where: { companyId: COMPANY_ID, accountNumber: 'M45-SANDBOX' }, transaction: t });
      if (!account) {
        account = await bankAccountsService.createBankAccount(
          { groupId: GROUP_ID, companyId: COMPANY_ID, bankCode: '001', agency: '4545', accountNumber: 'M45-SANDBOX' }, ADMIN_USER_ID, t
        );
        account.status = 'ACTIVE';
        await account.save({ transaction: t });
      }
      const cc = (await CostCenter.findOne({ where: { companyId: COMPANY_ID, code: 'HOMO-M45' }, transaction: t }))
        || (await costCentersService.createCostCenter({ groupId: GROUP_ID, companyId: COMPANY_ID, code: 'HOMO-M45', name: `${TAG} — homologação` }, ADMIN_USER_ID, t));
      const rc = (await ResultCenter.findOne({ where: { companyId: COMPANY_ID, code: 'HOMO-M45' }, transaction: t }))
        || (await resultCentersService.createResultCenter({ groupId: GROUP_ID, companyId: COMPANY_ID, code: 'HOMO-M45', name: `${TAG} — receitas de homologação` }, ADMIN_USER_ID, t));
      const month = currentMonthBR();
      entry = await financialEntriesService.createFinancialEntry(
        {
          groupId: GROUP_ID, companyId: COMPANY_ID, bankAccountId: account.id, costCenterId: cc.id, resultCenterId: rc.id, contractId: contract.id,
          entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 2500,
          description: `${TAG} — aluguel recebido do locatário (repasse)`, dueAt: new Date(), competenceMonth: month, idempotencyKey: ENTRY_KEY,
        },
        ADMIN_USER_ID, t
      );
    }
    if (entry.status === 'PENDING') {
      entry = await financialEntriesService.settleFinancialEntry(entry.id, ADMIN_USER_ID, t);
    }
    summary.financialEntryId = entry.id;
    summary.entryStatus = entry.status;
    summary.competenceMonth = entry.competenceMonth;

    await t.commit();
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    await t.rollback();
    throw err;
  } finally {
    await sequelize.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
