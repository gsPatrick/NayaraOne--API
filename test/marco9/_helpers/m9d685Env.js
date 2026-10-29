'use strict';

// Apoio dos testes do Centro de Comando (M9-D685): publica os KPIs das origens do mapa 3.2-A para a empresa de teste e grava, para cada um, o snapshot da data-base com o
// resultado ESCOLHIDO pelo cenário (valor e dimensões no formato que o KPI grava). Fila de decisão, alertas e briefing são gravados por superusuário (sem FK, só o que o
// teste precisa). Relógio fixo em 28/10/2026 12:00 de São Paulo. Banco descartável (127.0.0.1).
const crypto = require('node:crypto');
const kit = require('./painelKitEnv');
const kpis = require('../../../src/features/analytics/metrics/kpis');
const { ensureCommercialKpisPublished } = require('../../../src/features/analytics/metrics/kpis/commercial');
const alertDefs = require('../../../src/features/analytics/alertDefinitionStore.service');
const alertInstances = require('../../../src/features/analytics/alertInstanceStore.service');
const { DEPENDS_ON } = require('../../../src/features/analytics/dashboards/command/command.map');

const OWN = '^(fin|obra|inv|cor|legal|rent|crm|radar|prop|tec|ai)[.]';
const ALL_CODES = [...new Set(Object.values(DEPENDS_ON).flat())];
const READ_ALL = ['analytics:read', 'analytics:brief:read', 'finance:read', 'inventory:read', 'legal:read', 'construction:read', 'correspondent:read', 'crm:opportunities:read', 'analytics:read:tech'];
const DIRECTOR = READ_ALL;
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');
const uuid = () => crypto.randomUUID();

const env = kit.makeEnv({
  own: OWN,
  publish: async (scope, tx) => {
    await kpis.ensureFinanceKpisPublished(scope, tx);
    await kpis.ensureCrmKpisPublished(scope, tx);
    await ensureCommercialKpisPublished(scope, tx);
    await kpis.ensureObraKpisPublished(scope, tx);
    await kpis.obraPerdasKpis.ensurePublished(scope, tx);
    await kpis.estoqueKpis.ensurePublished(scope, tx);
    await kpis.ensureLegalKpisPublished(scope, tx);
    await kpis.ensureCorrespondentKpisPublished(scope, tx);
    await kpis.ensureRentalDeadlineKpisPublished(scope, tx);
    await kpis.ensureTechKpisPublished(scope, tx);
    await kpis.ensureCommandEventKpisPublished(scope, tx);
    await kpis.decisionQueueKpis.ensurePublished(scope, tx);
  },
});

const ok = (value, dims = []) => ({ value, status: 'OK', dimensions: dims.map(([key, v]) => ({ key, value: v })) });

/** Cenário-base: todo indicador das origens do mapa com valor e dimensões escolhidos, para o Centro de Comando ter o que mostrar. */
function baseResults() {
  return {
    'legal.contracts_signed': ok('3', [['valor_brl', '90000.00'], ['anterior_qtd', '1'], ['anterior_valor_brl', '30000.00']]),
    'crm.opportunities_won': ok('2', [['valor_brl', '500000.00'], ['anterior_qtd', '2'], ['anterior_valor_brl', '400000.00']]),
    'fin.payments_settled_relevant': ok('1', [['valor_brl', '12000.00'], ['anterior_qtd', '0'], ['anterior_valor_brl', '0.00']]),
    'fin.approvals_pending': ok('0'), 'inv.adjustments_pending': ok('0'), 'tec.rule_approvals_pending': ok('0'), 'ai.proposals_pending': ok('0'),
    'fin.anomalies_open': ok('4', [['alto', '2'], ['risco:ALTO', '2'], ['risco:BAIXO', '2']]),
    'legal.cases_by_risk': ok('6', [['risco:HIGH', '2'], ['risco:CRITICAL', '1'], ['risco:LOW', '3']]),
    'rent.guarantees_expiring': ok('5', [['vencendo_30d_qtd', '4'], ['vencendo_60d_qtd', '5'], ['vencidas_qtd', '1']]),
    'obra.projected_margin': ok('100000.00', [['margem_pct', '12.00'], ['obra:aaaaaaaa-0000-4000-8000-000000000001', '30000.00'], ['obra:aaaaaaaa-0000-4000-8000-000000000001:margem_pct', '6.00'],
      ['obra:bbbbbbbb-0000-4000-8000-000000000002', '70000.00'], ['obra:bbbbbbbb-0000-4000-8000-000000000002:margem_pct', '20.00']]),
    'tec.integration_errors': ok('3.00', [['acima_do_slo_qtd', '1'], ['provider:wa-main:erro_pct', '12.00']]),
    'fin.overdue_receivables': ok('16000.00'),
    'obra.measurements': ok('100000.00', [['aprovado_brl', '60000.00'], ['pendente_brl', '40000.00']]),
    'cor.commission': ok('50000.00', [['confirmada_brl', '30000.00'], ['recebida_brl', '7000.00'], ['a_receber_brl', '23000.00']]),
    'fin.owner_repasses_pending': ok('9000.00', [['quantidade_qtd', '3'], ['vencidos_alerta_brl', '5000.00'], ['vencidos_alerta_qtd', '1']]),
    'inv.losses': ok('1500.00'), 'obra.waste': ok('800.00'), 'obra.postwork_cost': ok('2700.00'),
    'legal.deadlines': ok('7', [['proximos_7d_qtd', '2'], ['ate_30d_qtd', '4'], ['vencidos_qtd', '1'], ['mais_antigo_vencido_dias', '9']]),
    'fin.payables_7d': ok('18000.00'),
    'obra.delays': ok('3', [['maximo_dias', '12'], ['obras_com_atraso_qtd', '1'], ['obra:aaaaaaaa-0000-4000-8000-000000000001', '2'], ['obra:aaaaaaaa-0000-4000-8000-000000000001:maximo_dias', '12']]),
    'rent.inspections_keys': ok('4', [['vistorias_atrasadas_qtd', '1'], ['chaves_fora_qtd', '2'], ['chaves_atrasadas_qtd', '1']]),
    'crm.opportunities_by_stage': ok('20', [['paradas_qtd', '3']]),
    'crm.proposals': ok('8', [['em_aberto', '5'], ['valor_total_brl', '2400000.00']]),
    'radar.matches': ok('85', [['enviados', '80'], ['convertidos', '9']]),
    'prop.without_sale_by_period': ok('140', [['faixa:ATE_30', '40'], ['faixa:31_A_90', '48'], ['faixa:91_A_180', '30'], ['faixa:ACIMA_180', '22'], ['sem_data', '0']]),
  };
}

/** Regrava (apaga antes) os snapshots do cenário; `over` troca o resultado de alguns códigos; `degraded` e `stale` listam códigos. */
async function seedScenario(e, over = {}, { degraded = [], stale = [], skip = [] } = {}) {
  await env.cleanup(e, e.tenantA);
  await env.publishAll(e.tenantA);
  const results = { ...baseResults(), ...over };
  for (const code of ALL_CODES) {
    if (skip.includes(code)) continue;
    await env.seedMetric(e.tenantA, code, { degraded: degraded.includes(code), stale: stale.includes(code), result: degraded.includes(code) ? undefined : results[code] });
  }
}

async function clearQueueAndAlerts(e, t) {
  await e.admin.transaction(async (transaction) => {
    await e.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const table of ['rm_decision_queue']) await e.admin.query(`DELETE FROM analytics.${table} WHERE company_id = :c`, { replacements: { c: t.companyId }, transaction });
    await e.admin.query('DELETE FROM analytics.alert_instances WHERE company_id = :c', { replacements: { c: t.companyId }, transaction });
    await e.admin.query('DELETE FROM analytics.alert_definitions WHERE company_id = :c', { replacements: { c: t.companyId }, transaction });
    await e.admin.query("DELETE FROM analytics.executive_briefs WHERE company_id = :c", { replacements: { c: t.companyId }, transaction }).catch(() => {});
    await e.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key LIKE 'analytics.centro.%'", { replacements: { c: t.companyId }, transaction });
  });
}

/** Item da fila de decisão (superusuário; o read model é do worker). hours = idade em horas contada a partir do relógio fixo do teste. */
async function queueItem(e, t, { kind = 'FIN_APPROVAL', hours = 5, title = 'Aprovação de teste', amount = '1000.00', status = 'PENDING' } = {}) {
  const requested = new Date(env.NOW.getTime() - hours * 3600000).toISOString();
  await e.admin.query(
    `INSERT INTO analytics.rm_decision_queue (company_id, group_id, kind, source_type, source_id, title, amount, requested_at, requested_by, owner_role, status, decided_at)
     VALUES (:c, :g, :kind, 'teste', :id, :title, :amount, :requested, :u, 'diretoria', :status, CASE WHEN :status = 'PENDING' THEN NULL ELSE now() END)`,
    { replacements: { c: t.companyId, g: t.groupId, kind, id: uuid(), title, amount, requested, u: t.userId, status } }
  );
}

/** Alerta de verdade (definição publicada + instância) e ajuste de estado/datas pelo superusuário. status: OPEN | ACKNOWLEDGED | RESOLVED. */
async function alertOf(e, t, { metricCode = 'fin.free_cash', severity = 'CRITICAL', status = 'OPEN', ownerRole = 'Diretoria', hoursAgo = 2, resolvedHoursAgo = 1 } = {}) {
  const ctx = { groupId: t.groupId, companyId: t.companyId, actorUserId: t.userId, permissions: [] };
  const code = `m9d685_${sha(uuid()).slice(0, 10)}`;
  const instance = await env.http.inTx(t, { commit: true, writer: true }, async (tx) => {
    const def = await alertDefs.createAlertDefinition({
      scopeLevel: 'COMPANY', companyId: t.companyId, groupId: t.groupId, alertCode: code, metricCode, metricVersionPin: null, conditionType: 'THRESHOLD', threshold: { operator: 'LT', value: 50000 },
      ruleId: null, severity, ownerRole, cooldownMinutes: null, autoResolvePolicy: {}, scope: {}, createTask: false,
    }, ctx, tx);
    await alertDefs.publishAlertDefinition(def.id, ctx, tx);
    return alertInstances.openAlertInstance({ alertDefinitionId: def.id, companyId: t.companyId, groupId: t.groupId, fingerprint: sha(def.id), severity, lastValue: '1000' }, ctx, tx);
  });
  const opened = new Date(env.NOW.getTime() - hoursAgo * 3600000).toISOString();
  const resolved = new Date(env.NOW.getTime() - resolvedHoursAgo * 3600000).toISOString();
  await e.admin.transaction(async (transaction) => {
    await e.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    const set = status === 'ACKNOWLEDGED' ? ", status = 'ACKNOWLEDGED', acknowledged_at = :opened, acknowledged_by = :u"
      : status === 'RESOLVED' ? ", status = 'RESOLVED', resolved_at = :resolved, resolved_reason = 'CONDITION_NORMALIZED'" : '';
    await e.admin.query(`UPDATE analytics.alert_instances SET opened_at = :opened${set} WHERE id = :id`, { replacements: { id: instance.id, opened, resolved, u: t.userId }, transaction });
  });
  return { id: instance.id, code };
}

/** Snapshot de `code` num dia anterior (a variação do bloco 1 compara a data-base com a janela anterior). */
async function seedAt(e, code, asOfDate, result) {
  const store = require('../../../src/features/analytics/metricStore.service');
  const { calcHash } = require('../../../src/features/analytics/metrics/calcHash');
  const t = e.tenantA;
  return env.http.inTx(t, { commit: true, writer: true }, async (tx) => {
    const [[ids]] = await tx.sequelize.query(
      `SELECT d.id AS "metricId", v.id AS "metricVersionId" FROM analytics.metric_definitions d JOIN analytics.metric_versions v ON v.id = d.current_version_id
        WHERE d.metric_code = :code AND d.company_id = :c`, { replacements: { code, c: t.companyId }, transaction: tx });
    const base = {
      ...ids, groupId: t.groupId, companyId: t.companyId, scopeType: 'COMPANY', scopeId: t.companyId, periodStart: asOfDate, periodEnd: asOfDate, asOfDate, status: result.status,
      sourceSnapshotAt: `${asOfDate}T20:00:00Z`, refreshedAt: `${asOfDate}T20:05:00Z`, sourceRefs: [], calcHash: calcHash({ code, result, asOfDate }),
    };
    await store.recordSnapshot({ ...base, dimensionKey: '', valueNumeric: result.value }, tx);
  });
}

/** Briefing vigente do dia (superusuário; a geração é da M9-D693). */
async function briefOf(e, t, { status = 'GENERATED', items = [] } = {}) {
  await e.admin.transaction(async (transaction) => { // o briefing gravado não se altera: troca por outro
    await e.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    await e.admin.query('DELETE FROM analytics.executive_briefs WHERE company_id = :c', { replacements: { c: t.companyId }, transaction });
  });
  await e.admin.query(
    `INSERT INTO analytics.executive_briefs (company_id, group_id, brief_type, period_start, period_end, status, content, source_refs, blocked_reason)
     VALUES (:c, :g, 'DAILY', '2026-10-27', '2026-10-27', :status, CAST(:content AS jsonb), CAST(:refs AS jsonb), :reason)`,
    { replacements: { c: t.companyId, g: t.groupId, status, content: JSON.stringify({ itens: items, fechamento: 'Resumo do dia.' }), refs: JSON.stringify([{ metricCode: 'fin.free_cash' }]), reason: status === 'GENERATED' ? null : 'teste' } }
  );
}

/** Parâmetro do administrador da empresa (superusuário; o serviço de parâmetros lê core.tenant_settings). */
async function setSetting(e, t, key, value) {
  await clearSetting(e, t, key);
  await e.admin.query('INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, created_at, updated_at) VALUES (gen_random_uuid(), :g, :c, :key, CAST(:value AS jsonb), now(), now())', { replacements: { g: t.groupId, c: t.companyId, key, value: JSON.stringify(value) } });
}
const clearSetting = (e, t, key) => e.admin.query('DELETE FROM core.tenant_settings WHERE company_id = :c AND key = :key', { replacements: { c: t.companyId, key } });

const openCenter = (e, { perms = DIRECTOR, query = `asOf=${env.AS_OF}`, tenant = 'A' } = {}) => env.openPanel(e, 'command_center', { perms, query, tenant });
const blockOf = (res, key) => res.body.data.blocks.find((b) => b.key === key);

module.exports = { ...env, OWN, ALL_CODES, READ_ALL, DIRECTOR, baseResults, seedScenario, clearQueueAndAlerts, queueItem, alertOf, seedAt, briefOf, setSetting, clearSetting, openCenter, blockOf, uuid, sha };
