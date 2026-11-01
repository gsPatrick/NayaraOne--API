'use strict';

/**
 * M9-D414 (reabertura da rodada 4) — limites da varredura de URL em texto digitado ou enviado (mensagem direta, definição de automação, template, legenda).
 *  - max_chars_variavel: tamanho máximo de cada variável (folha de texto, chave de objeto incluída) de um envio ou de uma ação.
 *  - max_chars_campo: tamanho máximo de cada campo de texto (texto, assunto, pré-cabeçalho, corpo, título, legenda).
 *  - max_chars_total: soma máxima de tudo que é varrido numa chamada. Protege a varredura contra pedido grande demais, que não pode prender o processo (todas as empresas).
 *  - revisao_sem_aprovador: o que fazer com o candidato ambíguo (REVIEW: abreviação, nome de arquivo, número, encurtador novo) onde NÃO há aprovador humano no ponto
 *    (envio direto, texto de ação de automação, template, legenda): "bloquear" (padrão, mais conservador) recusa; "permitir" deixa passar. No pipeline de conteúdo, o
 *    candidato REVIEW sempre vai à aprovação humana (D433), qualquer que seja este valor.
 */
const VARIABLE_KEY = 'marketing.url.max_chars_variavel';
const FIELD_KEY = 'marketing.url.max_chars_campo';
const TOTAL_KEY = 'marketing.url.max_chars_total';
const REVIEW_KEY = 'marketing.url.revisao_sem_aprovador';

const URL_LIMIT_DEFAULTS = Object.freeze({ [VARIABLE_KEY]: 2000, [FIELD_KEY]: 20000, [TOTAL_KEY]: 100000, [REVIEW_KEY]: 'bloquear' });
const URL_LIMITS_SCHEMA = {
  [VARIABLE_KEY]: { type: 'integer', min: 50, max: 100000 },
  [FIELD_KEY]: { type: 'integer', min: 200, max: 200000 },
  [TOTAL_KEY]: { type: 'integer', min: 1000, max: 2000000 },
  [REVIEW_KEY]: { type: 'string', enum: ['bloquear', 'permitir'] },
};

const intOr = (value, fallback, min) => (Number.isInteger(Number(value)) && Number(value) >= min ? Number(value) : fallback);

async function readUrlLimits(tenant, transaction) {
  const { getSetting } = require('../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const get = (key) => getSetting(key, tenant, transaction, URL_LIMIT_DEFAULTS[key]);
  const [variable, field, total, review] = await Promise.all([get(VARIABLE_KEY), get(FIELD_KEY), get(TOTAL_KEY), get(REVIEW_KEY)]);
  return {
    maxVariable: intOr(variable, URL_LIMIT_DEFAULTS[VARIABLE_KEY], 50),
    maxField: intOr(field, URL_LIMIT_DEFAULTS[FIELD_KEY], 200),
    maxTotal: intOr(total, URL_LIMIT_DEFAULTS[TOTAL_KEY], 1000),
    blockReview: String(review) !== 'permitir',
  };
}

module.exports = { VARIABLE_KEY, FIELD_KEY, TOTAL_KEY, REVIEW_KEY, URL_LIMIT_DEFAULTS, URL_LIMITS_SCHEMA, readUrlLimits };
