'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const nfseService = require('../src/features/correspondent/fiscal/nfse.service');
const dimobService = require('../src/features/correspondent/fiscal/dimob.service');
const reconciliationService = require('../src/features/correspondent/fiscal/reconciliation.service');
const exportService = require('../src/features/correspondent/fiscal/accountingExport.service');
const { InvoiceRequest } = require('../src/models');

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
