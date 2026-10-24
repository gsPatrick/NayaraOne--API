'use strict';

// Marco 8 (addendum fiscal) — XML/PDF preservados, conferências automáticas, export com ajuste,
// retorno do contador com hash e calendário de obrigações.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const nfse = require('../../src/features/correspondent/fiscal/nfse.service');
const dimob = require('../../src/features/correspondent/fiscal/dimob.service');
const recon = require('../../src/features/correspondent/fiscal/reconciliation.service');
const exportService = require('../../src/features/correspondent/fiscal/accountingExport.service');
const obligations = require('../../src/features/correspondent/fiscal/obligations.service');
const financingCases = require('../../src/features/correspondent/cases/financingCases.service');
const commissions = require('../../src/features/correspondent/cases/commissionEntitlements.service');
const { Person, CommissionEntitlement, FiscalReconciliation } = require('../../src/models');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const a = () => [tenant.userId, tenant.groupId, tenant.companyId];
const ctx = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const codigo = (c) => (err) => { assert.equal(err.code, c, `esperava ${c}, veio ${err.code}: ${err.message}`); return true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function comissaoRecebivel(t, base = 50000) {
  const pessoa = await Person.create({ ...ctx(), personType: 'PF', legalName: `Fiscal ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId }, { transaction: t });
  const caso = await financingCases.createFinancingCase({ ...ctx(), providerCode: 'manual', applicants: [{ personId: pessoa.id, role: 'PRINCIPAL' }] }, tenant.userId, t);
  const e = await commissions.createCommissionEntitlement(caso.id, { baseAmount: base }, tenant.userId, tenant.groupId, tenant.companyId, t);
  return commissions.confirmCommissionEntitlement(e.id, { externalConfirmationId: `conf-${uniqueSuffix()}` }, tenant.userId, tenant.groupId, tenant.companyId, t);
}

test('M8-NFSE-ARQ-01: NFS-e autorizada preserva XML, PDF, código de verificação e hashes que conferem no download', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const inv = await nfse.requestInvoice({ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: tenant.userId, amount: 1234.5, description: `Serviço ${uniqueSuffix()}` }, ...a(), t);
    await sleep(1700);
    await nfse.checkInvoiceStatus(inv.id, ...a(), t);
    const xml = await nfse.getInvoiceFile(inv.id, 'xml', tenant.groupId, tenant.companyId, t);
    const pdf = await nfse.getInvoiceFile(inv.id, 'pdf', tenant.groupId, tenant.companyId, t);
    assert.match(xml.buffer.toString(), /<NFSe/);
    assert.match(xml.buffer.toString(), /<ValorServicos>1234.50<\/ValorServicos>/);
    assert.equal(pdf.buffer.subarray(0, 4).toString(), '%PDF');
    assert.equal(xml.sha256, crypto.createHash('sha256').update(xml.buffer).digest('hex'));
    const lista = await nfse.listInvoiceRequests(tenant.groupId, tenant.companyId, t);
    const doc = lista.find((i) => i.id === inv.id).document;
    assert.equal(doc.hasXml, true);
    assert.equal(doc.hasPdf, true);
    assert.ok(doc.verificationCode);
  });
});

test('M8-NFSE-ARQ-02: antes da autorização não há arquivo para baixar', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const inv = await nfse.requestInvoice({ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: tenant.userId, amount: 10, description: `Sem arquivo ${uniqueSuffix()}` }, ...a(), t);
    await assert.rejects(nfse.getInvoiceFile(inv.id, 'xml', tenant.groupId, tenant.companyId, t), codigo('NFSE_DOCUMENT_NOT_AVAILABLE'));
  });
});

test('M8-REC-01: nota com valor diferente da comissão abre issue FINANCE_X_NFSE; rodar de novo não duplica', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await comissaoRecebivel(t);
    const inv = await nfse.requestInvoice({ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: e.id, amount: Number(e.amount) + 100, description: `Nota divergente ${uniqueSuffix()}` }, ...a(), t);
    await sleep(1700);
    await nfse.checkInvoiceStatus(inv.id, ...a(), t);
    const abertas = await recon.listReconciliations('OPEN', tenant.groupId, tenant.companyId, t);
    const minha = abertas.filter((r) => r.reconciliationType === 'FINANCE_X_NFSE' && r.referenceId === inv.id);
    assert.equal(minha.length, 1);
    assert.equal(Number(minha[0].differenceAmount), -100);
    await recon.runReconciliations(tenant.userId, tenant.groupId, tenant.companyId, t);
    const depois = (await recon.listReconciliations('OPEN', tenant.groupId, tenant.companyId, t)).filter((r) => r.referenceId === inv.id);
    assert.equal(depois.length, 1, 'não duplica a issue');
  });
});

test('M8-REC-02: nota com o mesmo valor da comissão não abre issue', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await comissaoRecebivel(t);
    const inv = await nfse.requestInvoice({ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: e.id, amount: Number(e.amount), description: `Nota certa ${uniqueSuffix()}` }, ...a(), t);
    await sleep(1700);
    await nfse.checkInvoiceStatus(inv.id, ...a(), t);
    const r = await FiscalReconciliation.findAll({ where: { referenceId: inv.id }, transaction: t });
    assert.equal(r.length, 0);
  });
});

test('M8-DIMOB-OBR-01: gerar batch cadastra a obrigação do ano; fechar conclui; DIMOB x contratos confere', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = new Date().getUTCFullYear();
    await comissaoRecebivel(t);
    const batch = await dimob.generateDimobBatch(ano, tenant.userId, tenant.groupId, tenant.companyId, t);
    let lista = await obligations.listObligations(tenant.groupId, tenant.companyId, t);
    let o = lista.find((x) => x.referenceYear === ano && x.obligationType === 'DIMOB_ANNUAL');
    assert.ok(o, 'obrigação criada ao gerar o batch');
    assert.equal(o.dueAt, obligations.defaultDimobDueDate(ano));
    assert.notEqual(o.status, 'COMPLETED');

    const lidos = await dimob.listDimobRecords(batch.id, tenant.groupId, tenant.companyId, t);
    assert.ok(lidos.records.length >= 1);

    await dimob.closeDimobBatch(batch.id, tenant.userId, tenant.groupId, tenant.companyId, t);
    lista = await obligations.listObligations(tenant.groupId, tenant.companyId, t);
    o = lista.find((x) => x.referenceYear === ano && x.obligationType === 'DIMOB_ANNUAL');
    assert.equal(o.status, 'COMPLETED');
    assert.equal(o.dimobBatchId, batch.id);
    assert.ok(o.completedAt);
    const abertas = (await recon.listReconciliations('OPEN', tenant.groupId, tenant.companyId, t)).filter((r) => r.referenceId === batch.id);
    assert.equal(abertas.length, 0, 'DIMOB bate com as comissões');
  });
});

test('M8-DIMOB-OBR-02: comissão entra depois do batch → DIMOB x contratos abre issue', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const ano = new Date().getUTCFullYear();
    const batch = await dimob.generateDimobBatch(ano, tenant.userId, tenant.groupId, tenant.companyId, t);
    const nova = await comissaoRecebivel(t, 80000);
    const r = await recon.runReconciliations(tenant.userId, tenant.groupId, tenant.companyId, t);
    const issue = r.opened.find((x) => x.reconciliationType === 'DIMOB_X_CONTRACTS' && x.referenceId === batch.id);
    assert.ok(issue);
    assert.ok(Number(issue.differenceAmount) >= Number(nova.amount) - 0.001);
  });
});

test('M8-OBR-01: prazo vencido vira OVERDUE; conclusão manual exige observação; tipo e ano inválidos são recusados', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const o = await obligations.ensureObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear: 2019, dueAt: '2020-02-28' }, tenant.userId, tenant.groupId, tenant.companyId, t);
    const repetida = await obligations.ensureObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear: 2019 }, tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal(repetida.id, o.id, 'única por empresa/tipo/ano');
    const lista = await obligations.listObligations(tenant.groupId, tenant.companyId, t);
    const vencida = lista.find((x) => x.id === o.id);
    assert.equal(vencida.status, 'OVERDUE');
    assert.ok(vencida.daysUntilDue < 0);
    await assert.rejects(obligations.completeObligation(o.id, '', tenant.userId, tenant.groupId, tenant.companyId, t), codigo('FISCAL_OBLIGATION_NOTE_REQUIRED'));
    const feita = await obligations.completeObligation(o.id, 'Entregue pelo contador', tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal(feita.status, 'COMPLETED');
    await assert.rejects(obligations.completeObligation(o.id, 'de novo', tenant.userId, tenant.groupId, tenant.companyId, t), codigo('FISCAL_OBLIGATION_ALREADY_COMPLETED'));
    await assert.rejects(obligations.ensureObligation({ obligationType: 'OUTRA', referenceYear: 2025 }, tenant.userId, tenant.groupId, tenant.companyId, t), codigo('FISCAL_OBLIGATION_VALIDATION'));
    await assert.rejects(obligations.ensureObligation({ obligationType: 'DIMOB_ANNUAL', referenceYear: 1800 }, tenant.userId, tenant.groupId, tenant.companyId, t), codigo('FISCAL_OBLIGATION_VALIDATION'));
  });
});

test('M8-EXP-01: candidatos do mês entram no batch, não repetem em outro batch e o ajuste cria linha nova', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await comissaoRecebivel(t);
    const periodo = new Date().toISOString().slice(0, 7);
    const candidatos = await exportService.listExportCandidates(periodo, tenant.groupId, tenant.companyId, t);
    assert.ok(candidatos.some((c) => c.sourceId === e.id));
    const batch = await exportService.createExportBatch(periodo, null, tenant.userId, tenant.groupId, tenant.companyId, t);
    const depois = await exportService.listExportCandidates(periodo, tenant.groupId, tenant.companyId, t);
    assert.ok(!depois.some((c) => c.sourceId === e.id), 'já exportado não é candidato');
    const { lines } = await exportService.getExportBatch(batch.id, tenant.groupId, tenant.companyId, t);
    const minha = lines.find((l) => l.sourceId === e.id);
    const ajuste = await exportService.adjustExportLine(minha.id, -10, 'Arredondamento do contador', tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal(ajuste.adjustmentOfLineId, minha.id);
    assert.equal(Number(ajuste.amount), -10);
    const reler = await exportService.getExportBatch(batch.id, tenant.groupId, tenant.companyId, t);
    assert.equal(Number(reler.lines.find((l) => l.id === minha.id).amount), Number(e.amount), 'original intocada');
    assert.equal(reler.lines.length, lines.length + 1);
  });
});

test('M8-RET-01: retorno com hash errado é recusado; hash certo e valores iguais = MATCHED; valores diferentes = DIVERGENT com issue', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const e = await comissaoRecebivel(t);
    const batch = await exportService.createExportBatch(new Date().toISOString().slice(0, 7), [
      { sourceType: 'COMMISSION_ENTITLEMENT', sourceId: e.id, amount: Number(e.amount), description: 'Comissão do teste de retorno' },
    ], tenant.userId, tenant.groupId, tenant.companyId, t);
    const linha = { sourceType: 'COMMISSION_ENTITLEMENT', sourceId: e.id, amount: Number(e.amount) };

    await assert.rejects(exportService.importAccountingReturn(batch.id, { batchHash: 'a'.repeat(64), lines: [linha] }, ...a(), t), codigo('ACCOUNTING_RETURN_HASH_MISMATCH'));
    await assert.rejects(exportService.importAccountingReturn(batch.id, { lines: [linha] }, ...a(), t), codigo('ACCOUNTING_RETURN_VALIDATION'));
    await assert.rejects(exportService.importAccountingReturn(batch.id, { batchHash: batch.batchHash, lines: [] }, ...a(), t), codigo('ACCOUNTING_RETURN_VALIDATION'));

    const ok = await exportService.importAccountingReturn(batch.id, { batchHash: batch.batchHash, fileName: 'retorno.csv', lines: [linha] }, ...a(), t);
    assert.equal(ok.status, 'MATCHED');

    const ruim = await exportService.importAccountingReturn(batch.id, { batchHash: batch.batchHash, lines: [{ ...linha, amount: Number(e.amount) - 5 }] }, ...a(), t);
    assert.equal(ruim.status, 'DIVERGENT');
    const issues = (await recon.listReconciliations('OPEN', tenant.groupId, tenant.companyId, t)).filter((r) => r.reconciliationType === 'ACCOUNTING_RETURN_X_EXPORT' && r.referenceId === ruim.id);
    assert.equal(issues.length, 1);
    assert.equal(Number(issues[0].differenceAmount), 5);
    const { returns } = await exportService.getExportBatch(batch.id, tenant.groupId, tenant.companyId, t);
    assert.equal(returns.length, 2);
  });
});
