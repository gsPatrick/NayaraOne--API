'use strict';

const { registerSettingGuard } = require('../../../settings/settingGuards');
const { checkUrl } = require('../seeds/ports');
const { MIN_POSITIVE_KEY, MAX_NEGATIVE_KEY, REVIEW_URL_KEY, LINK_BASE_KEY, REVIEW_DEFAULTS } = require('./review.settings');
const { paramInvalid } = require('./review.errors');

/**
 * Travas de gravação (M9-D034) dos parâmetros do pedido de avaliação: os limiares nunca se sobrepõem (negativa < positiva, senão 422 MKT_PARAM_INVALID) e os endereços passam pela
 * regra de URL externa (422 MKT_URL_NOT_ALLOWED). Valem para qualquer caminho que grave o valor.
 */
function installReviewGuards() {
  const getSetting = (...args) => require('../../../settings/settings.service').getSetting(...args); // leitura tardia: o dicionário de parâmetros carrega a cadeia que chega aqui
  registerSettingGuard(MIN_POSITIVE_KEY, async (value, tenant, _actor, transaction) => {
    const max = await getSetting(MAX_NEGATIVE_KEY, tenant, transaction, REVIEW_DEFAULTS[MAX_NEGATIVE_KEY]);
    if (!(max < value)) throw paramInvalid({ key: MIN_POSITIVE_KEY, value, esperado: `maior que a nota máxima negativa (${max})` });
  });
  registerSettingGuard(MAX_NEGATIVE_KEY, async (value, tenant, _actor, transaction) => {
    const min = await getSetting(MIN_POSITIVE_KEY, tenant, transaction, REVIEW_DEFAULTS[MIN_POSITIVE_KEY]);
    if (!(value < min)) throw paramInvalid({ key: MAX_NEGATIVE_KEY, value, esperado: `menor que a nota mínima positiva (${min})` });
  });
  for (const key of [REVIEW_URL_KEY, LINK_BASE_KEY]) registerSettingGuard(key, async (value, tenant, _actor, transaction) => { await checkUrl(value, { tenant, transaction }); });
}

module.exports = { installReviewGuards };
