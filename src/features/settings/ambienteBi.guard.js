'use strict';

/**
 * M9-D708 (3.5) — trava de gravação do parâmetro `analytics.ambiente`: só vai a PRODUCAO se todas as métricas publicadas da empresa tiverem aceite ACCEPTED da
 * versão atual (409 ANALYTICS_ENV_NOT_READY). Fica aqui (e não no BI) porque o BI é somente leitura e não importa o serviço de parâmetros (BI-001); a regra
 * está em src/features/analytics/metrics/acceptance.environment.js. Carregada pelo settings.service, vale para qualquer caminho que grave a chave.
 */
const { registerSettingGuard } = require('./settingGuards');
const { KEYS } = require('../analytics/metrics/acceptance.settings');

registerSettingGuard(KEYS.ambiente, async (value, tenant, _actorUserId, transaction) => {
  if (value !== 'PRODUCAO') return;
  await require('../analytics/metrics/acceptance.environment').assertReadyForProduction(tenant, transaction);
});
