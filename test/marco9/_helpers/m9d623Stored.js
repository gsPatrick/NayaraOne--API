'use strict';

// M9-D623 — leitura do valor GRAVADO de uma dimensão no snapshot. Com o KPI DEGRADED/INCOMPLETE a leitura pela API devolve valor nulo em toda
// série (M9-D697), então o teste de qualidade prova pelo banco que o que foi classificado e a parte "sem ..." continuam gravados e contados.
// Banco descartável (127.0.0.1).

/** Valor gravado (texto) da última revisão da dimensão `dimensionKey` do indicador na data-base; null quando não há linha. */
async function storedDimension(env, t, metricCode, dimensionKey, asOfDate = env.asOf || '2026-10-28') {
  const [rows] = await env.admin.query(
    `SELECT COALESCE(s.value_numeric::text, s.value_text) AS value
       FROM analytics.metric_snapshots s
       JOIN analytics.metric_definitions d ON d.id = s.metric_id
      WHERE d.metric_code = :code AND s.scope_id = :scope AND s.dimension_key = :key AND s.as_of_date = :asOf
      ORDER BY s.revision_no DESC LIMIT 1`,
    { replacements: { code: metricCode, scope: t.companyId, key: dimensionKey, asOf: asOfDate } }
  );
  return rows[0] ? rows[0].value : null;
}

module.exports = { storedDimension };
