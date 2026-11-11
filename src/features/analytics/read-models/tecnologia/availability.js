'use strict';

/**
 * M9-D628 — rm_tech_availability: por sonda (API, banco, fila, storage) e dia de São Paulo, as sondas feitas (`checks`), as bem-sucedidas (`up`) e as ESPERADAS
 * (`expected`: o dia inteiro dividido pelo intervalo analytics.tec.intervalo_sonda_s; hoje, só até agora). Sonda que faltou é expected menos checks e NÃO conta como sucesso
 * (M9-D680). Fonte: analytics.tech_signal_log (kind PROBE). Só as sondas ligadas em analytics.tec.sondas entram. Depende do relógio: a agenda recalcula a cada passada.
 * DI-BI-1: no dia em que a série de uma sonda COMEÇA (a primeira medição já gravada dela), as esperadas contam a partir dessa primeira medição e não da meia-noite: antes
 * dela a sonda não existia, então não há "sonda ausente" (falha da própria sonda) a contar. O início só vale quando está longe da borda da retenção
 * (analytics.tec.sinais_retencao_dias): perto dela a primeira medição guardada pode ser só a mais antiga que sobrou da limpeza, e o dia volta a contar inteiro.
 */
const { select, defineCompanyWideModel, toRow } = require('./common');

const KEY = ['probe', 'day'];
const DAY_MS = 86400000;

/** { PROBE: instante da primeira medição } das sondas cuja série começou dentro da retenção (longe da borda da limpeza). */
async function seriesStarts({ now, params, transaction }) {
  const rows = await select(
    `SELECT probe, min(occurred_at) AS first_at FROM analytics.tech_signal_log WHERE kind = 'PROBE' AND probe IN (:probes) AND occurred_at <= CAST(:now AS timestamptz) GROUP BY probe`,
    { probes: params.probes, now }, transaction
  );
  const purgeEdge = new Date(now).getTime() - params.signalRetentionDays * DAY_MS + DAY_MS;
  return Object.fromEntries(rows.filter((r) => new Date(r.first_at).getTime() >= purgeEdge).map((r) => [r.probe, new Date(r.first_at)]));
}

/** Segundos de `from` até `to` (instantes). */
const secondsBetween = (from, to) => Math.max(0, (to.getTime() - from.getTime()) / 1000);

async function build({ now, params, window, transaction }) {
  const [clock] = await select(
    `SELECT EXTRACT(EPOCH FROM (CAST(:now AS timestamptz) - (CAST(:today AS date)::timestamp AT TIME ZONE :tz)))::int AS elapsed_s`, { now, today: window.today }, transaction
  );
  const perDay = Math.floor(86400 / params.probeIntervalS);
  const samples = await select(
    `SELECT probe, to_char((occurred_at AT TIME ZONE :tz)::date, 'YYYY-MM-DD') AS day, count(*)::int AS checks, (count(*) FILTER (WHERE ok))::int AS up,
            (((occurred_at AT TIME ZONE :tz)::date)::timestamp AT TIME ZONE :tz) AS day_start,
            ((((occurred_at AT TIME ZONE :tz)::date + 1)::timestamp) AT TIME ZONE :tz) AS day_end
       FROM analytics.tech_signal_log
      WHERE kind = 'PROBE' AND probe IN (:probes) AND occurred_at <= CAST(:now AS timestamptz)
        AND (occurred_at AT TIME ZONE :tz)::date BETWEEN CAST(:from AS date) AND CAST(:today AS date)
      GROUP BY 1, 2, 5, 6 ORDER BY 1, 2`,
    { probes: params.probes, now, from: window.from, today: window.today }, transaction
  );
  const starts = await seriesStarts({ now, params, transaction });
  return samples.map((s) => {
    let expected = s.day === window.today ? Math.floor(clock.elapsed_s / params.probeIntervalS) : perDay;
    const start = starts[s.probe];
    if (start && start >= new Date(s.day_start) && start < new Date(s.day_end)) {
      const end = s.day === window.today ? new Date(now) : new Date(s.day_end);
      expected = Math.ceil(secondsBetween(start, end) / params.probeIntervalS);
    }
    return toRow(KEY)({ probe: s.probe, day: s.day, checks: s.checks, up: s.up, expected: Math.max(expected, s.checks) });
  });
}

const def = defineCompanyWideModel({ name: 'rm_tech_availability', keyColumns: KEY, build, reconcileAtRefresh: true });

module.exports = { def, build };
