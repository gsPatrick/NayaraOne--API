'use strict';

// Marco 8 Fase 12 (addendum fiscal do Caderno Técnico) — adapter de NFS-e, MESMO espírito
// arquitetural de FinancingProviderAdapter.js (Fase 0): nenhum provedor real de NFS-e está
// contratado ainda, então o domínio só conhece esta interface determinística/sandbox. "Adapter
// versionado" (citação literal do Caderno) é satisfeito pelo campo `adapter_version` persistido
// em cada InvoiceRequest, não por múltiplas classes concorrentes — não há ainda um segundo
// provedor pra justificar um registry como o de financiamento (Fase 0).
//
// Máquina de estados: REQUESTED → SUBMITTED → AUTHORIZED/REJECTED/CANCELED. Determinístico por
// tempo decorrido desde a submissão, mesmo truque do SandboxFinancingProviderAdapter — permite
// observar a progressão num teste real sem mockar relógio.

const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const AUTHORIZE_THRESHOLD_MS = 1500;
// Só o sandbox: uma descrição com este marcador é recusada pelo emissor, para exercitar o estado REJECTED.
const SANDBOX_REJECT_MARKER = '[sandbox:rejeitar]';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reais(value) {
  if (!Number.isFinite(Number(value))) throw new Error('A nota não tem valor informado.');
  const [inteiro, centavos] = Number(value).toFixed(2).split('.');
  return `${inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${centavos}`;
}

function buildNfseXml({ officialNumber, verificationCode, amount, description, issuedAt, externalId, serviceCode, issRatePct, takerTaxId, takerName }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<NFSe versao="sandbox-v1">',
    `  <Numero>${escapeXml(officialNumber)}</Numero>`,
    `  <CodigoVerificacao>${escapeXml(verificationCode)}</CodigoVerificacao>`,
    `  <IdExterno>${escapeXml(externalId)}</IdExterno>`,
    `  <DataEmissao>${issuedAt.toISOString()}</DataEmissao>`,
    ...(takerTaxId || takerName ? ['  <Tomador>', `    <Documento>${escapeXml(takerTaxId)}</Documento>`, `    <Nome>${escapeXml(takerName)}</Nome>`, '  </Tomador>'] : []),
    '  <Servico>',
    ...(serviceCode ? [`    <ItemListaServico>${escapeXml(serviceCode)}</ItemListaServico>`] : []),
    ...(issRatePct ? [`    <AliquotaIss>${Number(issRatePct).toFixed(2)}</AliquotaIss>`] : []),
    `    <Discriminacao>${escapeXml(description)}</Discriminacao>`,
    `    <ValorServicos>${Number(amount).toFixed(2)}</ValorServicos>`,
    '  </Servico>',
    '</NFSe>',
    '',
  ].join('\n');
}

function buildNfsePdf({ officialNumber, verificationCode, amount, description, issuedAt, serviceCode, issRatePct }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(18).text('Nota Fiscal de Serviços Eletrônica (ambiente de teste)', { align: 'left' });
    doc.moveDown();
    doc.fontSize(11);
    doc.text(`Número: ${officialNumber}`);
    doc.text(`Código de verificação: ${verificationCode}`);
    doc.text(`Emitida em: ${issuedAt.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    doc.moveDown();
    doc.text(`Discriminação: ${description}`);
    doc.text(`Valor dos serviços: R$ ${reais(amount)}`);
    if (serviceCode) doc.text(`Código do serviço: ${serviceCode}`);
    if (issRatePct) doc.text(`Alíquota de ISS: ${String(Number(issRatePct).toFixed(2)).replace('.', ',')}%`);
    doc.moveDown();
    doc.fontSize(9).text('Documento gerado pelo emissor sandbox. Em produção, o XML e o PDF oficiais do município substituem este arquivo.');
    doc.end();
  });
}

// O sandbox lembra só do que aceitou desde que o processo subiu (e só de um número limitado de pedidos: o mapa
// não cresce sem fim). Em produção o emissor oficial guarda isso; este mapa nunca é usado fora do ambiente de teste.
const SANDBOX_REQUESTS = new Map();
const SANDBOX_DETAILS = new Map();
const SANDBOX_MAX_ENTRIES = 5000;

function remember(map, key, value) {
  map.set(key, value);
  if (map.size > SANDBOX_MAX_ENTRIES) map.delete(map.keys().next().value);
}

class SandboxNfseAdapter {
  version() {
    return 'sandbox-v1';
  }

  // Submete o pedido de nota ao "provedor" — nunca falha de propósito (determinístico), mas o
  // chamador ainda trata timeout/erro de rede como UNKNOWN (mesmo padrão de submissions.service.js
  // Fase 5), já que uma integração real poderia falhar nesse ponto.
  async requestInvoice(req) {
    // Idempotente pela chave: o mesmo pedido repetido (retry depois de uma queda) devolve a mesma nota, sem emitir outra.
    const known = req?.idempotencyKey ? SANDBOX_REQUESTS.get(String(req.idempotencyKey)) : null;
    if (known) return { externalId: known, status: 'SUBMITTED', raw: { sandbox: true, replayed: true } };
    const submittedAt = Date.now();
    const externalId = `nfse-sandbox-${String(req?.idempotencyKey || submittedAt).replace(/[^A-Za-z0-9]/g, '').slice(-24)}-${submittedAt}`;
    if (req?.idempotencyKey) remember(SANDBOX_REQUESTS, String(req.idempotencyKey), externalId);
    remember(SANDBOX_DETAILS, externalId, {
      serviceCode: req?.serviceCode || null,
      issRatePct: req?.issRatePct || null,
      takerTaxId: req?.takerTaxId || null,
      takerName: req?.takerName || null,
    });
    return { externalId, status: 'SUBMITTED', raw: { sandbox: true, submittedAt, req } };
  }

  // Consulta pela chave do pedido (o que um emissor real faz com a "referência do cliente"):
  // serve para resolver um pedido que ficou UNKNOWN sem id externo. O sandbox lembra só do que
  // aceitou desde que subiu; depois de um reinício responde "não encontrado".
  async findInvoiceByKey(idempotencyKey) {
    const externalId = SANDBOX_REQUESTS.get(String(idempotencyKey || ''));
    return externalId ? { found: true, externalId } : { found: false };
  }

  isSandbox() {
    return true;
  }

  async getInvoiceStatus(externalId, context = {}) {
    const match = /-(\d+)$/.exec(String(externalId || ''));
    const submittedAt = match ? Number(match[1]) : Date.now();
    const elapsed = Date.now() - submittedAt;
    const rejected = elapsed >= AUTHORIZE_THRESHOLD_MS && String(context.description || '').includes(SANDBOX_REJECT_MARKER);
    if (rejected) {
      return {
        externalId,
        status: 'REJECTED',
        rawProviderStatus: 'REJECTED',
        rejectionReason: 'Nota recusada pelo emissor de teste (marcador sandbox).',
        officialNumber: null,
        documents: null,
        raw: { sandbox: true, elapsedMs: elapsed },
      };
    }
    const status = elapsed >= AUTHORIZE_THRESHOLD_MS ? 'AUTHORIZED' : 'SUBMITTED';
    // Número oficial derivado de todo o identificador (não só dos últimos dígitos do relógio): não se repete.
    const officialNumber = status === 'AUTHORIZED' ? `NFSE-${crypto.createHash('sha256').update(String(externalId)).digest('hex').slice(0, 12).toUpperCase()}` : null;
    let documents = null;
    if (status === 'AUTHORIZED') {
      // Data de emissão fixa (momento em que o emissor autorizou): consultar de novo devolve o mesmo XML e PDF.
      const issuedAt = new Date(submittedAt + AUTHORIZE_THRESHOLD_MS);
      const verificationCode = crypto.createHash('sha256').update(`${externalId}:${officialNumber}`).digest('hex').slice(0, 12).toUpperCase();
      const data = { officialNumber, verificationCode, amount: context.amount, description: context.description, issuedAt, externalId, ...(SANDBOX_DETAILS.get(externalId) || {}) };
      documents = { xml: buildNfseXml(data), pdf: await buildNfsePdf(data), verificationCode, issuedAt };
    }
    return {
      externalId,
      status,
      rawProviderStatus: status,
      officialNumber,
      documents,
      raw: { sandbox: true, elapsedMs: elapsed },
    };
  }

  async cancelInvoice(externalId) {
    return { externalId, status: 'CANCELED', raw: { sandbox: true } };
  }
}

module.exports = { SandboxNfseAdapter, SANDBOX_REJECT_MARKER };
