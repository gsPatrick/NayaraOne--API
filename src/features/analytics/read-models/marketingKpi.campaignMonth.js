'use strict';

/**
 * M9-D670 — rm_mkt_campaign_month: resultado mensal (mês de São Paulo) de cada campanha para os KPIs de custo, leads e atribuição. O agregado é a
 * campanha (todas as suas linhas de mês são regravadas juntas); a campanha 00000000-0000-0000-0000-000000000000 é "Sem campanha" (leads sem
 * campanha e vendas que o Marketing não atribuiu). Tudo é lido do que o Financeiro e o Marketing já gravaram: o BI não reatribui nem recalcula a
 * janela de atribuição (M9-D431).
 *   custo realizado: despesas liquidadas ligadas à campanha pela mesma regra do custo real do Marketing (M9-D432: referência `campaign:{id}`
 *     ou centro de custo de código igual ao da campanha; baixa parcial herda o vínculo; estorno parcial subtrai), no mês da liquidação;
 *   planejado: despesas pendentes ligadas à campanha, no mês do vencimento;
 *   leads: oportunidades com origem de marketing (lead_source) criadas no mês; atribuídos (LAST) = com evento LEAD_CREATED válido da campanha;
 *     FIRST = leads cuja pessoa tem toque FIRST válido da campanha gravado pelo Marketing; vendas = oportunidades ganhas no mês originadas na campanha;
 *     fora da janela = vendas que o Marketing registrou como NAO_ATRIBUIDA por SEM_TOQUE_VALIDO_NA_JANELA.
 */
const { defineAggregateModel } = require('./aggregateModel');
const { sqlMonth, TODAY_START } = require('./aggregateModel.sql');
const { UUID_RE, rows } = require('./marketingAtendimento.time');

const oneRow = async (sql, replacements, transaction) => (await rows(sql, replacements, transaction))[0] || null;

const NIL = '00000000-0000-0000-0000-000000000000';
const EVENTS = Object.freeze([
  'attribution.recorded', 'marketing.campaign.started', 'marketing.campaign.ended',
  'crm.opportunity.created', 'crm.opportunity.won', 'crm.opportunity.lost', 'crm.opportunity.stage_changed',
  'finance.entry.created', 'finance.entry.settled', 'finance.entry.reversed', 'finance.entry.canceled',
]);
const AGG = 'CAST(:agg_campaign_id AS uuid)';
const ZERO = { cost_settled: '0::numeric', cost_planned: '0::numeric', leads_total: '0', leads_last: '0', leads_first: '0', sales_last: '0', outside_window: '0' };
const part = (select, over) => `SELECT ${Object.entries({ ...ZERO, ...over }).map(([k, v]) => `${v} AS ${k}`).join(', ')}, ${select}`;

/** Despesas da campanha (aggregate): liquidadas (mês da liquidação, líquidas do estorno) ou pendentes (mês do vencimento). */
const linked = (status, dateCol, valueExpr, extra) => `
  SELECT ${sqlMonth(`e.${dateCol}`)} AS month, ${valueExpr} AS cents
    FROM finance.financial_entries e
    LEFT JOIN finance.financial_entries root ON root.id = COALESCE(e.parent_entry_id, e.id) AND root.company_id = e.company_id
    LEFT JOIN finance.cost_centers cc ON cc.id = root.cost_center_id AND cc.company_id = root.company_id AND cc.deleted_at IS NULL
    JOIN marketing.campaigns c ON c.id = ${AGG} AND c.company_id = e.company_id
   WHERE e.company_id = :companyId AND e.entry_type = 'DEBIT' AND e.nature = 'PAYABLE' AND e.status = '${status}' AND e.${dateCol} IS NOT NULL
     AND e.reversal_of_entry_id IS NULL AND e.is_third_party_funds = false${extra}
     AND (root.origin_ref = 'campaign:' || c.id::text OR (COALESCE(root.origin_ref, '') NOT LIKE 'campaign:%' AND cc.code = c.code))
   GROUP BY 1`;

const NO_SETTLED_CHILD = ` AND NOT EXISTS (SELECT 1 FROM finance.financial_entries ch WHERE ch.parent_entry_id = e.id AND ch.company_id = e.company_id AND ch.nature = 'PAYABLE' AND ch.status = 'SETTLED')`;
const NET_CENTS = `GREATEST(0, sum(round(e.amount * 100) - COALESCE((SELECT sum(round(rv.amount * 100)) FROM finance.financial_entries rv
    WHERE rv.company_id = e.company_id AND rv.reversal_of_entry_id = e.id AND rv.entry_type = 'CREDIT' AND rv.status = 'SETTLED'), 0)))`;

const OPPORTUNITY = `FROM crm.opportunities o WHERE o.company_id = :companyId AND o.deleted_at IS NULL`;
const LEAD_MONTH = sqlMonth('o.created_at');
const HAS_LEAD_EVENT = `EXISTS (SELECT 1 FROM marketing.attribution_events a WHERE a.company_id = o.company_id AND a.opportunity_id = o.id AND a.event_type = 'LEAD_CREATED'
    AND a.valid AND a.deleted_at IS NULL AND a.campaign_id = o.campaign_id)`;

const slice = () => `
  SELECT month, SUM(cost_settled) AS cost_settled, SUM(cost_planned) AS cost_planned, SUM(leads_total)::int AS leads_total, SUM(leads_last)::int AS leads_last,
         SUM(leads_first)::int AS leads_first, SUM(sales_last)::int AS sales_last, SUM(outside_window)::int AS outside_window
  FROM (
    ${part('month FROM (' + linked('SETTLED', 'settled_at', NET_CENTS, NO_SETTLED_CHILD) + ') s', { cost_settled: 'round(s.cents / 100.0, 2)' })}
    UNION ALL
    ${part('month FROM (' + linked('PENDING', 'due_at', 'sum(round(e.amount * 100))', '') + ') p', { cost_planned: 'round(p.cents / 100.0, 2)' })}
    UNION ALL
    ${part(`${LEAD_MONTH} AS month ${OPPORTUNITY} AND o.lead_source IS NOT NULL AND COALESCE(o.campaign_id, '${NIL}') = ${AGG}`,
      { leads_total: '1', leads_last: `(CASE WHEN o.campaign_id IS NOT NULL AND o.attribution_valid IS DISTINCT FROM false AND ${HAS_LEAD_EVENT} THEN 1 ELSE 0 END)` })}
    UNION ALL
    ${part(`${LEAD_MONTH} AS month ${OPPORTUNITY} AND o.lead_source IS NOT NULL AND ${AGG} <> '${NIL}' AND (
        SELECT f.campaign_id FROM marketing.attribution_events f WHERE f.company_id = o.company_id AND f.person_id = o.person_id AND f.valid AND f.deleted_at IS NULL
           AND 'FIRST' = ANY(f.touch_roles) AND f.campaign_id IS NOT NULL AND f.occurred_at <= o.created_at ORDER BY f.occurred_at DESC, f.id LIMIT 1) = ${AGG}`, { leads_first: '1' })}
    UNION ALL
    ${part(`${sqlMonth('o.closed_at')} AS month ${OPPORTUNITY} AND o.stage = 'WON' AND o.closed_at IS NOT NULL AND o.campaign_id = ${AGG} AND o.attribution_valid IS DISTINCT FROM false`, { sales_last: '1' })}
    UNION ALL
    ${part(`${sqlMonth('a.occurred_at')} AS month FROM marketing.attribution_events a WHERE a.company_id = :companyId AND ${AGG} = '${NIL}' AND a.event_type = 'SALE' AND a.valid AND a.deleted_at IS NULL
       AND a.evidence_json->>'attribution' = 'NAO_ATRIBUIDA' AND a.evidence_json->>'reason' = 'SEM_TOQUE_VALIDO_NA_JANELA'`, { outside_window: '1' })}
  ) x GROUP BY month`;

const params = async () => ({});

/** A campanha do evento: a do payload (atribuição, ciclo de vida), a da oportunidade ou a do lançamento ligado a ela; sem nenhuma, "Sem campanha". */
async function keyOf(event, { transaction }) {
  const payload = event.payloadJson || event.payload || {};
  const campaign = (id) => ({ campaign_id: UUID_RE.test(String(id || '')) ? String(id).toLowerCase() : NIL });
  if (event.eventType === 'attribution.recorded' || event.eventType.startsWith('marketing.campaign.')) return campaign(payload.campaignId);
  if (!UUID_RE.test(String(payload.id || ''))) return null;
  if (event.eventType.startsWith('crm.opportunity.')) {
    const row = await oneRow('SELECT campaign_id::text AS campaign_id FROM crm.opportunities WHERE id = :id AND company_id = :companyId', { id: payload.id, companyId: event.companyId }, transaction);
    return row ? campaign(row.campaign_id) : null;
  }
  const row = await oneRow(
    `SELECT c.id::text AS campaign_id FROM finance.financial_entries e
       LEFT JOIN finance.financial_entries root ON root.id = COALESCE(e.parent_entry_id, e.id) AND root.company_id = e.company_id
       LEFT JOIN finance.cost_centers cc ON cc.id = root.cost_center_id AND cc.company_id = root.company_id AND cc.deleted_at IS NULL
       JOIN marketing.campaigns c ON c.company_id = e.company_id AND (root.origin_ref = 'campaign:' || c.id::text OR (COALESCE(root.origin_ref, '') NOT LIKE 'campaign:%' AND cc.code = c.code))
      WHERE e.id = :id AND e.company_id = :companyId LIMIT 1`, { id: payload.id, companyId: event.companyId }, transaction
  );
  return row ? campaign(row.campaign_id) : null;
}

/** Todas as campanhas da empresa (rebuild) ou as em andamento e as alteradas há pouco (agenda), mais "Sem campanha". */
const keysSql = ({ full }) => `
  SELECT id::text AS campaign_id FROM marketing.campaigns WHERE company_id = :companyId AND deleted_at IS NULL${full ? '' : ` AND (status = 'RUNNING' OR updated_at >= ${TODAY_START} - interval '62 days')`}
  UNION SELECT '${NIL}'`;

module.exports = defineAggregateModel({
  name: 'rm_mkt_campaign_month', keyColumns: ['campaign_id', 'month'], aggregateColumns: ['campaign_id'], eventTypes: EVENTS, keyOf, params, slice, keysSql, schedule: { kind: 'keys' },
});
