'use strict';

const crypto = require('node:crypto');
const { providerRegistry } = require('../../providers');
const budgets = require('../../budgets');
const { parseDocument } = require('../../retrieval/parse');
const E = require('./documental.errors');

/**
 * Leitura do texto do arquivo (M9-D040, OCR). PDF, DOCX e texto simples: a camada de texto do próprio arquivo, sem provedor e sem custo.
 * Imagem: capacidade `vision` do provedor de IA; áudio: `transcribe`. A chamada ao provedor passa pelo orçamento do agente (reserva e
 * acerto do custo real) e só vai para provedor que aceita a classificação do arquivo. Devolve o texto COMPLETO só para quem chamou: a
 * ferramenta devolve ao run um trecho e o hash, e nada daqui é gravado.
 */
const AGENT_CODE = 'NAY_DOCUMENTAL';
const PROMPT = 'Transcreva o texto do documento, sem interpretar nem completar.';
const kindOf = (mime) => {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
};

async function viaProvider(operation, opened, scope, transaction) {
  const tenant = { groupId: scope.groupId, companyId: scope.companyId };
  const capability = operation === 'image' ? 'vision' : 'transcribe';
  const [pick] = await providerRegistry.candidates({
    capability, criticidade: 'NON_CRITICAL', politica: { classification: opened.classification }, requestSize: { tokensIn: 1000, tokensOut: 1000 },
  }, tenant, transaction);
  if (!pick) throw E.ocrUnavailable();
  const adapter = await providerRegistry.instance(pick.providerCode, tenant, transaction);
  const ref = `file:${opened.file.id}`;
  const spent = await budgets.spendWithBudget({ ...tenant, userId: scope.userId }, {
    agentCode: AGENT_CODE, criticality: 'NON_CRITICAL', routingPath: 'SMALL_MODEL', estimate: pick.estimatedCost,
  }, async () => {
    const out = operation === 'image' ? await adapter.analyzeImage({ model: pick.model, imageRef: ref, prompt: PROMPT }) : await adapter.transcribe({ model: pick.model, fileRef: ref, language: 'pt' });
    return { text: String(out.text || ''), cost: out.costAmount };
  }, transaction);
  return { text: spent.text, method: operation === 'image' ? 'VISION' : 'TRANSCRIBE', provider: pick.providerCode };
}

async function readText(opened, scope, transaction) {
  const kind = kindOf(opened.file.mimeType);
  if (kind === 'image' || kind === 'audio') return viaProvider(kind, opened, scope, transaction);
  let parsed;
  try {
    parsed = parseDocument(opened.buffer, { mimeType: opened.file.mimeType, maxBytes: opened.maxBytes });
  } catch (err) {
    if (err.code === 'PARSE_UNSUPPORTED') throw E.unsupported();
    throw E.unreadable();
  }
  if (parsed.text) return { text: parsed.text, method: 'TEXT_LAYER', provider: null };
  if (parsed.format === 'pdf') return viaProvider('image', opened, scope, transaction); // PDF escaneado: sem camada de texto
  throw E.unreadable();
}

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

module.exports = { readText, sha256, AGENT_CODE };
