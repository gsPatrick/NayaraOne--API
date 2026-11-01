'use strict';

/**
 * M9-D685 — Centro de Comando da Diretoria (dashboard `command_center`): a tela inicial que responde as seis perguntas do livro (§4). Cada widget `COMMAND_BLOCK`
 * do painel publicado vira um bloco com no máximo `analytics.centro.max_itens_por_bloco` itens ordenados, o total, o contador de itens que o usuário não pode ver e
 * o link "Ver todos". Bloco que depende de indicador DEGRADED, INCOMPLETE ou STALE mostra "Conclusão adiada: dado incompleto" e nenhum item (M9-D697). O briefing
 * vigente da NAY Diretoria vem de `getBriefForReader` (M9-D693), já filtrado pela permissão do leitor. Só lê o schema analytics (BI-012).
 */
const AppError = require('../../../../utils/AppError');
const clock = require('../../metrics/clock');
const { windowOf } = require('../../metrics/kpis/centro-comando/windows');
const { getBriefForReader, UNAVAILABLE_TEXT } = require('../../briefs');
const { loadDomainMap, has, P } = require('../../security');
const { listCommandAlerts } = require('../../commandAlertStore.service');
const { readCentroParams } = require('../../centroSettings');
const { readSources, visibleTo } = require('./command.read');
const { BLOCKS, DEPENDS_ON } = require('./command.map');
const { bySeverity, byDeadline } = require('./command.item');
const { buildAconteceu } = require('./command.block1');
const { buildDecisao } = require('./command.block2');
const { buildRisco } = require('./command.block3');
const { buildDinheiro } = require('./command.block4');
const { buildPrazos } = require('./command.block5');
const { buildOportunidades } = require('./command.block6');

const BUILDERS = Object.freeze({
  ACONTECEU: buildAconteceu, DECISAO: buildDecisao, RISCO: buildRisco, DINHEIRO: buildDinheiro, PRAZOS: buildPrazos, OPORTUNIDADES: buildOportunidades,
});
const ORDER = Object.freeze({ PRAZOS: byDeadline });
const BLOCK_KEYS = BLOCKS.map((b) => b.key);

const hiddenText = (n) => (n === 1 ? '+1 item que você não pode ver' : `+${n} itens que você não pode ver`);

/** Item visível para o usuário: o domínio dele (ou todos os domínios dos componentes de um total) está na permissão do usuário. */
const canSee = (ctx, map) => (item) => (Array.isArray(item.domains) ? item.domains.every((d) => visibleTo(ctx, map, d)) : visibleTo(ctx, map, item.domain));

/** Só os totais cujo item o usuário pode ver: o total do dinheiro nunca sai para quem não lê todos os domínios dos componentes. */
function visibleTotals(totals, visible) {
  return Object.fromEntries(Object.entries(totals).filter(([key]) => visible.some((item) => item.group === key.toUpperCase())));
}

/** Item de indicador leva a leitura do indicador (valor, estado e freshness), para o Front mostrar o selo de atualização (M9-D609). Alerta não tem. */
function withMetric(sources) {
  return (item) => {
    const src = !item.metric && !item.source.alertId ? sources.get(item.source.metricCode) : null;
    return src && src.freshness ? { ...item, metric: { metricCode: src.code, value: src.value, status: src.status, freshness: src.freshness } } : item;
  };
}

function clean(item) {
  const { sort, ...rest } = item; // a chave de ordenação é do servidor; o Front recebe a lista já ordenada
  return rest;
}

async function briefOf(ctx, route, ip, tx) {
  const unavailable = { available: false, message: UNAVAILABLE_TEXT, items: [], closing: null };
  try {
    const brief = await getBriefForReader(ctx, { briefType: 'DAILY', route, ip }, tx);
    return brief && brief.available ? brief : { ...unavailable, ...(brief ? { status: brief.status, periodEnd: brief.periodEnd } : {}) };
  } catch (err) {
    if (err && err.code === 'PERMISSION_DENIED') return unavailable; // sem analytics:brief:read o briefing não aparece, e a tela não diz por quê
    throw err;
  }
}

async function runBlock(spec, widget, env, tx) {
  const base = { key: spec.key, title: spec.title, question: spec.question };
  if (widget.block && widget.block.deferred) return { ...base, deferred: true, deferredText: widget.block.text, reasons: widget.block.reasons, items: [], total: 0, shown: 0, hiddenCount: 0, hiddenText: null, viewAllHref: null };
  const out = await BUILDERS[spec.key](env, tx);
  const list = Array.isArray(out) ? out : out.items;
  const visible = list.filter(canSee(env.ctx, env.domainMap)).sort(ORDER[spec.key] || bySeverity);
  const limit = env.onlyBlock === spec.key ? visible.length : env.params.maxItems;
  const hidden = list.length - visible.length + (Array.isArray(out) ? 0 : out.hidden || 0);
  return {
    ...base, deferred: false, items: visible.slice(0, limit).map(withMetric(env.sources)).map(clean), total: visible.length, shown: Math.min(limit, visible.length), hiddenCount: hidden, hiddenText: hidden > 0 ? hiddenText(hidden) : null,
    viewAllHref: visible.length > 0 && env.onlyBlock !== spec.key ? `/painel/centro-de-comando?bloco=${spec.key}` : null, ...(out.totals ? { totals: visibleTotals(out.totals, visible) } : {}),
  };
}

/**
 * Acrescenta aos widgets compostos os blocos do Centro de Comando e o briefing. `composed` = { widgets, quality } de composeWidgets;
 * options: { asOfDate, route, ip, block } (block = chave do bloco a mostrar por inteiro: "Ver todos").
 */
async function decorateCommandCenter(ctx, composed, { asOfDate, route = null, ip = null, block = null }, tx) {
  if (block !== null && !BLOCK_KEYS.includes(block)) throw AppError.badRequest('Bloco do Centro de Comando desconhecido.', 'ANALYTICS_COMMAND_BLOCK_INVALID');
  const params = await readCentroParams(ctx, tx);
  const domainMap = await loadDomainMap(ctx, tx);
  const now = clock.now();
  const window = windowOf(asOfDate, now, params.windowHours);
  const widgetOf = (key) => composed.widgets.find((w) => w.config && w.config.blockKey === key);
  const active = BLOCKS.filter((b) => widgetOf(b.key) && !(widgetOf(b.key).block && widgetOf(b.key).block.deferred));
  const codes = active.flatMap((b) => DEPENDS_ON[b.key]);
  const sources = await readSources(ctx, codes, asOfDate, tx);
  const alerts = await listCommandAlerts({ companyId: ctx.companyId, from: window.from, to: window.to }, tx);
  const allPermissions = [P.READ, P.READ_TECH, ...[...domainMap.values()]];
  const env = {
    ctx, asOfDate, params, window, windowHours: params.windowHours, now, alerts, sources, domainMap, allPermissions, onlyBlock: block,
    alertHref: (id) => `/painel/centro-de-comando?alerta=${id}`,
  };
  const blocks = [];
  for (const spec of BLOCKS) {
    const widget = widgetOf(spec.key);
    if (widget) blocks.push(await runBlock(spec, widget, env, tx));
  }
  const byKey = new Map(blocks.map((b) => [b.key, b]));
  const widgets = composed.widgets.map((w) => (w.config && w.config.blockKey ? { ...w, command: byKey.get(w.config.blockKey) } : w));
  const hidden = blocks.reduce((sum, b) => sum + b.hiddenCount, 0);
  return {
    widgets, blocks, brief: await briefOf(ctx, route, ip, tx), hidden: { count: hidden, text: hidden > 0 ? hiddenText(hidden) : null },
    window: { from: window.from.toISOString(), to: window.to.toISOString(), hours: params.windowHours }, maxItemsPerBlock: params.maxItems, canReadAll: has(ctx, P.READ),
  };
}

module.exports = { decorateCommandCenter, BLOCK_KEYS, hiddenText };
