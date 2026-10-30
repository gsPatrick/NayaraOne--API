'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { startOfDay, endOfDayExclusive } = require('../days');
const { divHalfEven, safeNumber } = require('../money');

/** Reais com 6 casas (texto do numeric) -> micro-reais inteiros (BigInt); 1 centavo = 10.000 micro-reais. */
const microOf = (text) => { const [i, f = ''] = String(text || '0').split('.'); return BigInt(i || '0') * 1000000n + BigInt(f.padEnd(6, '0').slice(0, 6)); };
const MICRO_PER_CENT = 10000n;

/**
 * Modelo de IA caro (M9-D862 §3.4): tarefa que o registry do roteamento (M9-D012) classificou como simples (`routing_path = 'SMALL_MODEL'`: resumo curto,
 * classificação) cujo custo médio por chamada, por modelo, passou de `ia_custo_chamada_centavos`. Respostas de cache não contam. Desperdício = (custo médio -
 * limiar) x chamadas = custo total - limiar x chamadas, em micro-reais exatos e arredondado half-even para centavos. Dia = o dia fechado de Brasília.
 */
async function detectAiModelCost(tenant, day, params, transaction) {
  const rows = await sequelize.query(
    `SELECT provider_code, model_code, count(*)::int AS calls, SUM(cost_amount)::text AS total
       FROM ai.ai_runs WHERE company_id = :companyId AND routing_path = 'SMALL_MODEL' AND cached = false AND cost_amount IS NOT NULL
        AND model_code IS NOT NULL AND started_at >= :start AND started_at < :end
      GROUP BY provider_code, model_code ORDER BY provider_code, model_code`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId, start: startOfDay(day), end: endOfDayExclusive(day) } }
  );
  const limit = BigInt(params.aiCallCents) * MICRO_PER_CENT;
  const found = [];
  for (const r of rows) {
    const total = microOf(r.total);
    const calls = BigInt(r.calls);
    if (total <= limit * calls) continue;
    found.push({
      subject: `${r.provider_code || '-'}/${r.model_code}`, wasteCents: safeNumber(divHalfEven(total - limit * calls, MICRO_PER_CENT)),
      evidence: { day, chamadas: r.calls, custoTotalCentavos: Number(divHalfEven(total, MICRO_PER_CENT)), custoMedioCentavos: Number(divHalfEven(total * 100n / calls, MICRO_PER_CENT)) / 100, limiarCentavos: params.aiCallCents },
    });
  }
  return found;
}

module.exports = { detectAiModelCost };
