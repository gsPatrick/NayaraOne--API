'use strict';

const { TenantSetting } = require('../../../models');
const { PROVIDER_KEYS, PROVIDER_SETTING_DEFAULTS } = require('../providers/providers.settings');
const { REGRESSION_KEYS, REGRESSION_SETTING_DEFAULTS, AUTO_MODEL } = require('./regression.settings');
const { assertCompanyPairEvaluated } = require('./regression.gate');

/**
 * Trava da troca do provedor ou do modelo padrão da empresa (M9-D033): a gravação de `ia.provedor.padrao` ou
 * `ia.provedor.modelo_padrao` é recusada com 409 AI_REGRESSION_REQUIRED enquanto não houver avaliação aprovada para o novo par.
 * Fica no modelo de configuração (gancho antes de gravar) para valer por qualquer caminho de escrita, na mesma transação.
 */
const GUARDED = Object.freeze([PROVIDER_KEYS.defaultProvider, REGRESSION_KEYS.defaultModel]);
const DEFAULTS = { ...PROVIDER_SETTING_DEFAULTS, ...REGRESSION_SETTING_DEFAULTS };
let registered = false;

async function currentValue(instance, key, transaction) {
  const row = await TenantSetting.findOne({ where: { companyId: instance.companyId, key }, transaction });
  return row ? row.value : DEFAULTS[key];
}

async function guardWrite(instance, options) {
  if (!GUARDED.includes(instance.key)) return;
  const transaction = options && options.transaction;
  const previous = instance.isNewRecord ? DEFAULTS[instance.key] : instance.previous('value');
  if (String(previous) === String(instance.value)) return;
  const other = instance.key === PROVIDER_KEYS.defaultProvider ? REGRESSION_KEYS.defaultModel : PROVIDER_KEYS.defaultProvider;
  const otherValue = await currentValue(instance, other, transaction);
  const provider = String(instance.key === PROVIDER_KEYS.defaultProvider ? instance.value : otherValue);
  const model = String(instance.key === REGRESSION_KEYS.defaultModel ? instance.value : otherValue);
  await assertCompanyPairEvaluated({ companyId: instance.companyId }, { provider, model: model === AUTO_MODEL ? null : model }, transaction);
}

function registerSettingsGuard() {
  if (registered) return;
  registered = true;
  TenantSetting.addHook('beforeSave', 'ai_regression_pair_guard', guardWrite);
}

module.exports = { registerSettingsGuard, guardWrite };
