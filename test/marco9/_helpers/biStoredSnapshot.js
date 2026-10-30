'use strict';

// Apoio dos testes dos KPIs do BI (M9-D630, M9-D632, M9-D633): lê o que foi GRAVADO no snapshot de uma dimensão, sem passar pela apresentação da API.
// A API nunca devolve valor de KPI DEGRADED ou INCOMPLETE (M9-D697, nulo != 0), nem o das suas dimensões; o registro gravado guarda a contagem verdadeira
// ("Sem data", "Sem captador", "Não informada"), que é o que o drill-down e a auditoria usam. Banco descartável: lê com o usuário administrador.
async function storedDimension(env, tenant, metricCode, dimensionKey, asOfDate) {
  const [rows] = await env.admin.query(
    `SELECT s.value_numeric::text AS value FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
      WHERE d.metric_code = :metricCode AND s.company_id = :companyId AND s.scope_id = :companyId AND s.as_of_date = :asOfDate AND s.dimension_key = :dimensionKey
      ORDER BY s.revision_no DESC LIMIT 1`,
    { replacements: { metricCode, companyId: tenant.companyId, asOfDate, dimensionKey } });
  return rows.length ? rows[0].value : null;
}

module.exports = { storedDimension };
