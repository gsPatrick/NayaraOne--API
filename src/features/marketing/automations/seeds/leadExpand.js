'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { COUNTED_MESSAGE_STATUSES } = require('../policy.statuses');
const { NO_REPLY_DAYS_KEY, QUIET_HOURS_KEY } = require('../cadence/cadence.defaults');
const { getMarketingParam } = require('../cadence/marketingParam.service');
const { COLD_INACTIVITY_KEY, readLeadInt } = require('../leadParams');

/**
 * M9-D420 — expansão do tick de agenda das duas automações programadas: cada item candidato vira um evento próprio (eventId único por oportunidade/etapa ou por pessoa/semana),
 * com o sujeito e o payload que o runner lembra. Quem decide se a mensagem sai (consentimento, silêncio, cap, kill switch) é o runner, no canSend.
 */
const q = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
const { CLOSED_STAGE_CODES: CLOSED_STAGES } = require('../../../crm/opportunityStages');
/** Mensagens do funil que contam como "contato" do lado da empresa na cadência: as de pessoa e as de acompanhamento ou transacionais da automação. */
const FOLLOW_UP_PURPOSES = Object.freeze(['TRANSACTIONAL', 'ACOMPANHAMENTO']);
const DAY_MS = 24 * 60 * 60 * 1000;

const EXPAND_SEM_RETORNO = 'SEM_RETORNO';
const EXPAND_CLIENTE_FRIO = 'CLIENTE_FRIO';

/**
 * Sem retorno: oportunidade aberta cuja sequência de contatos da empresa SEM resposta (mensagens OUTBOUND depois da última INBOUND) começou há exatamente um dos valores de
 * `marketing.cadencia.sem_retorno_dias`, contado em dias corridos no fuso da empresa a partir do primeiro contato sem resposta. Resposta INBOUND zera a sequência (a cadência acaba);
 * passado o último valor da lista nada mais é gerado. A etapa (`step`) é a posição do valor na lista.
 */
async function expandSemRetorno(cand, { tenant, transaction, now }) {
  const days = await getMarketingParam(NO_REPLY_DAYS_KEY, tenant, transaction);
  const { timeZone } = await getMarketingParam(QUIET_HOURS_KEY, tenant, transaction);
  const rows = await q(
    `WITH last_in AS (SELECT person_id, max(created_at) AS at FROM crm.messages WHERE company_id = :c AND direction = 'INBOUND' GROUP BY person_id),
          streak AS (SELECT m.person_id, min(m.created_at) AS start_at FROM crm.messages m LEFT JOIN last_in li ON li.person_id = m.person_id
                      WHERE m.company_id = :c AND m.direction = 'OUTBOUND' AND m.status IN (:counted) AND (m.author_type = 'EMPLOYEE' OR m.purpose IN (:purposes))
                        AND (li.at IS NULL OR m.created_at > li.at) GROUP BY m.person_id)
     SELECT o.id AS opportunity_id, o.person_id, s.start_at,
            ((CAST(:now AS timestamptz) AT TIME ZONE :tz)::date - (s.start_at AT TIME ZONE :tz)::date) AS elapsed
       FROM crm.opportunities o JOIN streak s ON s.person_id = o.person_id
      WHERE o.company_id = :c AND o.deleted_at IS NULL AND o.stage NOT IN (:closed) ORDER BY o.created_at, o.id`,
    { c: tenant.companyId, counted: COUNTED_MESSAGE_STATUSES, purposes: FOLLOW_UP_PURPOSES, closed: CLOSED_STAGES, now: now.toISOString(), tz: timeZone }, transaction
  );
  const items = [];
  for (const row of rows) {
    const index = days.indexOf(Number(row.elapsed));
    if (index < 0) continue;
    items.push({
      eventId: `sem-retorno:${row.opportunity_id}:${new Date(row.start_at).toISOString()}:${row.elapsed}`, subject: { type: 'PERSON', id: row.person_id },
      payload: { id: row.opportunity_id, opportunityId: row.opportunity_id, personId: row.person_id, step: index + 1, days: Number(row.elapsed) },
    });
  }
  return items;
}

/**
 * Cliente frio: pessoa ativa com oportunidade, sem interação há `marketing.cliente_frio.dias_inatividade` dias ou mais. Interação = mensagem do cliente (INBOUND) ou de uma pessoa da
 * equipe; as mensagens automáticas (inclusive a própria nutrição) não contam, senão a primeira nutrição deixaria de ser "cliente frio" e o limite nunca seria usado. Sem nenhuma
 * interação vale a data da oportunidade mais recente. Um evento por pessoa por janela semanal; o consentimento NUTRICAO e o limite da janela móvel são do canSend.
 */
async function expandClienteFrio(cand, { tenant, transaction, now, window }) {
  const inactivityDays = await readLeadInt(COLD_INACTIVITY_KEY, tenant, transaction);
  const rows = await q(
    `SELECT person_id FROM (
       SELECT p.id AS person_id,
              GREATEST((SELECT max(o.created_at) FROM crm.opportunities o WHERE o.person_id = p.id AND o.company_id = :c AND o.deleted_at IS NULL),
                       (SELECT max(m.created_at) FROM crm.messages m WHERE m.person_id = p.id AND m.company_id = :c AND (m.direction = 'INBOUND' OR m.author_type = 'EMPLOYEE'))) AS last_at
         FROM people.persons p
        WHERE p.company_id = :c AND p.deleted_at IS NULL AND p.status = 'ACTIVE'
          AND EXISTS (SELECT 1 FROM crm.opportunities o WHERE o.person_id = p.id AND o.company_id = :c AND o.deleted_at IS NULL)) cold
      WHERE last_at <= :cutoff ORDER BY person_id`,
    { c: tenant.companyId, cutoff: new Date(now.getTime() - inactivityDays * DAY_MS).toISOString() }, transaction
  );
  return rows.map((row) => ({
    eventId: `cliente-frio:${row.person_id}:${window.toISOString()}`, subject: { type: 'PERSON', id: row.person_id }, payload: { personId: row.person_id, window: window.toISOString() },
  }));
}

module.exports = { expandSemRetorno, expandClienteFrio, EXPAND_SEM_RETORNO, EXPAND_CLIENTE_FRIO, CLOSED_STAGES };
