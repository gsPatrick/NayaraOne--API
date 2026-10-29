'use strict';

// M9-D002 — guardas de "Não improvisar" (Guia do Marcelo IA NAY, seção 17). Cada função abaixo é o ponto único
// que as demandas donas da regra (D009 memória, D019 propostas, D021 injection, D025 grounding, D026 números,
// D033 regressão) chamam; aqui fica a trava, lá a lógica completa de cada uma. Tudo falha fechado.

const AppError = require('../../../utils/AppError');
const settingsService = require('../../../features/settings/settings.service');

const MENSAGEM_INSUFICIENCIA = 'Não tenho informações suficientes nas fontes autorizadas para responder isso com segurança.';
const MENSAGEM_MEMORIA_TEXTO_LIVRE = 'Memória só aceita fatos estruturados, não a conversa inteira.';
const MENSAGEM_REGRESSAO = 'Troque o modelo somente depois de a regressão passar.';

// ---------- 4. Documento não é instrução ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

/** Embrulha cada trecho recuperado em bloco `untrusted`, com os delimitadores do conteúdo escapados (não dá para "fechar" a tag). */
function wrapUntrusted(trechos) {
  return (trechos || []).map((t) => `<untrusted id="${escAttr(t.id)}" origin="${escAttr(t.origin)}" classification="${escAttr(t.classification)}"${t.suspicious === true ? ' suspicious="true"' : ''}>\n${esc(t.text)}\n</untrusted>`).join('\n');
}

const PEDIDO_TOOL = /\[\[TOOL:([A-Za-z0-9_.-]+)(?:\s+(\{[\s\S]*?\}))?\s*\]\]/g;

function nomesDePedidos(texto) {
  const nomes = new Set();
  for (const m of String(texto).matchAll(PEDIDO_TOOL)) nomes.add(m[1]);
  return nomes;
}

/**
 * Lê os pedidos de tool da saída do modelo (formato do provider sandbox: `[[TOOL:nome {json}]]`). Um pedido cuja
 * tool aparece como pedido dentro de conteúdo `untrusted` é eco de documento: ignorado e devolvido em `ignored`.
 */
function extractToolRequests(saidaDoModelo, { untrustedTexts = [] } = {}) {
  const deDocumento = new Set();
  for (const t of untrustedTexts) for (const n of nomesDePedidos(t)) deDocumento.add(n);
  const requests = [];
  const ignored = [];
  for (const m of String(saidaDoModelo).matchAll(PEDIDO_TOOL)) {
    const name = m[1];
    if (deDocumento.has(name)) { ignored.push({ name, reason: 'DERIVED_FROM_UNTRUSTED' }); continue; }
    let input = {};
    if (m[2]) {
      try { input = JSON.parse(m[2]); } catch (e) { ignored.push({ name, reason: 'INVALID_ARGUMENTS' }); continue; }
    }
    requests.push({ name, input });
  }
  return { requests, ignored };
}

// ---------- 6. Conversa inteira não vira memória ----------

const CHAVES_DE_CONVERSA = /^(?:transcript|transcricao|conversation|conversa|messages|mensagens|chat|history|historico|dialogue|dialogo)$/i;

function temConversa(valor, profundidade = 0) {
  if (valor === null || valor === undefined || profundidade > 8) return false;
  if (typeof valor === 'string') return false;
  if (Array.isArray(valor)) {
    return valor.some((i) => (i && typeof i === 'object' && !Array.isArray(i) && 'role' in i && ('content' in i || 'text' in i)) || temConversa(i, profundidade + 1));
  }
  if (typeof valor === 'object') {
    return Object.entries(valor).some(([k, v]) => CHAVES_DE_CONVERSA.test(k) || temConversa(v, profundidade + 1));
  }
  return false;
}

/** Lê `ia.memoria.guardar_conversa_inteira` da empresa (padrão Desligado). */
async function loadMemoryPolicy(tenant, transaction) {
  const v = await settingsService.getSetting('ia.memoria.guardar_conversa_inteira', tenant, transaction, false);
  return { guardarConversaInteira: v === true };
}

/**
 * Valor de memória: só fato estruturado. Texto solto, lista de mensagens ou campo de conversa => 422.
 * Com o parâmetro Ligado a conversa deixa de ser recusada AQUI, mas só vale pela regra única de M9-D009
 * (`regraUnicaD009: true` obriga o chamador a aplicá-la: ai:admin, escopo SESSION, expiração, redaction, sem RESTRICTED).
 */
function assertMemoryValue(valor, politica = { guardarConversaInteira: false }) {
  const objetoPlano = valor !== null && typeof valor === 'object' && !Array.isArray(valor);
  const conversa = !objetoPlano || temConversa(valor);
  if (!conversa) return { ok: true, regraUnicaD009: false };
  if (politica && politica.guardarConversaInteira === true && objetoPlano) return { ok: true, regraUnicaD009: true };
  throw AppError.unprocessable(MENSAGEM_MEMORIA_TEXTO_LIVRE, 'AI_MEMORY_FREE_TEXT_BLOCKED');
}

// ---------- 7. Cálculo financeiro não vem do LLM ----------

const naoVemDoReadModel = (detalhe) => AppError.unprocessable('Um número da resposta não vem de uma fonte determinística.', 'AI_NUMBER_NOT_FROM_SOURCE', detalhe);

/** Todo valor financeiro da resposta precisa ter origem READ_MODEL com a fonte identificada. */
function assertFinancialFigures(valores) {
  for (const f of valores || []) {
    if (!f || f.origin !== 'READ_MODEL' || typeof f.source !== 'string' || !f.source) throw naoVemDoReadModel({ ref: f && f.ref });
  }
}

function normalizarDecimal(txt) {
  const limpo = String(txt).replace(/\./g, '').replace(',', '.');
  return limpo.includes('.') ? limpo.replace(/0+$/, '').replace(/\.$/, '') : limpo;
}

/** Valor monetário/percentual escrito no texto final (R$ 1.234,56; 12,5%) precisa casar com um valor do read model. */
function assertTextNumbersFromReadModel(texto, valores) {
  const permitidos = new Set((valores || []).map((v) => normalizarDecimal(String(v.value).replace('.', ','))));
  const re = /(?:R\$\s*)(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)|(\d{1,3}(?:\.\d{3})*,\d+|\d+,\d+)(?!\d)|(\d+(?:,\d+)?)\s*%/g;
  for (const m of String(texto).matchAll(re)) {
    const bruto = m[1] || m[2] || m[3];
    if (!permitidos.has(normalizarDecimal(bruto))) throw naoVemDoReadModel({ valor: bruto });
  }
}

// ---------- 8. Troca de modelo/provider exige regressão ----------

/**
 * Trocar modelo ou provider só com avaliação GOLDEN e ADVERSARIAL PASSED para o novo par. `findEvaluation` é a consulta
 * a ai.evaluations (M9-D032/D033); sem ela, nada é provado e a troca é recusada.
 */
async function assertSwitchAllowed(troca, { findEvaluation } = {}) {
  if (!troca || !['model', 'provider'].includes(troca.kind)) throw AppError.badRequest('Tipo de troca inválido.', 'AI_SWITCH_INVALID');
  if (troca.from === troca.to) return { ok: true };
  const recusa = () => new AppError(MENSAGEM_REGRESSAO, 409, 'AI_REGRESSION_REQUIRED', { kind: troca.kind, from: troca.from, to: troca.to });
  if (typeof findEvaluation !== 'function') throw recusa();
  const av = await findEvaluation(troca);
  const tipos = av && Array.isArray(av.kinds) ? av.kinds : [];
  if (!av || av.status !== 'PASSED' || !tipos.includes('GOLDEN') || !tipos.includes('ADVERSARIAL')) throw recusa();
  return { ok: true };
}

// ---------- 9. Falta de fonte é dita ----------

/** Resposta factual sem fonte suficiente vira a mensagem de insuficiência; nunca completa a lacuna. */
function resolveFactualAnswer({ factual, answer, sources = [], minRelevance = 0 }) {
  if (!factual) return { answer, groundingStatus: 'NOT_FACTUAL', sources: [] };
  const suficientes = (sources || []).filter((s) => s && (typeof s.relevance !== 'number' || s.relevance >= minRelevance));
  if (!suficientes.length) return { answer: MENSAGEM_INSUFICIENCIA, groundingStatus: 'INSUFFICIENT_SOURCES', sources: [] };
  return { answer, groundingStatus: 'GROUNDED', sources: suficientes };
}

module.exports = {
  MENSAGEM_INSUFICIENCIA, MENSAGEM_MEMORIA_TEXTO_LIVRE, MENSAGEM_REGRESSAO,
  wrapUntrusted, extractToolRequests, loadMemoryPolicy, assertMemoryValue,
  assertFinancialFigures, assertTextNumbersFromReadModel, assertSwitchAllowed, resolveFactualAnswer,
};
