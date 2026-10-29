'use strict';

const { getSetting } = require('../../../settings/settings.service');
const { norm, termsOf } = require('../scope/scope.evaluate');
const { CODE } = require('./definition');
const { CORRESPONDENTE_KEYS: K, CORRESPONDENTE_SETTING_DEFAULTS: D } = require('./correspondente.settings');

/**
 * Fronteira da NAY Correspondente (M9-D039): "pendências, simulações e status; sem decisão de crédito". Proibições e mensagens de
 * recusa (resposta 200, sem modelo) e a troca da resposta de modelo que promete o vedado. As listas de termos são da empresa.
 */
const OUT_OF_SCOPE_MESSAGE = 'Isso foge do que este assistente pode fazer.';

const PROHIBITIONS = Object.freeze([
  {
    code: 'DECIDIR_CREDITO', label: 'decidir ou prever aprovação de crédito', key: K.forbidCreditDecision, defaultTerms: D[K.forbidCreditDecision],
    message: 'Não decido nem prevejo aprovação de crédito: isso cabe ao banco e à pessoa responsável. Posso mostrar o status, as pendências e as simulações já registradas do caso.',
  },
  {
    code: 'PROMETER_CONDICOES', label: 'prometer taxa, prazo ou parcela', key: K.forbidPromiseTerms, defaultTerms: D[K.forbidPromiseTerms],
    message: 'Não faço promessa de taxa, prazo nem parcela, e não faço estimativa nova. Posso comparar as simulações já registradas do caso.',
  },
  {
    code: 'ENVIAR_DOCUMENTO_BANCO', label: 'enviar documento ao banco', key: K.forbidSendDocument, defaultTerms: D[K.forbidSendDocument],
    message: 'Não envio documento ao banco. O envio é feito por uma pessoa, pelo fluxo do caso.',
  },
  {
    code: 'CHAMAR_PROVIDER', label: 'chamar o provider de financiamento', key: K.forbidCallProvider, defaultTerms: D[K.forbidCallProvider],
    message: 'Não consulto nem aciono o provider de financiamento. Trabalho só com o que já está registrado no caso.',
  },
  {
    code: 'ALTERAR_STATUS', label: 'alterar o status do caso', key: K.forbidChangeStatus, defaultTerms: D[K.forbidChangeStatus],
    message: 'Não altero o status do caso. A mudança é feita por uma pessoa, pelo fluxo do caso.',
  },
]);

/** Definição que o registro de fronteiras (agents/scope) guarda; os termos efetivos vêm da configuração da empresa a cada pedido. */
const SCOPE_DEFINITION = Object.freeze({
  code: CODE, outOfScopeMessage: OUT_OF_SCOPE_MESSAGE, scopeTermsKey: K.scopeTerms, scopeTermsDefault: D[K.scopeTerms], prohibitions: PROHIBITIONS,
});

const ANSWER_REPLACEMENT = 'Não posso decidir crédito nem prometer aprovação, taxa, prazo ou parcela. Posso informar o status, as pendências e as simulações já registradas do caso.';

/** Gancho de resposta: o texto do modelo que decide crédito ou promete condição é trocado pela recusa. O resultado de regra não passa por aqui com promessa. */
async function checkAnswer(state, text) {
  const terms = termsOf(await getSetting(K.answerTerms, state.ctx, state.transaction, D[K.answerTerms]), D[K.answerTerms]);
  const normalized = norm(text);
  return terms.some((t) => normalized.includes(t)) ? ANSWER_REPLACEMENT : text;
}

module.exports = { OUT_OF_SCOPE_MESSAGE, PROHIBITIONS, SCOPE_DEFINITION, ANSWER_REPLACEMENT, checkAnswer };
