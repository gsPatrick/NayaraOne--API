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
  const [inteiro, centavos] = Number(value).toFixed(2).split('.');
  return `${inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${centavos}`;
}

function buildNfseXml({ officialNumber, verificationCode, amount, description, issuedAt, externalId }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<NFSe versao="sandbox-v1">',
    `  <Numero>${escapeXml(officialNumber)}</Numero>`,
    `  <CodigoVerificacao>${escapeXml(verificationCode)}</CodigoVerificacao>`,
    `  <IdExterno>${escapeXml(externalId)}</IdExterno>`,
    `  <DataEmissao>${issuedAt.toISOString()}</DataEmissao>`,
    '  <Servico>',
    `    <Discriminacao>${escapeXml(description)}</Discriminacao>`,
    `    <ValorServicos>${Number(amount).toFixed(2)}</ValorServicos>`,
    '  </Servico>',
    '</NFSe>',
    '',
  ].join('\n');
}

function buildNfsePdf({ officialNumber, verificationCode, amount, description, issuedAt }) {
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
    doc.moveDown();
    doc.fontSize(9).text('Documento gerado pelo emissor sandbox. Em produção, o XML e o PDF oficiais do município substituem este arquivo.');
    doc.end();
  });
}

class SandboxNfseAdapter {
  version() {
    return 'sandbox-v1';
  }

  // Submete o pedido de nota ao "provedor" — nunca falha de propósito (determinístico), mas o
  // chamador ainda trata timeout/erro de rede como UNKNOWN (mesmo padrão de submissions.service.js
  // Fase 5), já que uma integração real poderia falhar nesse ponto.
  async requestInvoice(req) {
    const submittedAt = Date.now();
    const externalId = `nfse-sandbox-${req?.idempotencyKey || submittedAt}-${submittedAt}`;
    return { externalId, status: 'SUBMITTED', raw: { sandbox: true, submittedAt, req } };
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
    const officialNumber = status === 'AUTHORIZED' ? `NFSE-${externalId.slice(-8)}` : null;
    let documents = null;
    if (status === 'AUTHORIZED') {
      const issuedAt = new Date();
      const verificationCode = crypto.createHash('sha256').update(`${externalId}:${officialNumber}`).digest('hex').slice(0, 12).toUpperCase();
      const data = { officialNumber, verificationCode, amount: context.amount, description: context.description, issuedAt, externalId };
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
