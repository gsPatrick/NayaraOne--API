'use strict';

/**
 * DEC-007 (catálogo X45-D101, faixa de antifraude.outlier_bloqueio_multiplicador: "não menor que o múltiplo de revisão"): o múltiplo que bloqueia nunca fica
 * abaixo do múltiplo que manda para revisão. A trava lê a OUTRA chave da mesma empresa (com o padrão do catálogo quando ainda não gravada) e recusa com 400
 * SETTING_INVALID_VALUE, o mesmo código das demais faixas do Financeiro. Vale para todo caminho que grava a chave (serviço de parâmetros, M9-D034).
 * Carregado por finance-settings.js.
 */
const AppError = require('../../../../utils/AppError');
const { registerSettingGuard } = require('../../../../features/settings/settingGuards');
const { KEYS, readFinanceNumber } = require('./finance-settings');

const invalid = (key, value, esperado) => AppError.badRequest(`O valor de "${key}" deve ser ${esperado}.`, 'SETTING_INVALID_VALUE', { key, value });

registerSettingGuard(KEYS.outlierBlockMultiplier, async (value, tenant, _actorUserId, transaction) => {
  const review = await readFinanceNumber(KEYS.historyMultiplier, tenant, transaction);
  if (value < review) throw invalid(KEYS.outlierBlockMultiplier, value, `>= ${review} (o múltiplo que manda para revisão)`);
});

registerSettingGuard(KEYS.historyMultiplier, async (value, tenant, _actorUserId, transaction) => {
  const block = await readFinanceNumber(KEYS.outlierBlockMultiplier, tenant, transaction);
  if (value > block) throw invalid(KEYS.historyMultiplier, value, `<= ${block} (o múltiplo que bloqueia)`);
});
