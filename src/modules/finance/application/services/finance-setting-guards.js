'use strict';

/**
 * DEC-007 (catálogo X45-D101, faixa de antifraude.outlier_bloqueio_multiplicador: "não menor que o múltiplo de revisão"): o múltiplo que bloqueia nunca fica
 * abaixo do múltiplo que manda para revisão. A trava lê a OUTRA chave da mesma empresa pelo leitor único (valor em vigor, com o padrão do catálogo quando
 * nada válido foi gravado) e recusa com 422 SETTING_INVALID_VALUE, como as demais faixas do antifraude (DI-DEC007-2). Vale para todo caminho que grava a
 * chave (serviço de parâmetros, M9-D034). Carregado por finance-settings.js.
 */
const AppError = require('../../../../utils/AppError');
const { registerSettingGuard } = require('../../../../features/settings/settingGuards');
const { KEYS, FINANCE_SETTINGS_SCHEMA, readFinanceNumber } = require('./finance-settings');

const BR = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const invalid = (key, value, esperado) => AppError.unprocessable(
  `"${FINANCE_SETTINGS_SCHEMA[key].label}" deve ser ${esperado}. O valor enviado (${JSON.stringify(value)}) foi recusado e nada foi gravado.`,
  'SETTING_INVALID_VALUE',
  { key, value }
);

registerSettingGuard(KEYS.outlierBlockMultiplier, async (value, tenant, _actorUserId, transaction) => {
  const review = await readFinanceNumber(KEYS.historyMultiplier, tenant, transaction);
  if (value < review) throw invalid(KEYS.outlierBlockMultiplier, value, `maior ou igual a ${BR.format(review)}, o múltiplo que manda para revisão`);
});

registerSettingGuard(KEYS.historyMultiplier, async (value, tenant, _actorUserId, transaction) => {
  const block = await readFinanceNumber(KEYS.outlierBlockMultiplier, tenant, transaction);
  if (value > block) throw invalid(KEYS.historyMultiplier, value, `menor ou igual a ${BR.format(block)}, o múltiplo que bloqueia`);
});
