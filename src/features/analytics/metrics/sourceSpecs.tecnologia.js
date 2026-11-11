'use strict';

/**
 * M9-D680 / M9-D611 / M9-D690 — origem dos números dos KPIs de Tecnologia: quais registros reproduzem cada KPI. O sinal técnico (sondas, falhas de login e de MFA) é global e não tem
 * empresa, então a origem de disponibilidade, autenticação e bloqueios é a cópia da empresa no read model (rm_tech_*, DI-D628-1), identificada pela linha física (ctid: o read
 * model tem chave composta e sem id). Integrações: as linhas de integration.provider_health da última janela fechada de cada connection ativa (o detalhe do KPI CRITICAL, soma de chamadas e
 * erros refeita pela fórmula). Filas: os eventos do outbox aguardando; a inbox soma no KPI pelo read model (DI-D680-4, como a origem de Locação em DI-D641-4). Freshness: o histórico de
 * atualizações dos read models. O detalhe só devolve ids e códigos a quem tem analytics:drilldown e analytics:read:tech; nenhum payload, segredo, e-mail ou IP nas colunas.
 */
const { registerSourceSpec, getSourceSpec } = require('./sourceRefs.spec');
const { registerDrilldownDetail } = require('./drilldown.details');
const { DEFINITIONS } = require('./kpis/tecnologia/definitions');
const clock = require('./clock');

/** O read model de cada KPI vem das definições (a varredura de segurança M9-D700 só deixa citar o nome do read model na camada read-models e nas definições). */
const RM = Object.freeze(Object.fromEntries(DEFINITIONS.map((d) => [d.metricCode, `analytics.${d.sourceReadModel}`])));

const NO_RESTRICTION = { sql: 'TRUE', replacements: {} };
const windowOf = (filter) => (filter.equals || {}).tecWindow;

/**
 * DI-BI-7: "fechada" é medida no instante do read model (`tecClosedBy`, o source_snapshot_at que o filtro assinado carrega), com o relógio do BI (M9-D606), nunca com o now()
 * do banco. Filtro assinado antes do DI-BI-7 (só `tecWindow`) usa o relógio do BI no instante da leitura.
 */
const closedByOf = (filter) => (filter.equals || {}).tecClosedBy || clock.now().toISOString();

/** Última janela FECHADA (DI-BI-5) de cada connection ATIVA na janela configurada; sem o marcador (consulta bruta da prova da M9-D712) a origem é a tabela inteira da empresa. */
const lastActiveWindow = (filter) => (windowOf(filter) === undefined ? NO_RESTRICTION : {
  sql: `(t."window_minutes" = :tecWindow AND t."window_start" = (SELECT max(h."window_start") FROM integration.provider_health h WHERE h."connection_id" = t."connection_id" AND h."window_minutes" = t."window_minutes"
      AND h."window_start" + make_interval(mins => h."window_minutes") <= CAST(:tecClosedBy AS timestamptz))
    AND EXISTS (SELECT 1 FROM integration.connections c WHERE c."id" = t."connection_id" AND c."company_id" = t."company_id" AND c."status" = 'ACTIVE'))`,
  replacements: { tecWindow: windowOf(filter), tecClosedBy: closedByOf(filter) },
});

const day = (value) => (value ? String(value).slice(0, 10) : null);
const RM_DAY = { idColumn: 'ctid', columns: { period: 'day' } };
const SPECS = [
  {
    metricCode: 'tec.availability', type: 'PROBE_DAYS', table: RM['tec.availability'], ...RM_DAY, formulaId: 'tec.availability', rowColumns: ['probe', 'checks', 'up', 'expected'], formulaParams: {},
    describe: (f) => `Sondas de saúde por dia de ${day(f.period && f.period.from)} até antes de ${day(f.period && f.period.to)} (cópia da empresa do registro de sinais técnicos)`,
  },
  {
    metricCode: 'tec.queues_dlq', type: 'OUTBOX_EVENTS', table: 'integration.outbox_events', columns: { status: 'status' },
    describe: () => 'Eventos do outbox aguardando (PENDING); a fila de entrada (inbox) e a DLQ entram no número pelo read model',
  },
  {
    metricCode: 'tec.integration_errors', type: 'PROVIDER_HEALTH', table: 'integration.provider_health', columns: {}, flags: ['tecWindow', 'tecClosedBy'], predicates: [lastActiveWindow],
    formulaId: 'tec.integration_errors', rowColumns: ['provider_code', 'calls_total', 'calls_failed'], formulaParams: {},
    describe: (f) => `Saúde das connections ativas na última janela fechada de ${(f.equals || {}).tecWindow || 'qualquer'} minutos (chamadas e erros por fornecedor)`,
  },
  {
    metricCode: 'tec.freshness', type: 'READ_MODEL_REFRESHES', table: 'analytics.read_model_refreshes', columns: { status: 'status' },
    describe: () => 'Atualizações bem-sucedidas dos read models do BI (a idade e o estado saem do source_snapshot_at mais recente de cada um)',
  },
  {
    metricCode: 'tec.auth_failures', type: 'AUTH_FAILURES', table: RM['tec.auth_failures'], ...RM_DAY, valueColumn: 'failures', reconcileMode: 'SUM',
    describe: (f) => `Falhas de autenticação do dia ${day(f.period && f.period.from)} (login, MFA e integração), sem identificar ninguém`,
  },
  {
    metricCode: 'tec.blocked_events', type: 'BLOCKED_EVENTS', table: RM['tec.blocked_events'], ...RM_DAY, valueColumn: 'blocked', reconcileMode: 'SUM',
    describe: (f) => `Eventos bloqueados no dia ${day(f.period && f.period.from)}, por motivo e tipo de evento`,
  },
];

const DETAIL = {
  'tec.availability': { columns: ['probe', 'day', 'checks', 'up', 'expected'], link: '/painel/configuracoes' },
  'tec.queues_dlq': { columns: ['event_type', 'status', 'created_at'], link: '/painel/configuracoes' },
  'tec.integration_errors': { columns: ['provider_code', 'connection_id', 'window_minutes', 'window_start', 'calls_total', 'calls_failed'], link: '/painel/configuracoes' },
  'tec.freshness': { columns: ['read_model', 'status', 'source_snapshot_at'], link: '/painel/configuracoes' },
  'tec.auth_failures': { columns: ['day', 'kind', 'provider', 'failures', 'distinct_actors', 'peak_hour_failures'], link: '/painel/configuracoes' },
  'tec.blocked_events': { columns: ['day', 'reason', 'event_type', 'blocked'], link: '/painel/configuracoes' },
};
for (const spec of SPECS) {
  if (!getSourceSpec(spec.metricCode)) registerSourceSpec(spec);
  registerDrilldownDetail(spec.metricCode, DETAIL[spec.metricCode]);
}

module.exports = { TECH_SOURCE_CODES: SPECS.map((s) => s.metricCode) };
