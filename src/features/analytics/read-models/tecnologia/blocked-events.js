'use strict';

/**
 * M9-D628 — rm_tech_blocked_events: por dia de São Paulo, motivo e tipo de evento, os eventos barrados antes de produzir efeito. Fontes: execuções de automação de marketing
 * BLOQUEADAS (marketing.automation_runs, motivo KILL_SWITCH quando o código cita a chave de segurança da campanha, CONSENT para falta de consentimento, opt-out e supressão, o próprio código
 * para os demais e NO_REASON quando não há motivo), tentativas barradas por política de segurança e segregação de função (audit.audit_log, ação terminada em `.blocked`, motivo
 * SECURITY_POLICY) e envios de integração recusados na validação (integration.dispatches com erro de classe VALIDATION, motivo VALIDATION). O tipo do evento é o nome da ação ou da
 * operação, nunca o conteúdo. Evento sem motivo grava NO_REASON para o KPI marcar DEGRADED (M9-D680). Só contagens: sem texto da mensagem, pessoa, payload ou segredo.
 */
const { select, defineCompanyWideModel, toRow } = require('./common');
const { BLOCKED_EVENTS } = require('./events');

const KEY = ['day', 'reason', 'event_type'];
const DAY = (column) => `to_char((${column} AT TIME ZONE :tz)::date, 'YYYY-MM-DD')`;

async function build({ companyId, window, transaction }) {
  const records = await select(
    `WITH blocked AS (
       SELECT ${DAY('started_at')} AS day,
              CASE WHEN NULLIF(btrim(blocked_reason), '') IS NULL THEN 'NO_REASON' WHEN upper(blocked_reason) LIKE '%KILL_SWITCH%' THEN 'KILL_SWITCH'
                   WHEN upper(blocked_reason) IN ('NO_CONSENT', 'OPT_OUT', 'SUPPRESSED') THEN 'CONSENT' ELSE left(upper(btrim(blocked_reason)), 32) END AS reason,
              'marketing.automation_run' AS event_type
         FROM marketing.automation_runs WHERE company_id = :companyId AND deleted_at IS NULL AND status = 'BLOCKED' AND (started_at AT TIME ZONE :tz)::date BETWEEN CAST(:from AS date) AND CAST(:today AS date)
       UNION ALL
       SELECT ${DAY('occurred_at')}, 'SECURITY_POLICY', left(action, 128)
         FROM audit.audit_log WHERE company_id = :companyId AND action LIKE '%.blocked' AND (occurred_at AT TIME ZONE :tz)::date BETWEEN CAST(:from AS date) AND CAST(:today AS date)
       UNION ALL
       SELECT ${DAY('updated_at')}, 'VALIDATION', left('integration.dispatch:' || operation, 128)
         FROM integration.dispatches WHERE company_id = :companyId AND last_error_class = 'VALIDATION' AND status IN ('FAILED', 'DEAD_LETTER') AND (updated_at AT TIME ZONE :tz)::date BETWEEN CAST(:from AS date) AND CAST(:today AS date))
     SELECT day, reason, event_type, count(*)::int AS blocked FROM blocked GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    { companyId, from: window.from, today: window.today }, transaction
  );
  return records.map(toRow(KEY));
}

const def = defineCompanyWideModel({ name: 'rm_tech_blocked_events', keyColumns: KEY, events: BLOCKED_EVENTS, build });

module.exports = { def, build };
