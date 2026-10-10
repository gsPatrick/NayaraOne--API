'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const itemsService = require('../src/features/inventory/items.service');
const receiptsService = require('../src/features/inventory/receipts.service');
const movementsService = require('../src/features/inventory/movements.service');
const receiptOcr = require('../src/features/inventory/receiptOcr.service');
const { MOCK_MARKER } = require('../src/features/people/adapters/OcrAdapter');
const { EICAR_SIGNATURE } = require('../src/features/people/adapters/AntivirusAdapter');
const { File, InventoryReceipt, AiRun } = require('../src/models');
const AppError = require('../src/utils/AppError');

// Guia do Marcelo §6: "NF/foto armazenada em files; OCR/IA pode sugerir itens/quantidades/
// preços. Usuário confere antes de confirmar entrada."

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

function invoicePayload(content, fileName = 'nf-entrada.pdf') {
  return withTenant({ fileName, mimeType: 'application/pdf', contentBase64: Buffer.from(content).toString('base64') });
}

// Arquivo "lido" pelo SandboxOcrAdapter: o marcador de teste vem DENTRO do próprio arquivo — é
// o mecanismo determinístico já usado em people.documentIngestion.test.js, não um dado inventado
// pelo sistema.
function sandboxInvoice(fields, confidence = 0.93) {
  return JSON.stringify({ [MOCK_MARKER]: { fields, confidence } });
}

async function countReceipts(transaction) {
  return InventoryReceipt.count({ transaction });
}

test('OCR NF (parser): números BR/ponto são lidos; lixo vira null em vez de chute', () => {
  assert.equal(receiptOcr.parseOcrNumber('1.234,56'), 1234.56);
  assert.equal(receiptOcr.parseOcrNumber('12,5'), 12.5);
  assert.equal(receiptOcr.parseOcrNumber('R$ 10,00'), 10);
  assert.equal(receiptOcr.parseOcrNumber(7), 7);
  assert.equal(receiptOcr.parseOcrNumber('3.5'), 3.5);
  assert.equal(receiptOcr.parseOcrNumber('1,234.56'), 1234.56);
  assert.equal(receiptOcr.parseOcrNumber('1.234'), null, 'ambíguo (milhar BR x decimal) não é chutado');
  assert.equal(receiptOcr.parseOcrNumber('abc'), null);
  assert.equal(receiptOcr.parseOcrNumber(''), null);
  assert.equal(receiptOcr.parseOcrNumber(null), null);
});

test('OCR NF: sem provedor real configurado o adapter diz NOT_CONFIGURED, anexa a NF e NÃO inventa itens', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const receiptsBefore = await countReceipts(transaction);
    const result = await receiptOcr.suggestReceiptFromInvoice(invoicePayload('%PDF-1.4 nota fiscal escaneada sem provedor de OCR'), tenant.userId, transaction);

    assert.equal(result.status, 'NOT_CONFIGURED');
    assert.equal(result.provider, 'SANDBOX');
    assert.equal(result.configured, false);
    assert.equal(result.suggestion, null, 'sem OCR real nenhum item/quantidade/preço pode ser fabricado');
    assert.equal(result.requiresHumanReview, true);
    assert.deepEqual(result.decisionsMade, []);

    // "NF/foto armazenada em files"
    const file = await File.findByPk(result.invoiceFileId, { transaction });
    assert.ok(file);
    assert.equal(file.checksumSha256, result.file.checksumSha256);

    const run = await AiRun.findByPk(result.aiRunId, { transaction });
    assert.equal(run.agentName, 'NAY_ESTOQUE_OCR');
    assert.equal(run.toolCallsJson.configured, false);

    assert.equal(await countReceipts(transaction), receiptsBefore, 'OCR nunca cria recebimento');
  });
});

test('OCR NF: sugestão estruturada casa itens por SKU/nome, marca o que não leu, e só vira recebimento quando o usuário cria (DRAFT) e confirma', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const cimento = await itemsService.createItem(withTenant({ name: `Cimento OCR ${suffix}`, sku: `CIM-${suffix}`, unitOfMeasure: 'SC' }), tenant.userId, transaction);
    const areia = await itemsService.createItem(withTenant({ name: `Areia Média OCR ${suffix}`, sku: `ARE-${suffix}`, unitOfMeasure: 'M3' }), tenant.userId, transaction);
    const warehouse = await itemsService.createLocation(withTenant({ name: `OCR Almox ${suffix}`, locationType: 'WAREHOUSE' }), tenant.userId, transaction);

    const receiptsBefore = await countReceipts(transaction);
    const accessKey = `3526 1000 0000 0000 0000 5500 1000 0000 1${String(Date.now()).slice(-9)}`;
    const result = await receiptOcr.suggestReceiptFromInvoice(
      invoicePayload(
        sandboxInvoice({
          invoiceNumber: '000123',
          accessKey,
          supplierName: 'Casa do Construtor LTDA',
          totalAmount: '1.000,00',
          items: [
            { sku: cimento.sku.toLowerCase(), description: 'CIMENTO CP-II 50KG', quantity: '20', unitPrice: '35,50' },
            { description: `areia media ocr ${suffix}`, quantity: 4.5, unitPrice: 60 },
            { description: 'Item que não existe no cadastro', quantity: 'ilegível', unitPrice: null },
          ],
        })
      ),
      tenant.userId,
      transaction
    );

    assert.equal(result.status, 'SUGGESTED');
    assert.equal(result.provider, 'SANDBOX');
    assert.equal(result.configured, false, 'o sandbox nunca se apresenta como provedor real');
    assert.ok(result.warnings.some((w) => /SANDBOX/.test(w)));
    const { suggestion } = result;
    assert.equal(suggestion.invoiceNumber, '000123');
    assert.equal(suggestion.invoiceFingerprint, accessKey.replace(/\D/g, ''));
    assert.equal(suggestion.items.length, 3);

    const [l1, l2, l3] = suggestion.items;
    assert.equal(l1.inventoryItemId, cimento.id);
    assert.equal(l1.matchedBy, 'SKU');
    assert.equal(l1.quantity, 20);
    assert.equal(l1.unitCost, 35.5);
    assert.equal(l2.inventoryItemId, areia.id);
    assert.equal(l2.matchedBy, 'NAME');
    assert.equal(l2.quantity, 4.5);
    assert.equal(l3.inventoryItemId, null);
    assert.equal(l3.quantity, null, 'quantidade ilegível vira null, nunca um número inventado');
    assert.equal(l3.unitCost, null);
    assert.ok(l3.warnings.length >= 2);

    // Nada lançado ainda.
    assert.equal(await countReceipts(transaction), receiptsBefore);
    const balancesBefore = await movementsService.listBalancesByItem(cimento.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(balancesBefore.filter((b) => Number(b.quantityOnHand) !== 0).length, 0, 'sugestão de OCR não mexe em saldo');

    // Usuário confere/edita (corrige a quantidade do cimento, descarta a linha não reconhecida)
    // e cria o recebimento com a NF anexada.
    const receipt = await receiptsService.createReceipt(
      withTenant({
        destinationLocationId: warehouse.id,
        invoiceNumber: suggestion.invoiceNumber,
        invoiceFingerprint: suggestion.invoiceFingerprint,
        invoiceFileId: result.invoiceFileId,
        notes: `Itens pré-preenchidos por OCR/IA (execução ${result.aiRunId}) e conferidos pelo usuário.`,
        items: [
          { inventoryItemId: l1.inventoryItemId, quantity: 19, unitCost: l1.unitCost },
          { inventoryItemId: l2.inventoryItemId, quantity: l2.quantity, unitCost: l2.unitCost },
        ],
      }),
      tenant.userId,
      transaction
    );
    assert.equal(receipt.status, 'DRAFT');
    assert.equal(receipt.invoiceFileId, result.invoiceFileId);
    assert.equal(Number(receipt.items.find((i) => i.inventoryItemId === cimento.id).quantity), 19, 'vale o que o usuário conferiu, não o que o OCR leu');

    await receiptsService.reviewReceipt(receipt.id, tenant.userId, tenant.groupId, tenant.companyId, transaction);
    await receiptsService.confirmReceipt(receipt.id, { userId: tenant.userId, canApprove: true }, tenant.groupId, tenant.companyId, transaction);
    const balances = await movementsService.listBalancesByItem(cimento.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(Number(balances.find((b) => b.locationId === warehouse.id).quantityOnHand), 19);

    // Reenviar a mesma NF: a sugestão avisa a duplicidade (e o createReceipt continua bloqueando).
    const again = await receiptOcr.suggestReceiptFromInvoice(
      invoicePayload(sandboxInvoice({ accessKey, items: [{ sku: cimento.sku, quantity: 20, unitPrice: 35.5 }] }), 'nf-entrada-2.pdf'),
      tenant.userId,
      transaction
    );
    assert.equal(again.suggestion.duplicateReceiptId, receipt.id);
    assert.ok(again.warnings.some((w) => /Já existe um recebimento/.test(w)));
  });
});

test('OCR NF: leitura com confiança baixa é sinalizada como LOW_CONFIDENCE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const result = await receiptOcr.suggestReceiptFromInvoice(
      invoicePayload(sandboxInvoice({ items: [{ description: 'Brita 1', quantity: 2, unitPrice: 80 }] }, 0.4)),
      tenant.userId,
      transaction
    );
    assert.equal(result.status, 'LOW_CONFIDENCE');
    assert.ok(result.warnings.some((w) => /Confiança/.test(w)));
    assert.equal(result.suggestion.items[0].inventoryItemId, null);
  });
});

test('OCR NF: arquivo infectado é barrado ANTES de ser armazenado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const filesBefore = await File.count({ transaction });
    await assert.rejects(
      () => receiptOcr.suggestReceiptFromInvoice(invoicePayload(EICAR_SIGNATURE), tenant.userId, transaction),
      (err) => err instanceof AppError && err.code === 'INVENTORY_RECEIPT_OCR_MALWARE_DETECTED'
    );
    assert.equal(await File.count({ transaction }), filesBefore);
  });
});

test('OCR NF: tipo de arquivo fora da allowlist de files é recusado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => receiptOcr.suggestReceiptFromInvoice(withTenant({ fileName: 'nf.html', mimeType: 'text/html', contentBase64: Buffer.from('<script>x</script>').toString('base64') }), tenant.userId, transaction),
      (err) => err instanceof AppError && err.code === 'FILE_UPLOAD_TYPE_NOT_ALLOWED'
    );
    await assert.rejects(
      () => receiptOcr.suggestReceiptFromInvoice(withTenant({ fileName: 'nf.pdf', mimeType: 'application/pdf' }), tenant.userId, transaction),
      (err) => err instanceof AppError && err.code === 'INVENTORY_RECEIPT_OCR_VALIDATION'
    );
  });
});
