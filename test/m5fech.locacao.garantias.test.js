'use strict';

/**
 * Fechamento do Marco 5 — Locação: garantias (Caderno M5 §9, JUR-006, JUR-TS-015, Guia §19 "Não duplicar
 * caução fora do Financeiro"). Camada de serviço em transação desfeita no fim (RLS do tenant de seed).
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const guaranteesService = require('../src/features/legal/guarantees.service');
const { getGuaranteeDetail } = require('../src/features/legal/guaranteeDetail.service');
const closureGate = require('../src/features/legal/contractClosureGate');
const { upsertSetting } = require('../src/features/settings/settings.service');
const { computeThirdPartyOriginBalance } = require('../src/features/finance/financialEntries.service');
const { Contract, Person, ContractParty, FinancialEntry, Guarantee } = require('../src/models');
const { uploadTestFile, completeInsurance } = require('./m5fech.locacao.helpers');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const code = (c) => (err) => { assert.equal(err.code, c, `${err.code}: ${err.message}`); return true; };

async function contract(t) {
  return Contract.create({ ...base(), contractType: 'LEASE', contractNumber: `M5FG-${uniqueSuffix()}`, status: 'ACTIVE', createdBy: tenant.userId }, { transaction: t });
}
async function person(t, name) {
  return Person.create({ ...base(), personType: 'PF', legalName: `${name} ${uniqueSuffix()}`, createdBy: tenant.userId }, { transaction: t });
}
async function depositOrigin(t, ct, amount = 6000) {
  const holder = await person(t, 'M5F titular caução');
  await ContractParty.create({ ...base(), contractId: ct.id, personId: holder.id, partyRole: 'TENANT' }, { transaction: t });
  const origin = await FinancialEntry.create(
    { ...base(), contractId: ct.id, entryType: 'RECEIVABLE', nature: 'RECEIVABLE', amount, status: 'SETTLED', description: 'Caução M5F', isThirdPartyFunds: true, thirdPartyReference: `Caução ${ct.contractNumber}`, thirdPartyHolderPersonId: holder.id, createdBy: tenant.userId },
    { transaction: t }
  );
  return { origin, holder };
}

test('fechamento M5 JUR-TS-015/Guia §19: encerrar a caução no jurídico não mexe no Financeiro — saldo e trilha preservados e o gate continua vendo o saldo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    const { origin, holder } = await depositOrigin(t, ct);
    await FinancialEntry.create(
      { ...base(), contractId: ct.id, entryType: 'PAYABLE', nature: 'PAYABLE', amount: 4000, status: 'PENDING', description: 'Devolução parcial M5F', isThirdPartyFunds: true, thirdPartyReference: origin.thirdPartyReference, thirdPartyOriginEntryId: origin.id, thirdPartyHolderPersonId: holder.id, createdBy: tenant.userId },
      { transaction: t }
    );
    const entriesBefore = await FinancialEntry.findAll({ where: { contractId: ct.id }, order: [['created_at', 'ASC']], transaction: t });
    assert.equal(Number((await computeThirdPartyOriginBalance(origin, t)).available), 2000);

    const g = await guaranteesService.createGuarantee(ct.id, { guaranteeType: 'SECURITY_DEPOSIT', value: 6000, startsAt: '2026-01-01', financeEntryId: origin.id }, tenant.userId, t);
    assert.equal(g.status, 'ACTIVE');
    assert.equal(g.holderPersonId, holder.id, 'titular vem do recebimento no Financeiro');
    const detail = await getGuaranteeDetail(guaranteesService, g.id, t);
    assert.equal(Number(detail.depositTrail.available), 2000);
    assert.equal(detail.depositTrail.movements.length, 1, 'devolução/compensação aparece na trilha');
    const released = await guaranteesService.updateGuarantee(g.id, { status: 'RELEASED' }, tenant.userId, t);
    assert.equal(released.status, 'RELEASED');

    const entriesAfter = await FinancialEntry.findAll({ where: { contractId: ct.id }, order: [['created_at', 'ASC']], transaction: t });
    assert.deepEqual(entriesAfter.map((e) => [e.id, e.status, Number(e.amount)]), entriesBefore.map((e) => [e.id, e.status, Number(e.amount)]), 'nenhum lançamento criado, alterado ou apagado pelo jurídico');
    assert.equal(Number((await getGuaranteeDetail(guaranteesService, g.id, t)).depositTrail.available), 2000, 'trilha legível depois de encerrada');
    const types = (await closureGate.collectContractClosurePendencies(ct.id, t)).map((p) => p.type);
    assert.ok(types.includes('DEPOSIT_BALANCE'));
    await assert.rejects(guaranteesService.createGuarantee(ct.id, { guaranteeType: 'SECURITY_DEPOSIT', value: 100, balance: 50 }, tenant.userId, t), code('LEGAL_GUARANTEE_DEPOSIT_FIELD_NOT_ALLOWED'));
  });
});

test('fechamento M5 §9: os cinco códigos do livro; DEPOSIT e CAPITALIZATION_TITLE entram como apelido e saem com o código do livro', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    const a = await guaranteesService.createGuarantee(ct.id, { guaranteeType: 'DEPOSIT', value: 100 }, tenant.userId, t);
    const b = await guaranteesService.createGuarantee(ct.id, { guaranteeType: 'CAPITALIZATION_TITLE', value: 100, endsAt: '2030-01-01' }, tenant.userId, t);
    assert.deepEqual([a.guaranteeType, b.guaranteeType], ['SECURITY_DEPOSIT', 'CAPITALIZATION']);
    const legacy = await Guarantee.create({ ...base(), contractId: ct.id, guaranteeType: 'DEPOSIT', status: 'PENDING', value: 1 }, { transaction: t });
    const [[row]] = await sequelize.query('SELECT guarantee_type FROM legal.guarantees WHERE id = :id', { replacements: { id: legacy.id }, transaction: t });
    assert.equal(row.guarantee_type, 'SECURITY_DEPOSIT', 'o banco traduz o gravador legado');
    assert.deepEqual([...guaranteesService.GUARANTEE_TYPES].sort(), ['CAPITALIZATION', 'GUARANTOR', 'INSURANCE', 'OTHER', 'SECURITY_DEPOSIT']);
  });
});

test('fechamento M5 §9 GUARANTOR: pessoas, documentos, vigência e aceite; fiador não pode ser parte; incompleto fica PENDING', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    const fiador = await person(t, 'M5F fiador');
    const conjuge = await person(t, 'M5F cônjuge do fiador');
    const locatario = await person(t, 'M5F locatário');
    await ContractParty.create({ ...base(), contractId: ct.id, personId: locatario.id, partyRole: 'TENANT' }, { transaction: t });
    await assert.rejects(guaranteesService.createGuarantee(ct.id, { guaranteeType: 'GUARANTOR', guarantorPersonId: locatario.id, endsAt: '2030-01-01' }, tenant.userId, t), code('LEGAL_GUARANTEE_GUARANTOR_CONFLICT'));
    const pendente = await guaranteesService.createGuarantee(ct.id, { guaranteeType: 'GUARANTOR', guarantorPersonId: fiador.id, endsAt: '2030-01-01' }, tenant.userId, t);
    assert.equal(pendente.status, 'PENDING');
    assert.deepEqual((await getGuaranteeDetail(guaranteesService, pendente.id, t)).missingForActivation, ['documentFileIds', 'acceptanceFileId', 'acceptedAt']);
    await assert.rejects(guaranteesService.updateGuarantee(pendente.id, { status: 'ACTIVE' }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDATION'));
    const doc = await uploadTestFile(tenant, t, 'rg-fiador.pdf');
    const aceite = await uploadTestFile(tenant, t, 'aceite.pdf');
    const ativo = await guaranteesService.updateGuarantee(pendente.id, { documentFileIds: [doc.id], acceptanceFileId: aceite.id, acceptedAt: '2026-01-05', additionalGuarantorPersonIds: [conjuge.id], status: 'ACTIVE' }, tenant.userId, t);
    assert.equal(ativo.status, 'ACTIVE');
    assert.deepEqual(ativo.additionalGuarantorPersonIds, [conjuge.id]);
    await assert.rejects(guaranteesService.createGuarantee(ct.id, { guaranteeType: 'GUARANTOR', guarantorPersonId: fiador.id, endsAt: '2030-01-01', acceptanceFileId: aceite.id }, tenant.userId, t), code('LEGAL_GUARANTEE_FILE_REUSED'));
  });
});

test('fechamento M5 §9 INSURANCE: seguradora, apólice, vigência, parcelas e renovação gravados; parcelas conferidas com o prêmio', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    const payload = await completeInsurance(tenant, t, { annualPremium: 2400, premiumInstallments: [{ number: 1, dueDate: '2026-02-01', amount: 1200 }, { number: 2, dueDate: '2026-08-01', amount: 1200 }], autoRenew: true });
    const g = await guaranteesService.createGuarantee(ct.id, payload, tenant.userId, t);
    assert.equal(g.status, 'ACTIVE');
    assert.deepEqual([g.providerName, g.policyNumber, g.policyFileId, g.renewalDueAt, g.autoRenew, g.premiumInstallments.length], [payload.providerName, payload.policyNumber, payload.policyFileId, '2030-11-30', true, 2]);
    await assert.rejects(guaranteesService.createGuarantee(ct.id, await completeInsurance(tenant, t, { annualPremium: 1000 }), tenant.userId, t), code('LEGAL_GUARANTEE_VALIDATION'));
    await assert.rejects(guaranteesService.createGuarantee(ct.id, { guaranteeType: 'INSURANCE', value: 1, endsAt: '2030-01-01', status: 'ACTIVE' }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDATION'));
    await assert.rejects(guaranteesService.createGuarantee(ct.id, { ...(await completeInsurance(tenant, t)), policyNumber: payload.policyNumber }, tenant.userId, t), code('LEGAL_GUARANTEE_POLICY_DUPLICATE'));
  });
});

test('fechamento M5 §9 SECURITY_DEPOSIT e CAPITALIZATION: vínculo financeiro conferido; título com documento, provider e vigência', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    const other = await contract(t);
    const { origin } = await depositOrigin(t, other);
    await assert.rejects(guaranteesService.createGuarantee(ct.id, { guaranteeType: 'SECURITY_DEPOSIT', value: 100, financeEntryId: origin.id }, tenant.userId, t), code('LEGAL_GUARANTEE_DEPOSIT_ORIGIN_INVALID'));
    const mine = (await depositOrigin(t, ct, 3000)).origin;
    await assert.rejects(guaranteesService.createGuarantee(ct.id, { guaranteeType: 'SECURITY_DEPOSIT', value: 3000.01, financeEntryId: mine.id }, tenant.userId, t), code('LEGAL_GUARANTEE_DEPOSIT_ORIGIN_INVALID'));
    const semVinculo = await guaranteesService.createGuarantee(ct.id, { guaranteeType: 'SECURITY_DEPOSIT', value: 3000 }, tenant.userId, t);
    assert.equal(semVinculo.status, 'PENDING', 'caução sem o recebimento no Financeiro não fica ativa');
    const cert = await uploadTestFile(tenant, t, 'titulo.pdf');
    const titulo = await guaranteesService.createGuarantee(ct.id, { guaranteeType: 'CAPITALIZATION', value: 5000, endsAt: '2030-01-01', providerName: 'Capitalizadora', certificateNumber: `TC-${uniqueSuffix()}`, certificateFileId: cert.id }, tenant.userId, t);
    assert.equal(titulo.status, 'ACTIVE');
    const semDoc = await guaranteesService.createGuarantee(ct.id, { guaranteeType: 'CAPITALIZATION', value: 5000, endsAt: '2030-01-01', providerName: 'Capitalizadora' }, tenant.userId, t);
    assert.equal(semDoc.status, 'PENDING');
  });
});

test('fechamento M5 §9 OTHER: só com fluxo homologado configurado pela empresa, com os campos que o fluxo exige', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    await upsertSetting('legal.guarantee_other_flows', '[]', base(), tenant.userId, t);
    await assert.rejects(guaranteesService.createGuarantee(ct.id, { guaranteeType: 'OTHER', homologatedFlowCode: 'CARTA_FIANCA', value: 10 }, tenant.userId, t), code('LEGAL_GUARANTEE_FLOW_NOT_CONFIGURED'));
    await upsertSetting('legal.guarantee_other_flows', JSON.stringify([{ code: 'CARTA_FIANCA', label: 'Carta de fiança bancária', requiredFields: ['banco', 'numeroCarta'] }]), base(), tenant.userId, t);
    await assert.rejects(guaranteesService.createGuarantee(ct.id, { guaranteeType: 'OTHER', homologatedFlowCode: 'CARTA_FIANCA', flowData: { banco: 'Banco X' } }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDATION'));
    const ok = await guaranteesService.createGuarantee(ct.id, { guaranteeType: 'OTHER', homologatedFlowCode: 'CARTA_FIANCA', flowData: { banco: 'Banco X', numeroCarta: '123' }, value: 10 }, tenant.userId, t);
    assert.deepEqual([ok.status, ok.homologatedFlowCode, ok.flowData.numeroCarta], ['ACTIVE', 'CARTA_FIANCA', '123']);
  });
});

test('fechamento M5 §9/JUR-006: cada garantia tem vigência e status próprios; fiador, seguro e título exigem fim de vigência', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ct = await contract(t);
    const fiador = await person(t, 'M5F fiador');
    for (const [guaranteeType, extra] of [['GUARANTOR', { guarantorPersonId: fiador.id }], ['INSURANCE', { value: 10000 }], ['CAPITALIZATION', { value: 5000 }]]) {
      await assert.rejects(guaranteesService.createGuarantee(ct.id, { guaranteeType, startsAt: '2026-01-01', ...extra }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDITY_REQUIRED'));
    }
    const seguro = await guaranteesService.createGuarantee(ct.id, await completeInsurance(tenant, t, { endsAt: '2027-01-01', renewalDueAt: '2026-12-01' }), tenant.userId, t);
    const caucao = await guaranteesService.createGuarantee(ct.id, { guaranteeType: 'SECURITY_DEPOSIT', value: 3000 }, tenant.userId, t);
    assert.equal(caucao.endsAt, null);
    await assert.rejects(guaranteesService.createGuarantee(ct.id, { guaranteeType: 'INSURANCE', value: 1, startsAt: '2027-01-02', endsAt: '2027-01-01' }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDATION'));
    await guaranteesService.updateGuarantee(caucao.id, { status: 'CANCELLED' }, tenant.userId, t);
    const list = await guaranteesService.listGuarantees(t, { contractId: ct.id });
    const status = Object.fromEntries(list.map((g) => [g.id, g.status]));
    assert.deepEqual([status[seguro.id], status[caucao.id]], ['ACTIVE', 'CANCELLED']);
    assert.equal(list.find((g) => g.id === seguro.id).endsAt, '2027-01-01');
    await assert.rejects(guaranteesService.updateGuarantee(seguro.id, { status: 'Vencida' }, tenant.userId, t), code('LEGAL_GUARANTEE_VALIDATION'));
  });
});
