'use strict';

/**
 * M9-D701 (3.3) — o conteúdo do arquivo: lido SEMPRE dos snapshots/read models e do detalhe de origem do BI, nunca do OLTP.
 *  - METRIC e DASHBOARD (empresa): uma linha para o valor principal e uma por série (dimensão) de cada indicador, com versão, status e freshness;
 *    indicador DEGRADED bloqueia a exportação inteira (409 ANALYTICS_EXPORT_DEGRADED_BLOCKED, M9-D697); em painel, indicador sem registro na data sai INCOMPLETE e
 *    sem valor (nulo != 0);
 *  - METRIC (grupo): o consolidado calculado só na leitura (M9-D625), uma linha por empresa permitida mais eliminações e consolidado;
 *  - DRILLDOWN: as linhas-fonte do filtro assinado (M9-D690), todas, até o teto `analytics.export.max_linhas`.
 * `rows` sai SEM mascarar: o worker passa por `prepareSecureRows` (M9-D700) antes de escrever o arquivo.
 */
const AppError = require('../../../utils/AppError');
const clock = require('../metrics/clock');
const { assertMetricExportable } = require('../quality/status.block');
const { consolidateMetric } = require('../metrics/consolidation.service');
const { dimensionUnit } = require('../metrics/dimensionUnit');
const { getDashboardWithWidgets } = require('../dashboardStore.service');
const { listDimensionSnapshots } = require('../dashboardReadStore.service');
const { inspectDrilldownExport, loadDrilldownExportRows } = require('../metrics/drilldown.export');
const errors = require('./export.errors');

const MISSING = new Set(['ANALYTICS_SNAPSHOT_NOT_AVAILABLE', 'ANALYTICS_METRIC_NOT_FOUND']);
const METRIC_WIDGETS = new Set(['KPI_CARD', 'TREND', 'TABLE', 'BAR']);
const METRIC_COLUMNS = ['indicador', 'versao', 'serie', 'valor', 'unidade', 'natureza', 'status'];

const iso = (v) => (v ? new Date(v).toISOString() : '');

async function readOne(ctx, code, asOfDate, optional, transaction) {
  try {
    return await assertMetricExportable(ctx, code, asOfDate, transaction);
  } catch (err) {
    if (optional && MISSING.has(err.code)) return null;
    throw err;
  }
}

function missingRow(code) {
  return { indicador: code, versao: '', serie: 'principal', valor: '', unidade: '', natureza: '', status: 'INCOMPLETE' };
}

async function metricRows(ctx, plan, codes, optional, transaction) {
  const rows = [];
  const header = [];
  const wanted = plan.filters.dimensionKeys;
  for (const code of codes) {
    const read = await readOne(ctx, code, plan.asOfDate, optional, transaction);
    if (!read) { rows.push(missingRow(code)); header.push(['indicador', `${code} | sem registro na data | status_qualidade INCOMPLETE`]); continue; }
    rows.push({ indicador: code, versao: read.version, serie: 'principal', valor: read.value, unidade: read.unit, natureza: read.valueNature, status: read.status });
    const dims = await listDimensionSnapshots({ metricCode: code, version: read.version, companyId: ctx.companyId, asOfDate: plan.asOfDate }, transaction);
    for (const d of dims.filter((x) => !wanted || wanted.includes(x.key))) {
      rows.push({ indicador: code, versao: read.version, serie: d.key, valor: d.value, unidade: dimensionUnit(d.key, read.unit), natureza: read.valueNature, status: d.status });
    }
    header.push(['indicador', `${code} | versao ${read.version} | status_qualidade ${read.status} | freshness ${read.freshness.state} (${read.freshness.label}) | sourceSnapshotAt ${iso(read.sourceSnapshotAt)}`]);
  }
  return { columns: METRIC_COLUMNS, rows, header };
}

async function groupRows(ctx, plan, transaction) {
  const out = await consolidateMetric(ctx, { metricCode: plan.code, groupId: plan.groupId, asOfDate: plan.asOfDate }, transaction);
  if (out.consolidatedStatus === 'DEGRADED') throw AppError.conflict('O indicador está com dado incompleto e não pode ser exportado agora.', 'ANALYTICS_EXPORT_DEGRADED_BLOCKED', { metricCode: plan.code });
  const rows = out.byCompany.map((c) => ({ indicador: plan.code, empresa: c.companyName, valor: c.value, unidade: out.unit, status: c.status }));
  rows.push({ indicador: plan.code, empresa: 'Eliminações do grupo', valor: out.eliminations, unidade: out.unit, status: out.status });
  rows.push({ indicador: plan.code, empresa: 'Consolidado', valor: out.value, unidade: out.unit, status: out.status });
  return {
    columns: ['indicador', 'empresa', 'valor', 'unidade', 'status'], rows,
    header: [['indicador', `${plan.code} | consolidado do grupo | status_qualidade ${out.status} | sourceSnapshotAt ${iso(out.sourceSnapshotAt)}`]],
  };
}

async function dashboardCodes(access, transaction) {
  const { widgets } = await getDashboardWithWidgets(access.dashboard.id, transaction);
  return [...new Set(widgets.filter((w) => METRIC_WIDGETS.has(w.widget_type) && w.metric_code).map((w) => w.metric_code))];
}

/** Data vira texto ISO antes do mascarador (que copia objetos por propriedade e esvaziaria a data). */
const plain = (value) => (value instanceof Date ? value.toISOString() : value);

function flattenDrilldown(rows) {
  const fieldNames = [...new Set(rows.flatMap((r) => Object.keys(r.fields || {})))];
  return {
    columns: ['id', ...fieldNames, 'contribuicao', 'link'],
    rows: rows.map((r) => ({ id: r.id, ...Object.fromEntries(Object.entries(r.fields || {}).map(([k, v]) => [k, plain(v)])), contribuicao: r.contribution, link: r.link })),
  };
}

/** { header, columns, rows, drilldown? } — o cabeçalho de rastreabilidade (M9-D701 3.3) é acrescentado de usuário, período e escopo. */
async function collectExportRows(ctx, plan, access, transaction, { maxRows }) {
  let body;
  if (plan.kind === 'DRILLDOWN') {
    await readOne(ctx, plan.code, plan.asOfDate, true, transaction); // indicador DEGRADED não sai pelo detalhe; sem registro na data não há o que bloquear
    const loaded = await loadDrilldownExportRows(ctx, plan.drilldown, transaction, { maxRows, tooLarge: errors.tooLarge });
    const flat = flattenDrilldown(loaded.rows);
    body = { ...flat, header: [['detalhe', `${plan.code} | ${loaded.description} | modo ${loaded.mode} | linhas ${loaded.count}`]], rawRows: loaded.rows };
  } else if (plan.level === 'GROUP') {
    body = await groupRows(ctx, plan, transaction);
  } else {
    const codes = plan.kind === 'DASHBOARD' ? await dashboardCodes(access, transaction) : [plan.code];
    body = await metricRows(ctx, plan, codes, plan.kind === 'DASHBOARD', transaction);
  }
  if (body.rows.length > maxRows) throw errors.tooLarge(body.rows.length, maxRows);
  const header = [
    ['exportacao', `${plan.kind} ${plan.code}${access.name ? ` (${access.name})` : ''}`],
    ['periodo', plan.asOfDate],
    ['escopo', plan.level === 'GROUP' ? `grupo ${ctx.groupId}` : `empresa ${ctx.companyId}`],
    ['usuario', ctx.actorUserId],
    ['gerado_em', clock.now().toISOString()],
    ['filtros', JSON.stringify(plan.filters)],
    ...body.header,
  ];
  return { ...body, header };
}

/** Linhas que o arquivo terá (define o risco): conta sem ler as linhas-fonte. */
async function estimateExportRows(ctx, plan, access, transaction) {
  if (plan.kind === 'DRILLDOWN') {
    await readOne(ctx, plan.code, plan.asOfDate, true, transaction);
    return (await inspectDrilldownExport(ctx, plan.drilldown, transaction)).count;
  }
  const collected = await collectExportRows(ctx, plan, access, transaction, { maxRows: Number.MAX_SAFE_INTEGER });
  return collected.rows.length;
}

module.exports = { collectExportRows, estimateExportRows };
