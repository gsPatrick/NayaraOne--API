'use strict';

const AppError = require('../../utils/AppError');
const { fold } = require('./personDocument.settings');

/**
 * Etapa de CLASSIFICAÇÃO do cadastro por documento (CAD-05; livro §5 "Upload -> antivírus -> hash -> classificação -> OCR/IA -> dados
 * sugeridos"; DI-M3PE-6). Decide o tipo do documento, que governa quais campos críticos a leitura precisa trazer, a partir de três sinais:
 *   1. o tipo DECLARADO por quem envia (quando há);
 *   2. o NOME do arquivo;
 *   3. o TEXTO do próprio documento, quando o motor de leitura o devolve (confirmação depois da leitura).
 * As expressões de cada tipo são o parâmetro `people.documentos.classificacao` (comparadas sem acento, sem caixa e com espaços únicos).
 * Nunca inventa: sem declaração e sem sinal, o tipo é OTHER e o documento fica com pendência ("não classificado"); declaração que o
 * conteúdo contradiz também vira pendência ("tipo divergente"). Tipo declarado fora do formato é recusado (400).
 */
const TYPE = /^[A-Z][A-Z0-9_]{0,39}$/;

/** Tipo com mais expressões encontradas no texto (empate: o primeiro da lista do parâmetro), com as expressões que casaram. */
function detect(text, rules) {
  const hay = fold(text);
  if (!hay) return null;
  let best = null;
  for (const [type, words] of Object.entries(rules)) {
    const hits = words.filter((w) => hay.includes(w));
    if (hits.length && (!best || hits.length > best.hits.length)) best = { type, hits };
  }
  return best;
}

function normalizeDeclared(documentType) {
  if (documentType === undefined || documentType === null || String(documentType).trim() === '') return null;
  const type = String(documentType).trim().toUpperCase();
  if (!TYPE.test(type)) {
    throw AppError.badRequest('O tipo do documento deve ter só letras maiúsculas, números e _ (ex.: RG, CNH).', 'DOCUMENT_INGESTION_VALIDATION',
      { fields: [{ field: 'documentType', message: 'Escolha o tipo do documento.' }] });
  }
  return type;
}

/**
 * Antes da leitura: tipo provisório pela declaração e pelo nome do arquivo. Devolve
 * { declarado, porNome, tipo, metodo: DECLARADO | NOME_DO_ARQUIVO | NAO_CLASSIFICADO }.
 */
function classifyBeforeReading({ documentType, fileName }, rules) {
  const declarado = normalizeDeclared(documentType);
  const porNome = detect(String(fileName || '').replace(/[_\-.]+/g, ' '), rules);
  if (declarado) return { declarado, porNome: porNome ? porNome.type : null, tipo: declarado, metodo: 'DECLARADO' };
  if (porNome) return { declarado: null, porNome: porNome.type, tipo: porNome.type, metodo: 'NOME_DO_ARQUIVO' };
  return { declarado: null, porNome: null, tipo: 'OTHER', metodo: 'NAO_CLASSIFICADO' };
}

/**
 * Depois da leitura: confirma (ou corrige, quando não havia declaração) pelo texto do documento. Devolve a classificação final com
 * `pendencia` (texto do motivo) quando o tipo não pôde ser decidido ou o conteúdo contradiz a declaração.
 */
function confirmWithText(previa, text, rules) {
  const porTexto = detect(text, rules);
  const final = { ...previa, porTexto: porTexto ? porTexto.type : null, expressoes: porTexto ? porTexto.hits : [], pendencia: null };
  if (previa.declarado) {
    if (porTexto && porTexto.type !== previa.declarado) {
      final.pendencia = `Tipo informado (${previa.declarado}) diverge do identificado no conteúdo (${porTexto.type}).`;
      final.divergente = true;
    }
    return final;
  }
  if (porTexto) return { ...final, tipo: porTexto.type, metodo: 'CONTEUDO' };
  if (previa.metodo === 'NAO_CLASSIFICADO') final.pendencia = 'Documento não classificado: informe o tipo na revisão.';
  return final;
}

module.exports = { classifyBeforeReading, confirmWithText, detect };
