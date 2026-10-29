'use strict';

/**
 * M9-D632 / M9-D633 — peças comuns da leitura dos read models de Comercial e Imóveis para os KPIs: consulta simples, soma de contagens guardadas em
 * jsonb (por corretor, por tipo, por origem) e o instante mais recente em que o read model foi alimentado com dado da fonte.
 */
const { sequelize } = require('../../../../models');

const monthOf = (asOfDate) => asOfDate.slice(0, 7);

async function query(sql, replacements, transaction) {
  const [rows] = await sequelize.query(sql, { replacements, transaction });
  return rows;
}

/** Soma de contagens guardadas como { chave: n } (ou { chave: { campo: n } }) em várias linhas: { chave: n } (ou { chave: { campo: n } }). */
function mergeCounts(objects) {
  const out = {};
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj || {})) {
      if (value !== null && typeof value === 'object') {
        out[key] = out[key] || {};
        for (const [field, n] of Object.entries(value)) out[key][field] = (out[key][field] || 0) + Number(n);
      } else out[key] = (out[key] || 0) + Number(value);
    }
  }
  return out;
}

/** Instante mais recente em que o read model foi alimentado com dado da fonte (source_snapshot_at); nulo se nunca foi. */
async function latestSnapshotAt(companyId, model, transaction) {
  const [own] = await query(`SELECT max(source_snapshot_at) AS at FROM analytics.${model} WHERE company_id = :companyId`, { companyId }, transaction);
  const [refresh] = await query(
    "SELECT max(source_snapshot_at) AS at FROM analytics.read_model_refreshes WHERE company_id = :companyId AND read_model = :model AND status IN ('SUCCEEDED', 'DEGRADED')", { companyId, model }, transaction
  );
  const times = [own && own.at, refresh && refresh.at].filter(Boolean).map((v) => new Date(v));
  return times.length ? new Date(Math.max(...times.map((d) => d.getTime()))) : null;
}

/** Base das consultas: empresa, mês de São Paulo da data-base (dia 1 até ela) e a data-base. */
const baseOf = (scope, asOfDate) => ({ companyId: scope.companyId, from: `${monthOf(asOfDate)}-01`, asOfDate, month: monthOf(asOfDate) });

module.exports = { query, mergeCounts, latestSnapshotAt, baseOf, monthOf };
