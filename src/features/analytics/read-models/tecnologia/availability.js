'use strict';

/**
 * M9-D628 — rm_tech_availability: por sonda (API, banco, fila, storage) e dia de São Paulo, as sondas feitas (`checks`), as bem-sucedidas (`up`) e as ESPERADAS
 * (`expected`: o dia inteiro dividido pelo intervalo analytics.tec.intervalo_sonda_s; hoje, só até agora). Sonda que faltou é expected menos checks e NÃO conta como sucesso
 * (M9-D680). Fonte: analytics.tech_signal_log (kind PROBE). Só as sondas ligadas em analytics.tec.sondas entram. Depende do relógio: a agenda recalcula a cada passada.
 */
const { select, defineCompanyWideModel, toRow } = require('./common');

const KEY = ['probe', 'day'];

async function build({ now, params, window, transaction }) {
  const [clock] = await select(
    'SELECT EXTRACT(EPOCH FROM (CAST(:now AS timestamptz) - (CAST(:today AS date)::timestamp AT TIME ZONE :tz)))::int AS elapsed_s', { now, today: window.today }, transaction
  );
  const perDay = Math.floor(86400 / params.probeIntervalS);
  const samples = await select(
    `SELECT probe, to_char((occurred_at AT TIME ZONE :tz)::date, 'YYYY-MM-DD') AS day, count(*)::int AS checks, (count(*) FILTER (WHERE ok))::int AS up
       FROM analytics.tech_signal_log
      WHERE kind = 'PROBE' AND probe IN (:probes) AND occurred_at <= CAST(:now AS timestamptz)
        AND (occurred_at AT TIME ZONE :tz)::date BETWEEN CAST(:from AS date) AND CAST(:today AS date)
      GROUP BY 1, 2 ORDER BY 1, 2`,
    { probes: params.probes, now, from: window.from, today: window.today }, transaction
  );
  return samples.map((s) => {
    const expected = s.day === window.today ? Math.floor(clock.elapsed_s / params.probeIntervalS) : perDay;
    return toRow(KEY)({ probe: s.probe, day: s.day, checks: s.checks, up: s.up, expected: Math.max(expected, s.checks) });
  });
}

const def = defineCompanyWideModel({ name: 'rm_tech_availability', keyColumns: KEY, build });

module.exports = { def, build };
