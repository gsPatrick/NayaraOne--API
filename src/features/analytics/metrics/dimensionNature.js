'use strict';

/**
 * M9-D650 (BI-006, M9-D610) — natureza do valor de uma dimensão do indicador. Um indicador de natureza única herda a da versão; o que traz séries
 * de naturezas diferentes na mesma leitura (baseline, actual e forecast do custo da obra) declara aqui a natureza de cada série, para a API
 * devolver cada uma com o rótulo certo e nunca somá-las. A chave por obra (`obra:<id>:forecast_brl`) vale pelo último trecho.
 */
const BY_METRIC = Object.freeze({
  'obra.baseline_actual_forecast': Object.freeze({ baseline_brl: 'PLANNED', actual_brl: 'ACTUAL', forecast_brl: 'PROJECTED' }),
});

function dimensionNature(metricCode, dimensionKey, versionNature) {
  const series = BY_METRIC[metricCode];
  if (!series || !dimensionKey) return versionNature;
  return series[String(dimensionKey).split(':').pop()] || versionNature;
}

module.exports = { dimensionNature };
