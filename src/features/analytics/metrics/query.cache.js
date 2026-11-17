'use strict';

/**
 * Chave do cache do valor de um indicador (GET /analytics/metrics/:code; livro BI §19 "cache por permissão/escopo", o mesmo cache do painel).
 * Além de indicador, versão, empresa, permissões (dashboards/cache.js), a chave leva tudo o que muda a resposta:
 *   - o período resolvido inteiro (início, fim, tipo: MONTH, QUARTER, YEAR ou RANGE) e a data-base;
 *   - dimensão, recorte e comparação;
 *   - a impressão dos parâmetros `analytics.*` da empresa (valor e chave de cada um): o administrador muda um parâmetro e a próxima leitura já o
 *     respeita (ex.: analytics.metrica.dimensao_max_itens), sem esperar o TTL.
 */
const { sequelize } = require('../../../models');

async function settingsFingerprint(companyId, transaction) {
  const [[row]] = await sequelize.query(
    `SELECT COALESCE(md5(string_agg(s.key || '=' || s.value::text, ',' ORDER BY s.key)), '') AS h
       FROM core.tenant_settings s WHERE s.company_id = :companyId AND s.key LIKE 'analytics.%' AND s.deleted_at IS NULL`,
    { replacements: { companyId }, transaction }
  );
  return row.h;
}

/** spec do cache (kind 'metric') para a leitura já conferida. */
async function metricCacheSpec({ definition, companyId, period, asOfDate, dimension, dimensionKey, compareKind }, transaction) {
  const parts = [JSON.stringify(period), asOfDate, dimension ? dimension.dimension : '', dimensionKey, compareKind || '', await settingsFingerprint(companyId, transaction)];
  return { kind: 'metric', dashboardCode: definition.metric_code, version: definition.current_version_id || definition.id, period: parts.join('|') };
}

module.exports = { metricCacheSpec, settingsFingerprint };
