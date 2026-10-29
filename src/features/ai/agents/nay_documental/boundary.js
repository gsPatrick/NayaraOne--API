'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { norm, termsOf } = require('../scope/scope.evaluate');
const { CODE } = require('./definition');
const { DOCUMENTAL_KEYS: K, DOCUMENTAL_SETTING_DEFAULTS: D } = require('./documental.settings');

/**
 * Fronteira da NAY Documental (M9-D040): "OCR, classificação, extração e checagem", sempre como sugestão para revisão humana. Pedido
 * fora do propósito ou que cai numa das quatro proibições (gravar no cadastro, aprovar documento, ler arquivo não verificado ou de outra
 * empresa, guardar o texto completo) é recusado com resposta 200, sem modelo. As listas de termos são da empresa. A leitura do arquivo
 * não verificado ou de outra empresa também é recusada em código (agents/nay_documental/files.js), mesmo que o pedido não use os termos.
 */
const OUT_OF_SCOPE_MESSAGE = 'Isso foge do que este assistente pode fazer.';

const PROHIBITIONS = Object.freeze([
  {
    code: 'GRAVAR_NO_CADASTRO', label: 'gravar a classificação ou os campos no cadastro', key: K.forbidSaveToRecord, defaultTerms: D[K.forbidSaveToRecord],
    message: 'Não gravo a classificação nem os campos no cadastro: eu só sugiro, com a confiança de cada campo, e uma pessoa confirma antes de salvar.',
  },
  {
    code: 'APROVAR_DOCUMENTO', label: 'aprovar documento', key: K.forbidApprove, defaultTerms: D[K.forbidApprove],
    message: 'Não aprovo nem valido documento: eu só leio, sugiro e aponto divergências. A decisão é de uma pessoa.',
  },
  {
    code: 'ARQUIVO_NAO_VERIFICADO', label: 'ler arquivo não verificado ou de outra empresa', key: K.forbidUnverified, defaultTerms: D[K.forbidUnverified],
    message: 'Só leio arquivos da sua empresa que já foram verificados pelo antivírus.',
  },
  {
    code: 'GUARDAR_TEXTO_COMPLETO', label: 'guardar o texto completo do documento', key: K.forbidKeepFullText, defaultTerms: D[K.forbidKeepFullText],
    message: 'Não guardo o texto completo de documentos: ele só pode ficar no índice autorizado de conhecimento.',
  },
]);

const SCOPE_DEFINITION = Object.freeze({
  code: CODE, outOfScopeMessage: OUT_OF_SCOPE_MESSAGE, scopeTermsKey: K.scopeTerms, scopeTermsDefault: D[K.scopeTerms], prohibitions: PROHIBITIONS,
});

const ANSWER_REPLACEMENT = 'Eu só sugiro: não gravo no cadastro, não aprovo documento e não guardo o texto completo. Posso ler, classificar, extrair campos e checar a consistência para uma pessoa revisar.';

/** Gancho de resposta: o texto do modelo que afirma ter gravado, aprovado ou guardado algo é trocado pela explicação do que a NAY faz. */
async function checkAnswer(state, text) {
  const terms = termsOf(await getSetting(K.answerTerms, state.ctx, state.transaction, D[K.answerTerms]), D[K.answerTerms]);
  const normalized = norm(text);
  return terms.some((t) => normalized.includes(t)) ? ANSWER_REPLACEMENT : text;
}

module.exports = { OUT_OF_SCOPE_MESSAGE, PROHIBITIONS, SCOPE_DEFINITION, ANSWER_REPLACEMENT, checkAnswer };
