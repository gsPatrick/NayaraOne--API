'use strict';

const { AiRun, InventoryItem, InventoryReceipt } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { uploadFile } = require('../files/files.service');
const { resolveAntivirusAdapter, resolveOcrAdapter } = require('../people/adapters/resolveDocumentAdapters');

/**
 * receiptOcr.service.js — OCR/IA assistivo na entrada por NF (Guia do Marcelo §6):
 *   "NF/foto armazenada em files; OCR/IA pode sugerir itens/quantidades/preços. Usuário confere
 *    antes de confirmar entrada."
 *
 * REUSO, não reinvenção: o pipeline "Upload -> malware scan -> hash -> OCR/IA -> sugestão ->
 * validação" já existe no projeto para documentos de pessoa (people/documentIngestion.service.js,
 * auditoria Marco 3). Este service usa EXATAMENTE os mesmos adapters plugáveis
 * (people/adapters/resolveDocumentAdapters.js -> AntivirusAdapter/OcrAdapter, duck-typed, mesmo
 * padrão dos adapters de Banco/Seguro/Assinatura). Quando um provedor real de OCR for
 * contratado, basta ligá-lo em resolveOcrAdapter — este fluxo não muda.
 *
 * HONESTIDADE DO ADAPTER: hoje resolveOcrAdapter só devolve o SandboxOcrAdapter (nenhum provedor
 * real contratado). O Sandbox NUNCA inventa dado: sem o marcador de teste no próprio arquivo, ele
 * responde "ilegível" — e aqui isso é reportado como status NOT_CONFIGURED (não "ilegível",
 * porque o problema não é o documento, é a falta de provedor). A resposta sempre diz
 * `provider` e `configured`, e a tela só mostra painel de sugestão quando `suggestion` vem
 * preenchida.
 *
 * NADA É GRAVADO COMO RECEBIMENTO AQUI: o service só armazena o arquivo (files) e devolve uma
 * sugestão estruturada. O recebimento continua nascendo de receipts.service.js#createReceipt,
 * chamado pelo usuário DEPOIS de conferir/editar os itens pré-preenchidos (DRAFT -> REVIEWED ->
 * COMPLETED, o mesmo fluxo de sempre). Nenhum saldo/custo muda por causa de OCR.
 */

const DOCUMENT_TYPE = 'INVOICE_NF';
const CONFIDENCE_THRESHOLD = 0.7;
const AGENT_NAME = 'NAY_ESTOQUE_OCR';

// Converte número vindo do OCR: aceita number ou string em formato BR ("1.234,56", "12,5") ou
// com ponto decimal ("1234.56"). Retorna null quando não dá pra interpretar — nunca chuta.
function parseOcrNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).trim().replace(/\s|R\$/g, '');
  if (!s) return null;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // Os dois separadores: o ÚLTIMO é o decimal ("1.234,56" BR ou "1,234.56" US).
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (hasComma) {
    if ((s.match(/,/g) || []).length > 1) return null;
    s = s.replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    // "1.234" / "12.500.000": ambíguo (milhar BR x decimal) — não chuta, devolve null.
    return null;
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function matchItem(line, catalog) {
  const sku = normalizeText(line.sku);
  if (sku) {
    const bySku = catalog.find((i) => normalizeText(i.sku) === sku);
    if (bySku) return { item: bySku, matchedBy: 'SKU' };
  }
  const description = normalizeText(line.description);
  if (description) {
    const byName = catalog.find((i) => normalizeText(i.name) === description);
    if (byName) return { item: byName, matchedBy: 'NAME' };
  }
  return { item: null, matchedBy: null };
}

async function buildSuggestion(fields, tenant, transaction) {
  const warnings = [];
  const rawLines = Array.isArray(fields.items) ? fields.items : [];
  const catalog = await InventoryItem.findAll({ where: { companyId: tenant.companyId, status: 'ACTIVE' }, transaction });

  const items = rawLines.map((raw, index) => {
    const line = raw && typeof raw === 'object' ? raw : {};
    const quantity = parseOcrNumber(line.quantity);
    const unitCost = parseOcrNumber(line.unitPrice ?? line.unitCost);
    const lineWarnings = [];
    if (quantity == null || quantity <= 0) lineWarnings.push('Quantidade não identificada com segurança — preencha manualmente.');
    if (unitCost == null || unitCost < 0) lineWarnings.push('Preço unitário não identificado com segurança — preencha manualmente.');
    const { item, matchedBy } = matchItem(line, catalog);
    if (!item) lineWarnings.push('Item da NF não corresponde a nenhum item cadastrado (por SKU ou nome) — selecione manualmente.');
    return {
      lineNumber: index + 1,
      description: line.description != null ? String(line.description) : null,
      sku: line.sku != null ? String(line.sku) : null,
      // Nunca "corrige" o valor lido: inválido vira null, nunca um número inventado.
      quantity: quantity != null && quantity > 0 ? quantity : null,
      unitCost: unitCost != null && unitCost >= 0 ? unitCost : null,
      inventoryItemId: item ? item.id : null,
      inventoryItemName: item ? item.name : null,
      matchedBy,
      warnings: lineWarnings,
    };
  });

  if (items.length === 0) warnings.push('Nenhum item foi identificado na nota — preencha os itens manualmente.');

  const invoiceFingerprint = fields.accessKey ? String(fields.accessKey).replace(/\D/g, '') || null : fields.invoiceFingerprint ? String(fields.invoiceFingerprint) : null;
  let duplicateReceiptId = null;
  if (invoiceFingerprint) {
    const existing = await InventoryReceipt.findOne({ where: { companyId: tenant.companyId, invoiceFingerprint }, transaction });
    if (existing) {
      duplicateReceiptId = existing.id;
      warnings.push(`Já existe um recebimento (${existing.id}) com esta mesma nota fiscal — confirmar a entrada de novo será bloqueado (EST-TS-08).`);
    }
  }

  const totalAmount = parseOcrNumber(fields.totalAmount);
  const linesTotal = items.every((l) => l.quantity != null && l.unitCost != null)
    ? Math.round(items.reduce((s, l) => s + l.quantity * l.unitCost, 0) * 100) / 100
    : null;
  if (totalAmount != null && linesTotal != null && Math.abs(totalAmount - linesTotal) > 0.01) {
    warnings.push(`Soma dos itens (${linesTotal}) difere do total lido na NF (${totalAmount}) — confira quantidades e preços.`);
  }

  return {
    suggestion: {
      invoiceNumber: fields.invoiceNumber != null ? String(fields.invoiceNumber) : null,
      invoiceFingerprint,
      supplierName: fields.supplierName != null ? String(fields.supplierName) : null,
      supplierTaxId: fields.supplierTaxId != null ? String(fields.supplierTaxId) : null,
      issuedAt: fields.issuedAt != null ? String(fields.issuedAt) : null,
      totalAmount,
      linesTotal,
      duplicateReceiptId,
      items,
    },
    warnings,
  };
}

async function suggestReceiptFromInvoice(payload, actorUserId, transaction) {
  const { groupId, companyId, fileName, mimeType, contentBase64 } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'INVENTORY_RECEIPT_OCR_VALIDATION');
  }
  if (!fileName || !contentBase64) {
    throw AppError.badRequest('Envie o arquivo da NF ("fileName", "mimeType" e "contentBase64").', 'INVENTORY_RECEIPT_OCR_VALIDATION');
  }
  const buffer = Buffer.from(String(contentBase64), 'base64');
  if (buffer.length === 0) {
    throw AppError.badRequest('O arquivo enviado está vazio.', 'INVENTORY_RECEIPT_OCR_VALIDATION');
  }
  const tenant = { groupId, companyId };

  // 1. Malware scan ANTES de persistir qualquer coisa (mesma ordem de documentIngestion).
  const antivirus = await resolveAntivirusAdapter(tenant, transaction);
  const scan = await antivirus.scan(buffer);
  if (!scan.clean) {
    throw AppError.unprocessable('Arquivo rejeitado pelo antivírus: assinatura de malware detectada.', 'INVENTORY_RECEIPT_OCR_MALWARE_DETECTED', { signature: scan.signature });
  }

  // 2. Upload + hash — "NF/foto armazenada em files" (files.service valida tipo/tamanho e
  // calcula checksum_sha256). O fileId volta pro form como invoiceFileId do recebimento.
  const file = await uploadFile({ groupId, companyId, fileName, mimeType, contentBase64, category: 'inventory-invoices' }, actorUserId, transaction);

  // 3. OCR/IA pelo adapter plugável compartilhado.
  const ocr = await resolveOcrAdapter(tenant, transaction);
  const extraction = await ocr.extract(buffer, DOCUMENT_TYPE);
  const isSandbox = Boolean(extraction?.raw?.sandbox);
  const provider = isSandbox ? 'SANDBOX' : String(extraction?.raw?.provider || ocr.constructor?.name || 'UNKNOWN');
  const confidence = typeof extraction?.confidence === 'number' ? extraction.confidence : 0;

  let status;
  let message;
  let suggestion = null;
  let warnings = [];

  if (extraction?.illegible) {
    if (isSandbox) {
      status = 'NOT_CONFIGURED';
      message = 'Nenhum provedor de OCR/IA está configurado. A NF foi anexada ao recebimento; preencha os itens manualmente.';
    } else {
      status = 'ILLEGIBLE';
      message = 'O OCR/IA não conseguiu ler a nota. A NF foi anexada; preencha os itens manualmente.';
    }
  } else {
    const built = await buildSuggestion(extraction.fields || {}, tenant, transaction);
    suggestion = built.suggestion;
    warnings = built.warnings;
    if (confidence < CONFIDENCE_THRESHOLD) {
      status = 'LOW_CONFIDENCE';
      warnings.unshift(`Confiança da leitura (${confidence}) abaixo de ${CONFIDENCE_THRESHOLD} — revise cada campo com atenção.`);
    } else {
      status = 'SUGGESTED';
    }
    if (isSandbox) {
      warnings.unshift('Sugestão gerada pelo adaptador SANDBOX (ambiente de teste), não por um provedor real de OCR.');
    }
    message = 'Sugestão de itens gerada a partir da NF. Confira e ajuste antes de criar o recebimento.';
  }

  const aiRun = await AiRun.create(
    {
      groupId,
      companyId,
      userId: actorUserId || null,
      agentName: AGENT_NAME,
      inputSummary: `OCR/IA de NF de entrada — arquivo ${file.id} (${fileName}).`,
      toolCallsJson: { documentType: DOCUMENT_TYPE, provider, configured: !isSandbox, confidence, illegible: Boolean(extraction?.illegible), fileId: file.id },
      outputSummary: `${status}: ${suggestion ? suggestion.items.length : 0} item(ns) sugerido(s). Nenhum recebimento criado — confirmação humana obrigatória.`,
      status: 'COMPLETED',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'INVENTORY_RECEIPT_OCR_SUGGESTED',
      entityType: 'File',
      entityId: file.id,
      reason: `OCR/IA de NF (${provider}): ${status}. Nada foi lançado no estoque.`,
    },
    transaction
  );

  return {
    status,
    message,
    provider,
    configured: !isSandbox,
    confidence,
    invoiceFileId: file.id,
    file: { id: file.id, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes, checksumSha256: file.checksumSha256 },
    aiRunId: aiRun.id,
    suggestion,
    warnings,
    requiresHumanReview: true,
    decisionsMade: [],
  };
}

module.exports = { suggestReceiptFromInvoice, parseOcrNumber, CONFIDENCE_THRESHOLD, DOCUMENT_TYPE };
