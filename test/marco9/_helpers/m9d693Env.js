'use strict';

// Apoio dos testes do briefing da NAY Diretoria (M9-D693 e M9-D694): relógio fixo (quarta-feira 06:40 em São Paulo), métricas com registro
// dos dois dias comparados, painel publicado, alertas e a NAY simulada (porta runAgent) que lê os DADOS que o servidor montou e escreve itens.
// Banco descartável (127.0.0.1). Tudo roda em transação com rollback.
const crypto = require('node:crypto');
const base = require('./m9d695Env');
const clock = require('../../../src/features/analytics/metrics/clock');
const dashboardStore = require('../../../src/features/analytics/dashboardStore.service');
const alertDefs = require('../../../src/features/analytics/alertDefinitionStore.service');
const alertInstances = require('../../../src/features/analytics/alertInstanceStore.service');
const { TenantSetting } = require('../../../src/models');
const { purgeBriefResidue } = require('./m9d693Purge');

const { sup, registry, inTx } = base;
const NOW = '2026-10-28T09:40:00Z';
const DAY = Object.freeze({ current: '2026-10-27', previous: '2026-10-26' });
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

async function setup() {
  const env = await base.setup();
  await purgeBriefResidue(env); // independente de resto deixado por outros arquivos no mesmo banco
  clock.setClock(() => new Date(NOW));
  return env;
}

async function teardown(env) {
  clock.resetClock();
  await base.teardown(env);
}

/** Indicador financeiro com registro nos dois dias (D-1 e D-2). `current`/`previous` null = sem registro no dia. */
async function metric(env, tenant, tx, { current = '112000.00', previous = '130000.00', status = 'OK', previousStatus = 'OK', code, sourceAt = null, refreshedAt = null, secondVersion = false, days = DAY, extraDays = [] } = {}) {
  const { definition, version } = await registry.publishMetric(sup.metricInput(env, { dimensions: ['company'], ...(code ? { metricCode: code } : {}) }), sup.ctxOf(tenant), tx, { catalog: env.catalog });
  await sup.metrics.enableAnalyticsWriter(tx);
  let currentVersion = version;
  if (secondVersion) { // v2 vigente a partir do dia atual do período: o dia anterior é da v1 e o atual da v2 (M9-D694, mudança de fórmula entre períodos)
    await registry.publishVersion(definition.metric_code, {
      version: 2, validFrom: DAY.current, changeReason: 'Recebíveis do dia deixam de entrar no caixa livre.', formulaSemantic: 'Soma dos saldos sem os recebíveis do dia.',
    }, sup.ctxOf(tenant), tx, { catalog: env.catalog, now: new Date('2026-10-20T12:00:00Z') });
    currentVersion = (await sup.metrics.getMetricVersionAt(definition.id, DAY.current, tx)) || version;
  }
  const rows = [[days.previous, previous, previousStatus, `${days.previous}T20:00:00Z`, `${days.previous}T20:05:00Z`, version], [days.current, current, status, sourceAt || `${days.current}T20:00:00Z`, refreshedAt || `${days.current}T20:05:00Z`, currentVersion],
    ...extraDays.map(([day, value]) => [day, value, 'OK', `${day}T20:00:00Z`, `${day}T20:05:00Z`, currentVersion])]; // dias seguintes com o seu valor
  for (const [day, value, st, source, refreshed, ver] of rows) {
    if (value === null) continue;
    await sup.metrics.recordSnapshot({
      groupId: tenant.groupId, companyId: tenant.companyId, metricId: definition.id, metricVersionId: ver.id, scopeType: 'COMPANY', scopeId: tenant.companyId,
      dimensionKey: '', periodStart: day, periodEnd: day, asOfDate: day, valueNumeric: value, status: st, sourceSnapshotAt: source, refreshedAt: refreshed,
      sourceRefs: [{ type: 'TABLE', table: 'x', filterHash: sha(`f${day}`), filterSignature: 'assinatura', count: 1 }],
      calcHash: sha(`${definition.id}${day}${value}`),
    }, tx);
  }
  return { definition, version, code: definition.metric_code };
}

/** Indicador de motivos (dimensão `motivo`): um registro gravado por motivo no dia atual do período. É o registro de causa que a NAY pode citar. */
async function causeMetric(env, tenant, tx, { code, reasons }) {
  const { definition, version } = await registry.publishMetric(sup.metricInput(env, { dimensions: ['motivo'], metricCode: code, unit: 'COUNT' }), sup.ctxOf(tenant), tx, { catalog: env.catalog });
  await sup.metrics.enableAnalyticsWriter(tx);
  for (const [reason, value] of Object.entries(reasons)) {
    await sup.metrics.recordSnapshot({
      groupId: tenant.groupId, companyId: tenant.companyId, metricId: definition.id, metricVersionId: version.id, scopeType: 'COMPANY', scopeId: tenant.companyId,
      dimensionKey: `motivo=${reason}`, periodStart: DAY.current, periodEnd: DAY.current, asOfDate: DAY.current, valueNumeric: value, status: 'OK',
      sourceSnapshotAt: '2026-10-27T20:00:00Z', refreshedAt: '2026-10-27T20:05:00Z',
      sourceRefs: [{ type: 'TABLE', table: 'x', filterHash: sha(`c${reason}`), filterSignature: 'assinatura', count: 1 }], calcHash: sha(`${definition.id}${reason}${value}`),
    }, tx);
  }
  return { definition, code: definition.metric_code };
}

/** Painel PUBLICADO da empresa com os indicadores como widgets; `config` por indicador (semáforo). Audiência vazia = todos os papéis. */
async function panel(tenant, tx, { code = `m9d693_${sup.sfx()}`, metrics, audienceRoles = [], requiredPermission = 'analytics:read' }) {
  await sup.metrics.enableAnalyticsWriter(tx);
  const ctx = sup.ctxOf(tenant);
  const draft = await dashboardStore.createDashboardDefinition({
    scopeLevel: 'COMPANY', groupId: tenant.groupId, companyId: tenant.companyId, dashboardCode: code, name: 'Painel QA-M9', domain: 'GENERAL', audienceRoles,
    layout: {}, requiredPermission, p95TargetMs: 1000,
  }, ctx, tx);
  await dashboardStore.addDashboardWidget(draft.id, { widgetType: 'QUALITY_BANNER', title: 'Qualidade dos dados', position: 0 }, ctx, tx); // regra da D687: a faixa de qualidade é o primeiro bloco
  for (const [i, m] of metrics.entries()) {
    await dashboardStore.addDashboardWidget(draft.id, { widgetType: 'KPI_CARD', metricCode: m.code, title: m.code, position: i + 1, config: m.config || {} }, ctx, tx);
  }
  return dashboardStore.publishDashboard(draft.id, ctx, tx);
}

/** Alerta publicado sobre o indicador e uma instância (OPEN ou RESOLVED) dele. */
async function alert(tenant, tx, { metricCode, severity = 'CRITICAL', resolved = false, lastValue = null }) {
  await sup.metrics.enableAnalyticsWriter(tx);
  const ctx = sup.ctxOf(tenant);
  const def = await alertDefs.createAlertDefinition({
    scopeLevel: 'COMPANY', companyId: tenant.companyId, groupId: tenant.groupId, alertCode: `al_${sup.sfx()}`, metricCode, metricVersionPin: null,
    conditionType: 'THRESHOLD', threshold: { operator: 'LT', value: 50000 }, ruleId: null, severity, ownerRole: 'CFO', cooldownMinutes: null, autoResolvePolicy: {}, scope: {}, createTask: false,
  }, ctx, tx);
  await alertDefs.publishAlertDefinition(def.id, ctx, tx);
  const inst = await alertInstances.openAlertInstance({ alertDefinitionId: def.id, companyId: tenant.companyId, groupId: tenant.groupId, fingerprint: sha(def.id), severity, lastValue }, ctx, tx);
  return resolved ? alertInstances.resolveAlertInstance(inst.id, ctx, tx) : inst;
}

/** Contagem exata de linhas de todas as tabelas dos schemas dados: prova que uma operação não escreveu fora de onde devia. */
async function rowCounts(tx, schemas) {
  const [tables] = await base.sequelize.query(
    "SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema IN (:schemas) ORDER BY 1, 2",
    { replacements: { schemas }, transaction: tx }
  );
  const out = {};
  for (const { s, t } of tables) out[`${s}.${t}`] = (await base.sequelize.query(`SELECT count(*)::int AS n FROM "${s}"."${t}"`, { transaction: tx }))[0][0].n;
  return out;
}

const setting = (tenant, tx, key, value) => TenantSetting.create({ groupId: tenant.groupId, companyId: tenant.companyId, key, value }, { transaction: tx });

// ---------------------------------------------------------------------------------------------------- a NAY simulada

const brl = (n) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const entradaOf = (request) => JSON.parse(request.instruction.split('DADOS:\n')[1]);

/** Item honesto: só números e fatos que vieram nos DADOS, sem causa. */
function honestItem(i) {
  const fato = i.valor ? `${i.nome}: ${brl(i.valor.valor)}.` : `${i.nome}: alerta aberto.`;
  const variacao = i.variacao ? `Variação de ${brl(i.variacao.absoluta)} (${brl(i.variacao.percentual)}%) contra ${i.variacao.periodoAnterior.endDate}.` : '';
  return { refId: i.refId, tipo: i.tipoSugerido, fato, variacao, fonte: [{ metricCode: i.metricCode }], incerteza: '', acaoSugerida: 'Acompanhar o indicador.', tipoAfirmacao: 'FATO' };
}

/** NAY simulada: `build(entrada, request)` devolve o objeto de saída (ou um outcome completo com `ok`). Guarda os pedidos em `.calls`. */
function agent(build = (entrada) => ({ itens: entrada.itens.map(honestItem) })) {
  const calls = [];
  const runAgent = async (request) => {
    calls.push(request);
    const out = build(entradaOf(request), request);
    if (out && typeof out.ok === 'boolean') return out;
    return { ok: true, runId: crypto.randomUUID(), answer: typeof out === 'string' ? out : JSON.stringify(out) };
  };
  runAgent.calls = calls;
  return runAgent;
}

const scopeOf = (tenant) => ({ groupId: tenant.groupId, companyId: tenant.companyId });
const readerOf = (tenant, permissions) => ({ groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: tenant.userId, permissions });

module.exports = { ...base, NOW, DAY, sha, setup, teardown, metric, causeMetric, panel, alert, setting, rowCounts, agent, honestItem, entradaOf, brl, scopeOf, readerOf, clock, inTx };
