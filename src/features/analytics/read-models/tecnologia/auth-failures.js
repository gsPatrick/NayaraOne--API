'use strict';

/**
 * M9-D628 — rm_tech_auth_failures: por dia de São Paulo, tipo (LOGIN, MFA, INTEGRATION) e fornecedor (`-` para login e MFA), as falhas de autenticação, os atores distintos
 * (usuários por hash nas falhas de login e MFA; connections distintas nas de integração) e o pico de falhas numa única hora do dia (`peak_hour_failures`, comparado com
 * analytics.tec.auth_falhas_por_hora). Login e MFA vêm do registro de sinais técnicos (analytics.tech_signal_log), que é global: a falha de quem digitou e-mail inexistente também conta
 * e as cópias por empresa são iguais (DI-D628-1). Integração vem de integration.integration_errors com classe AUTH da empresa. Sem e-mail, IP, nome nem credencial: só contagens (a
 * identificação é do drill-down com analytics:read:tech).
 */
const { select, defineCompanyWideModel, toRow } = require('./common');

const KEY = ['day', 'kind', 'provider'];
const DAY = (column) => `to_char((${column} AT TIME ZONE :tz)::date, 'YYYY-MM-DD')`;
const IN_WINDOW = (column) => `(${column} AT TIME ZONE :tz)::date BETWEEN CAST(:from AS date) AND CAST(:today AS date)`;

async function build({ companyId, now, window, transaction }) {
  const records = await select(
    `WITH f AS (
       SELECT ${DAY('occurred_at')} AS day, CASE kind WHEN 'LOGIN_FAILURE' THEN 'LOGIN' ELSE 'MFA' END AS kind, '-'::text AS provider, actor_hash AS actor,
              date_trunc('hour', occurred_at AT TIME ZONE :tz) AS hour
         FROM analytics.tech_signal_log WHERE kind IN ('LOGIN_FAILURE', 'MFA_FAILURE') AND occurred_at <= CAST(:now AS timestamptz) AND ${IN_WINDOW('occurred_at')}
       UNION ALL
       SELECT ${DAY('created_at')}, 'INTEGRATION', provider_code, connection_id::text, date_trunc('hour', created_at AT TIME ZONE :tz)
         FROM integration.integration_errors WHERE company_id = :companyId AND error_class = 'AUTH' AND ${IN_WINDOW('created_at')}),
     hourly AS (SELECT day, kind, provider, hour, count(*) AS n FROM f GROUP BY 1, 2, 3, 4)
     SELECT f.day, f.kind, f.provider, (SELECT sum(n) FROM hourly h WHERE h.day = f.day AND h.kind = f.kind AND h.provider = f.provider)::int AS failures,
            count(DISTINCT f.actor)::int AS distinct_actors,
            (SELECT max(n) FROM hourly h WHERE h.day = f.day AND h.kind = f.kind AND h.provider = f.provider)::int AS peak_hour_failures
       FROM f GROUP BY f.day, f.kind, f.provider ORDER BY 1, 2, 3`,
    { companyId, now, from: window.from, today: window.today }, transaction
  );
  return records.map(toRow(KEY));
}

const def = defineCompanyWideModel({ name: 'rm_tech_auth_failures', keyColumns: KEY, build });

module.exports = { def, build };
