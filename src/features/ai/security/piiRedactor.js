'use strict';

/**
 * PiiRedactor (M9-D027): perfil `ai` da biblioteca única de redaction (src/shared/redaction, M9-D246). Aplicado ao prompt enviado ao
 * provider, aos argumentos de tool gravados, ao trecho (excerpt) de fonte, aos resumos de entrada e saída do run, a logs e à memória.
 * Formato `[REDIGIDO:tipo]`. Com mapa (um por run), valores distintos ganham placeholders distintos e `rehydrate` devolve ao próprio
 * usuário o que ele já podia ver; sem mapa a troca é definitiva (gravação em tabela e log).
 */
const { redactForAi, redactDeepForAi } = require('../../../shared/redaction');
const { RedactionMap } = require('./redactionMap');
const CATALOG = require('./piiTypes.json');

/** Texto de PDF hifenizado em fim de linha ("123-\n.456") volta a ser uma palavra só antes de procurar dado pessoal (red-team, M9-D046). */
const juntarHifenizacao = (texto) => (typeof texto === 'string' ? texto.replace(/-[ \t]*\r?\n[ \t]*/g, '') : texto);

function createPiiRedactor({ map = new RedactionMap() } = {}) {
  const options = { placeholderFor: (tipo, valor, opts) => map.placeholderFor(tipo, valor, opts) };
  return {
    map,
    text: (texto) => redactForAi(juntarHifenizacao(texto), options),
    deep: (valor) => redactDeepForAi(valor, options),
    rehydrate: (texto) => map.rehydrate(texto),
  };
}

/** Troca definitiva (sem mapa) de texto que vai ser gravado: resumo, trecho de fonte, log. */
const redactForStorage = (texto) => redactForAi(juntarHifenizacao(texto));

/**
 * Texto de classe RESTRICTED nunca é gravado como trecho: só `[REDIGIDO:restrito]` (o hash da fonte prova o conteúdo). As demais
 * classes seguem a redaction normal. Classe desconhecida conta como RESTRICTED (falha fechada).
 */
const CLASSES_LIVRES = new Set(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL']);
function redactForClassification(texto, classification) {
  if (texto === null || texto === undefined) return texto;
  return CLASSES_LIVRES.has(classification) ? redactForAi(String(texto)) : '[REDIGIDO:restrito]';
}

/** Troca definitiva em estrutura (argumentos e resultado de tool, auditoria). */
const redactDeepForStorage = (valor) => redactDeepForAi(valor);

module.exports = { createPiiRedactor, redactForStorage, redactDeepForStorage, redactForClassification, RedactionMap, REDACTION_TYPES: Object.freeze(CATALOG.tipos.map((t) => t.tipo)) };
