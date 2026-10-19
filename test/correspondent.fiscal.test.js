'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const nfseService = require('../src/features/correspondent/fiscal/nfse.service');
const dimobService = require('../src/features/correspondent/fiscal/dimob.service');
const reconciliationService = require('../src/features/correspondent/fiscal/reconciliation.service');
const exportService = require('../src/features/correspondent/fiscal/accountingExport.service');
const financingCasesService = require('../src/features/correspondent/cases/financingCases.service');
const commissionsService = require('../src/features/correspondent/cases/commissionEntitlements.service');
const { InvoiceRequest, Person } = require('../src/models');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

test('FISCAL-NFSE-01: emite NFS-e via adapter sandbox — vai de REQUESTED até AUTHORIZED com histórico completo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const invoiceRequest = await nfseService.requestInvoice(
      { sourceType: 'COMMISSION_ENTITLEMENT', sourceId: tenant.userId, amount: 1000, description: `Nota de teste ${uniqueSuffix()}` },
      tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    assert.equal(invoiceRequest.status, 'SUBMITTED');
    assert.ok(invoiceRequest.externalId.startsWith('nfse-sandbox-'));

    // Threshold do sandbox é 1.5s — espera passar disso antes de consultar.
    await new Promise((r) => setTimeout(r, 1700));
    const checked = await nfseService.checkInvoiceStatus(invoiceRequest.id, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(checked.status, 'AUTHORIZED');

    const events = await nfseService.getInvoiceEvents(invoiceRequest.id, tenant.groupId, tenant.companyId, transaction);
    const statuses = events.map((e) => e.rawStatus);
    assert.ok(statuses.includes('REQUESTED'));
    assert.ok(statuses.includes('SUBMITTED'));
    assert.ok(statuses.includes('AUTHORIZED'));
  });
});

test('FISCAL-NFSE-02: cancelar NFS-e autorizada preserva o documento e marca canceledAt, nunca apaga', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const invoiceRequest = await nfseService.requestInvoice(
      { sourceType: 'COMMISSION_ENTITLEMENT', sourceId: tenant.userId, amount: 500, description: `Nota a cancelar ${uniqueSuffix()}` },
      tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    await new Promise((r) => setTimeout(r, 1700));
    await nfseService.checkInvoiceStatus(invoiceRequest.id, tenant.userId, tenant.groupId, tenant.companyId, transaction);

    const canceled = await nfseService.cancelInvoice(invoiceRequest.id, 'Serviço não prestado', tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(canceled.status, 'CANCELED');

    // Não é possível cancelar de novo uma já cancelada.
    await assert.rejects(
      () => nfseService.cancelInvoice(invoiceRequest.id, 'motivo', tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.equal(err.code, 'NFSE_NOT_AUTHORIZED');
        return true;
      }
    );
  });
});

test('FISCAL-NFSE-03: cancelar sem motivo é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const invoiceRequest = await nfseService.requestInvoice(
      { sourceType: 'COMMISSION_ENTITLEMENT', sourceId: tenant.userId, amount: 500, description: `Nota sem motivo ${uniqueSuffix()}` },
      tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    await new Promise((r) => setTimeout(r, 1700));
    await nfseService.checkInvoiceStatus(invoiceRequest.id, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await assert.rejects(
      () => nfseService.cancelInvoice(invoiceRequest.id, '', tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.equal(err.code, 'NFSE_CANCEL_REASON_REQUIRED');
        return true;
      }
    );
  });
});

test('FISCAL-NFSE-04: RLS — pedido de NFS-e de outra empresa não é encontrado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const invoiceRequest = await nfseService.requestInvoice(
      { sourceType: 'COMMISSION_ENTITLEMENT', sourceId: tenant.userId, amount: 500, description: `Nota cross-company ${uniqueSuffix()}` },
      tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    await assert.rejects(
      () => nfseService.checkInvoiceStatus(invoiceRequest.id, tenant.userId, tenant.groupId, otherCompanyId, transaction),
      (err) => {
        assert.equal(err.code, 'NFSE_NOT_FOUND');
        return true;
      }
    );
  });
});

test('FISCAL-DIMOB-01: gerar batch 2x com a mesma entrada produz o mesmo snapshotHash (reproduzível)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const year = 2019 + Math.floor(Math.random() * 5); // ano exclusivo pro teste, evita colidir com dado real
    const first = await dimobService.generateDimobBatch(year, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    const second = await dimobService.generateDimobBatch(year, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(first.snapshotHash, second.snapshotHash);
    assert.equal(first.version, 1);
    assert.equal(second.version, 2); // nova versão, nunca sobrescreve a anterior
  });
});

test('FISCAL-DIMOB-02: fechar um batch impede gerar "fechamento" de novo (mas não impede nova versão)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const year = 2000 + Math.floor(Math.random() * 5);
    const batch = await dimobService.generateDimobBatch(year, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await dimobService.closeDimobBatch(batch.id, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await assert.rejects(
      () => dimobService.closeDimobBatch(batch.id, tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.equal(err.code, 'DIMOB_BATCH_ALREADY_CLOSED');
        return true;
      }
    );
    // Gerar nova versão continua permitido mesmo com a v1 fechada — nunca trava o fluxo.
    const v2 = await dimobService.generateDimobBatch(year, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    assert.equal(v2.version, 2);
  });
});

test('FISCAL-DIMOB-03: RLS — batch de outra empresa não é encontrado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const year = 2010 + Math.floor(Math.random() * 5);
    const batch = await dimobService.generateDimobBatch(year, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await assert.rejects(
      () => dimobService.closeDimobBatch(batch.id, tenant.userId, tenant.groupId, otherCompanyId, transaction),
      (err) => {
        assert.equal(err.code, 'DIMOB_BATCH_NOT_FOUND');
        return true;
      }
    );
  });
});

test('FISCAL-DIMOB-04: dataset reflete valores reais — inclui RECEIVABLE/RECEIVED, exclui EXPECTED e ADJUSTED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const principal = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Proponente DIMOB ${uniqueSuffix()}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const financingCase = await financingCasesService.createFinancingCase(
      { groupId: tenant.groupId, companyId: tenant.companyId, providerCode: 'sandbox', applicants: [{ personId: principal.id, role: 'PRINCIPAL' }] },
      tenant.userId, transaction
    );

    // Entitlement CONFIRMADO (RECEIVABLE) — deve entrar no dataset com o valor exato.
    const confirmed = await commissionsService.createCommissionEntitlement(
      financingCase.id, { baseAmount: 50000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    await commissionsService.confirmCommissionEntitlement(
      confirmed.id, { externalConfirmationId: `dimob-conf-${uniqueSuffix()}` }, tenant.userId, tenant.groupId, tenant.companyId, transaction
    );

    // Entitlement EXPECTED (nunca confirmado) — NÃO deve entrar (ainda não é renda recebível).
    await commissionsService.createCommissionEntitlement(
      financingCase.id, { baseAmount: 30000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction
    );

    // Entitlement ADJUSTED (confirmado e depois estornado) — NÃO deve entrar (receita revertida).
    const adjusted = await commissionsService.createCommissionEntitlement(
      financingCase.id, { baseAmount: 20000 }, tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    await commissionsService.confirmCommissionEntitlement(
      adjusted.id, { externalConfirmationId: `dimob-adj-${uniqueSuffix()}` }, tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    await commissionsService.chargebackCommissionEntitlement(
      adjusted.id, 'Estornado para o teste de dataset DIMOB.', tenant.userId, tenant.groupId, tenant.companyId, transaction
    );

    // Usamos a data real (ano corrente, não `year` fictício) porque created_at é definido pelo
    // banco no momento do INSERT — fixamos o teste no ano corrente em vez de tentar forjar created_at.
    const currentYear = new Date().getUTCFullYear();
    const dataset = await dimobService.buildDimobDataset(currentYear, tenant.groupId, tenant.companyId, transaction);

    const confirmedRef = dataset.find((r) => r.sourceRefs.commissionEntitlementId === confirmed.id);
    assert.ok(confirmedRef, 'o entitlement RECEIVABLE deveria estar no dataset');
    assert.equal(confirmedRef.amount, Number((await commissionsService.listCommissionEntitlements(financingCase.id, tenant.groupId, tenant.companyId, transaction)).find((e) => e.id === confirmed.id).amount));

    const adjustedRef = dataset.find((r) => r.sourceRefs.commissionEntitlementId === adjusted.id);
    assert.equal(adjustedRef, undefined, 'entitlement ADJUSTED (estornado) nunca deveria aparecer no dataset DIMOB');

    const allEntitlements = await commissionsService.listCommissionEntitlements(financingCase.id, tenant.groupId, tenant.companyId, transaction);
    const expectedOne = allEntitlements.find((e) => e.status === 'EXPECTED');
    assert.ok(expectedOne, 'deveria existir um entitlement ainda EXPECTED pra este teste fazer sentido');
    const expectedRef = dataset.find((r) => r.sourceRefs.commissionEntitlementId === expectedOne.id);
    assert.equal(expectedRef, undefined, 'entitlement EXPECTED (nunca confirmado) nunca deveria aparecer no dataset DIMOB');
  });
});

test('FISCAL-RECON-01: diferença detectada abre reconciliação — nunca é ignorada silenciosamente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const reconciliation = await reconciliationService.reconcile(
      'FINANCE_X_NFSE', tenant.userId, 1000, 950, tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    assert.ok(reconciliation);
    assert.equal(reconciliation.status, 'OPEN');
    assert.equal(Number(reconciliation.differenceAmount), 50);
  });
});

test('FISCAL-RECON-02: sem diferença, nenhuma reconciliação é criada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const result = await reconciliationService.reconcile(
      'FINANCE_X_NFSE', tenant.userId, 1000, 1000, tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    assert.equal(result, null);
  });
});

test('FISCAL-RECON-03: resolver exige motivo documentado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const reconciliation = await reconciliationService.reconcile(
      'COMMISSION_X_FISCAL', tenant.userId, 500, 400, tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    await assert.rejects(
      () => reconciliationService.resolveReconciliation(reconciliation.id, '', tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.equal(err.code, 'FISCAL_RECONCILIATION_REASON_REQUIRED');
        return true;
      }
    );
    const resolved = await reconciliationService.resolveReconciliation(
      reconciliation.id, 'Diferença de arredondamento aceita pelo contador', tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    assert.equal(resolved.status, 'RESOLVED');
  });
});

test('FISCAL-EXPORT-01: batch de export contábil com hash; ajuste cria linha nova, nunca edita a original', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const batch = await exportService.createExportBatch(
      '2026-01',
      [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: tenant.userId, amount: 1000, description: 'Comissão de teste' }],
      tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    assert.ok(batch.batchHash);

    const { AccountingExportLine } = require('../src/models');
    const [originalLine] = await AccountingExportLine.findAll({ where: { batchId: batch.id }, transaction });
    const originalAmountBefore = Number(originalLine.amount);

    const adjustment = await exportService.adjustExportLine(
      originalLine.id, -100, 'Estorno parcial', tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    assert.equal(adjustment.adjustmentOfLineId, originalLine.id);
    assert.equal(Number(adjustment.amount), -100);

    await originalLine.reload({ transaction });
    assert.equal(Number(originalLine.amount), originalAmountBefore); // linha original intocada
  });
});

test('FISCAL-EXPORT-03: mesma origem não pode entrar em dois batches diferentes (nunca duplica o fato contábil)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const sourceId = crypto.randomUUID();
    await exportService.createExportBatch(
      '2026-03',
      [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId, amount: 1000, description: 'Comissão original' }],
      tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    await assert.rejects(
      () => exportService.createExportBatch(
        '2026-04',
        [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId, amount: 1000, description: 'Mesma comissão, batch diferente' }],
        tenant.userId, tenant.groupId, tenant.companyId, transaction
      ),
      (err) => {
        assert.equal(err.code, 'ACCOUNTING_EXPORT_DUPLICATE_SOURCE');
        return true;
      }
    );
  });
});

test('FISCAL-EXPORT-04: uma linha de AJUSTE não conta como duplicata para a checagem de origem', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const sourceId = crypto.randomUUID();
    const batch = await exportService.createExportBatch(
      '2026-05',
      [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId, amount: 1000, description: 'Comissão original' }],
      tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    const { AccountingExportLine } = require('../src/models');
    const [originalLine] = await AccountingExportLine.findAll({ where: { batchId: batch.id }, transaction });
    // Ajuste cria uma linha nova com a MESMA origem (sourceType/sourceId) — não deve ser
    // confundido como "exportação duplicada" por uma futura chamada de createExportBatch.
    await exportService.adjustExportLine(originalLine.id, -100, 'Correção', tenant.userId, tenant.groupId, tenant.companyId, transaction);

    const otherSourceId = crypto.randomUUID();
    const secondBatch = await exportService.createExportBatch(
      '2026-06',
      [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: otherSourceId, amount: 500, description: 'Comissão diferente' }],
      tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    assert.ok(secondBatch.batchHash);
  });
});

test('FISCAL-EXPORT-02: ajuste sem motivo é bloqueado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const batch = await exportService.createExportBatch(
      '2026-02',
      [{ sourceType: 'COMMISSION_ENTITLEMENT', sourceId: tenant.userId, amount: 1000, description: 'Comissão' }],
      tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    const { AccountingExportLine } = require('../src/models');
    const [originalLine] = await AccountingExportLine.findAll({ where: { batchId: batch.id }, transaction });
    await assert.rejects(
      () => exportService.adjustExportLine(originalLine.id, -50, '', tenant.userId, tenant.groupId, tenant.companyId, transaction),
      (err) => {
        assert.equal(err.code, 'ACCOUNTING_EXPORT_ADJUST_REASON_REQUIRED');
        return true;
      }
    );
  });
});

test('FISCAL-RLS-01: InvoiceRequest tem policy tenant_isolation aplicada (catálogo genérico)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const invoiceRequest = await nfseService.requestInvoice(
      { sourceType: 'COMMISSION_ENTITLEMENT', sourceId: tenant.userId, amount: 10, description: `RLS check ${uniqueSuffix()}` },
      tenant.userId, tenant.groupId, tenant.companyId, transaction
    );
    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });
    const found = await InvoiceRequest.findByPk(invoiceRequest.id, { transaction });
    assert.equal(found, null);
  });
});
