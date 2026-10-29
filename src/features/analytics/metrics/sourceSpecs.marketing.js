'use strict';

/**
 * M9-D670 / M9-D671 / M9-D611 / M9-D690 — origem dos números dos KPIs de Marketing: quais registros do módulo reproduzem cada KPI (campanhas, despesas ligadas a
 * campanhas no Financeiro, leads do CRM com origem de marketing, eventos de atribuição, mensagens de automação ou campanha, pedidos de saída e execuções de
 * automação). O filtro (assinado) é montado por kpis/marketing/mkt.filters. O detalhe de cada KPI (drill-down; o Marketing ainda não tem tela de registro no Front, por isso sem link, exceto o CRM e o Financeiro) abre os registros do filtro e só devolve ids a quem
 * tem analytics:drilldown e a permissão de Marketing; nenhuma coluna traz telefone, e-mail, nome ou documento.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);
const span = (f) => `de ${day(f.period && f.period.from)} até antes de ${day(f.period && f.period.to)}`;
const fixed = (sql) => () => ({ sql, replacements: {} });

/** Despesa (saída) ligada a campanha: referência `campaign:` no lançamento ou centro de custo de código igual ao de uma campanha (regra do custo real do Marketing, M9-D432). */
const LINKED_TO_CAMPAIGN = fixed(`(t."entry_type" = 'DEBIT' AND t."nature" = 'PAYABLE' AND t."is_third_party_funds" = false AND t."reversal_of_entry_id" IS NULL
  AND (COALESCE(t."origin_ref", '') LIKE 'campaign:%' OR EXISTS (SELECT 1 FROM finance.cost_centers cc JOIN marketing.campaigns c ON c.company_id = cc.company_id AND c.code = cc.code
    WHERE cc.id = t."cost_center_id" AND cc.company_id = t."company_id" AND cc.deleted_at IS NULL AND c.deleted_at IS NULL)))`);
const MARKETING_MESSAGE = fixed('(t."action_key" IS NOT NULL)');

const SPECS = [
  { metricCode: 'mkt.campaigns', type: 'CAMPAIGNS', table: 'marketing.campaigns', columns: { status: 'status' }, predicates: [fixed('(t."deleted_at" IS NULL)')], describe: () => 'Campanhas de marketing da empresa em qualquer estado' },
  {
    metricCode: 'mkt.cost', type: 'CAMPAIGN_EXPENSES', table: 'finance.financial_entries', valueColumn: 'amount', columns: { period: 'settled_at', status: 'status', nature: 'nature' }, predicates: [LINKED_TO_CAMPAIGN],
    describe: (f) => `Despesas liquidadas ligadas a campanhas ${span(f)}`,
  },
  { metricCode: 'mkt.leads', type: 'MARKETING_LEADS', table: 'crm.opportunities', columns: { period: 'created_at' }, predicates: [fixed('(t."deleted_at" IS NULL AND t."lead_source" IS NOT NULL)')], describe: (f) => `Leads com origem de marketing criados ${span(f)}` },
  {
    metricCode: 'mkt.attribution', type: 'ATTRIBUTION_EVENTS', table: 'marketing.attribution_events', columns: { period: 'occurred_at', status: 'event_type' }, predicates: [fixed('(t."deleted_at" IS NULL AND t."valid" = true)')],
    describe: (f) => `Eventos de atribuição de lead gravados pelo Marketing ${span(f)}; o custo por lead usa o custo liquidado das campanhas no mesmo período`,
  },
  {
    metricCode: 'mkt.deliverability', type: 'MARKETING_MESSAGES', table: 'crm.messages', columns: { period: 'created_at', equals: { direction: 'direction' } }, predicates: [MARKETING_MESSAGE],
    describe: (f) => `Mensagens de saída de automação ou campanha ${span(f)}; entregues são as com status DELIVERED ou READ`,
  },
  {
    metricCode: 'mkt.opt_out', type: 'OPT_OUT_REQUESTS', table: 'marketing.suppression_list', columns: { period: 'created_at', equals: { reason: 'reason' } }, predicates: [fixed('(t."deleted_at" IS NULL)')],
    describe: (f) => `Pedidos de saída (opt-out) registrados ${span(f)}`,
  },
  {
    metricCode: 'mkt.frequency', type: 'MARKETING_MESSAGES', table: 'crm.messages', columns: { period: 'created_at', equals: { direction: 'direction' } }, predicates: [MARKETING_MESSAGE],
    describe: (f) => `Mensagens de saída de automação ou campanha ${span(f)} (a janela de frequência), uma pessoa por destinatário`,
  },
  {
    metricCode: 'mkt.automations_blocked_failed', type: 'AUTOMATION_RUNS', table: 'marketing.automation_runs', columns: { period: 'started_at', status: 'status' }, predicates: [fixed('(t."deleted_at" IS NULL)')],
    describe: (f) => `Execuções das automações de marketing iniciadas ${span(f)}, com as bloqueadas e as com falha`,
  },
];

const DETAIL = {
  'mkt.campaigns': { columns: ['code', 'name', 'channels', 'starts_at', 'ends_at'], link: null },
  'mkt.cost': { columns: ['cost_center_id', 'due_at', 'origin_ref'], link: '/painel/financeiro' },
  'mkt.leads': { columns: ['stage', 'lead_source', 'campaign_id', 'created_at'], link: '/painel/crm' },
  'mkt.attribution': { columns: ['campaign_id', 'touch_roles', 'occurred_at'], link: null },
  'mkt.deliverability': { columns: ['channel', 'created_at'], link: null },
  'mkt.opt_out': { columns: ['channel', 'purpose', 'source'], link: null },
  'mkt.frequency': { columns: ['channel', 'purpose', 'created_at'], link: null },
  'mkt.automations_blocked_failed': { columns: ['blocked_reason', 'finished_at'], link: null },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAIL[spec.metricCode]);
}

module.exports = { MKT_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
