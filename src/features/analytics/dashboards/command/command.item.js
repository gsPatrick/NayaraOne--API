'use strict';

/**
 * M9-D685 — forma comum dos itens do Centro de Comando e a ordenação dos blocos. Todo item aponta para uma fonte do mapa 3.2-A (`source.metricCode` ou
 * `source.alertId`), leva o link do painel de origem e o domínio (para o ABAC). Nada aqui calcula indicador: só descreve o que a fonte já devolveu.
 */
const { panelOf } = require('./command.map');

const SEVERITY_RANK = Object.freeze({ CRITICAL: 0, WARNING: 1, INFO: 2 });

/** "legal_prazo_vencido" -> "Legal prazo vencido". */
function humanize(code) {
  const text = String(code).replace(/[._]/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * fields: { type, title, detail, severity, metricCode | alert: { id, code }, domain, value, formatted, unit, href, rank, sortValue, drilldown, extra }.
 * `rank` ordena dentro da mesma severidade (menor primeiro) e `sortValue` desempata (maior primeiro); ambos só organizam, não aparecem como indicador.
 */
function makeItem(fields) {
  const { type, title, detail = null, severity = 'INFO', metricCode = null, alert = null, domain = 'GENERAL', value = null, formatted = null, unit = null } = fields;
  const source = alert ? { alertId: alert.id, alertCode: alert.code, metricCode: fields.alertMetricCode || null } : { metricCode };
  const idPart = alert ? alert.id : `${metricCode}${fields.idSuffix ? `:${fields.idSuffix}` : ''}`;
  const link = { href: fields.href || (metricCode ? panelOf(metricCode) : '/painel/centro-de-comando'), drilldownMetricCode: fields.drilldown ? metricCode : null };
  return {
    id: `${type}:${idPart}`, type, title, detail, severity, value, formatted, unit, domain, source, link, ...(fields.extra || {}),
    sort: { rank: fields.rank ?? 0, value: Number.isFinite(fields.sortValue) ? fields.sortValue : 0 },
  };
}

/** Ordem padrão: severidade (mais grave primeiro), depois `rank`, depois `sortValue` (maior primeiro), depois o id (estável). */
function bySeverity(a, b) {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.sort.rank - b.sort.rank || b.sort.value - a.sort.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Ordem dos prazos: vencidos primeiro (rank 0), depois por proximidade (rank crescente), dentro do rank o mais antigo/próximo (sortValue maior) primeiro. */
function byDeadline(a, b) {
  return a.sort.rank - b.sort.rank || b.sort.value - a.sort.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

module.exports = { makeItem, bySeverity, byDeadline, humanize, SEVERITY_RANK };
