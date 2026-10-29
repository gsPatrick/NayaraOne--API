'use strict';

const { resolveOcrAdapter } = require('../../../people/adapters/resolveDocumentAdapters');

/**
 * Extração de campos (M9-D040) pelo OCR do projeto (o mesmo adapter dos documentos de pessoa e da nota de estoque). Devolve uma
 * `ProposedExtraction`: cada campo com valor em texto, confiança e fonte (arquivo e página); NADA é gravado e a confirmação humana é
 * sempre exigida. Documento ilegível vira pendência (nenhum campo inventado). Valor em reais sai com duas casas ("1250.00").
 */
const MONEY_FIELD = /(valor|total|renda|income|amount|preco|price|salario)/i;

function textValue(name, value) {
  if (typeof value === 'number' && Number.isFinite(value)) return MONEY_FIELD.test(name) || !Number.isInteger(value) ? value.toFixed(2) : String(value);
  return value === null || value === undefined ? '' : String(value);
}

const clamp = (n) => Math.min(1, Math.max(0, Number.isFinite(Number(n)) ? Number(n) : 0));
const round2 = (n) => Math.round(n * 100) / 100;

async function extractFields({ file, buffer, documentType, typeSource, minConfidence }, scope, transaction) {
  const adapter = await resolveOcrAdapter({ groupId: scope.groupId, companyId: scope.companyId }, transaction);
  const out = await adapter.extract(buffer, documentType);
  const raw = out.raw || {};
  const positions = raw.positions || {};
  const perField = raw.fieldConfidence || {};
  const overall = round2(clamp(out.confidence));
  const illegible = out.illegible === true;
  const fields = illegible ? [] : Object.entries(out.fields || {}).map(([name, value]) => ({
    name, value: textValue(name, value), confidence: round2(clamp(perField[name] === undefined ? overall : perField[name])),
    source: { fileId: file.id, page: positions[name] && Number.isInteger(positions[name].page) ? positions[name].page : null },
  }));
  const status = illegible ? 'ILLEGIBLE' : (overall < minConfidence ? 'LOW_CONFIDENCE' : 'PROPOSED');
  return {
    kind: 'ProposedExtraction', fileId: file.id, fileName: file.fileName, documentType, typeSource, status, overallConfidence: overall, minConfidence,
    fields, requiresHumanConfirmation: true, persisted: false,
    pending: illegible ? 'Documento ilegível: nenhum campo foi sugerido.' : (status === 'LOW_CONFIDENCE' ? 'Confiança abaixo do mínimo: confira o documento antes de usar.' : null),
  };
}

module.exports = { extractFields, textValue };
