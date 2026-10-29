'use strict';

/**
 * M9-D685 (3.1, bloco 2) — "O que exige decisão": as quatro filas lidas do read model da fila de decisão por `listDecisionQueue` (M9-D709: nunca das tabelas de
 * origem), cada item com a idade em horas, a marca de envelhecido e o link do módulo que decide, mais os alertas reconhecidos e ainda sem resolução cujo owner é a
 * diretoria (`analytics.centro.papeis_diretoria`). Ordem: severidade (envelhecido e alerta mais grave primeiro) e, no empate, o mais antigo.
 */
const { listDecisionQueue } = require('../../read-models');
const { formatValue } = require('../dashboard.format');
const { formatValue: formatAlertValue } = require('../../alerts/list.format');
const { makeItem, humanize } = require('./command.item');

const HOUR_MS = 3600000;
/** Tela do módulo que decide cada fila (o BI só lista; a decisão fica na origem). */
const KIND = Object.freeze({
  FIN_APPROVAL: { type: 'APROVACAO_FINANCEIRA', label: 'Aprovação financeira', href: '/painel/financeiro/aprovacoes', domain: 'FINANCE' },
  INV_ADJUSTMENT: { type: 'AJUSTE_ESTOQUE', label: 'Ajuste de estoque', href: '/painel/estoque/sugestoes', domain: 'INVENTORY' },
  RULE_APPROVAL: { type: 'APROVACAO_REGRA', label: 'Aprovação de regra', href: '/painel/configuracoes', domain: 'TECH_AI' },
  NAY_PROPOSAL: { type: 'PROPOSTA_NAY', label: 'Proposta da NAY', href: '/painel/financeiro/nay', domain: 'TECH_AI' },
});
const METRIC_OF = Object.freeze({ FIN_APPROVAL: 'fin.approvals_pending', INV_ADJUSTMENT: 'inv.adjustments_pending', RULE_APPROVAL: 'tec.rule_approvals_pending', NAY_PROPOSAL: 'ai.proposals_pending' });

function queueItems(rows, agedHours) {
  return rows.map((r) => {
    const spec = KIND[r.kind];
    const aged = r.aged === true;
    const age = r.ageHours === null ? 'sem data do pedido' : `há ${r.ageHours} h`;
    return makeItem({
      type: spec.type, idSuffix: r.sourceId, title: `${spec.label}${r.title ? `: ${r.title}` : ''}`, domain: spec.domain, metricCode: METRIC_OF[r.kind], severity: aged ? 'WARNING' : 'INFO',
      value: r.amount, formatted: r.amount === null ? null : formatValue('BRL', r.amount), unit: r.amount === null ? null : 'BRL', href: spec.href,
      detail: `Aguardando ${age}${aged ? ` (acima de ${agedHours} h)` : ''}.`, sortValue: r.ageHours === null ? 0 : r.ageHours,
      extra: { ageHours: r.ageHours, aged, amount: r.amount, requestedAt: r.requestedAt, ownerRole: r.ownerRole },
    });
  });
}

function acknowledgedAlertItems(env) {
  const items = [];
  for (const a of env.alerts) {
    if (a.status !== 'ACKNOWLEDGED') continue;
    if (!a.ownerRole || !env.params.directorRoles.includes(String(a.ownerRole).trim().toLowerCase())) continue;
    const value = formatAlertValue(a.lastValue, a.unit);
    const since = a.acknowledgedAt || a.openedAt;
    items.push(makeItem({
      type: 'ALERTA_RECONHECIDO', alert: { id: a.id, code: a.alertCode }, alertMetricCode: a.metricCode, domain: a.domain, severity: a.severity, title: `Alerta reconhecido sem resolução: ${humanize(a.alertCode)}`,
      detail: `${value ? `Último valor: ${value}. ` : ''}Reconhecido há ${Math.max(0, Math.floor((env.now.getTime() - new Date(since).getTime()) / HOUR_MS))} h.`, href: env.alertHref(a.id),
      sortValue: Math.max(0, Math.floor((env.now.getTime() - new Date(since).getTime()) / HOUR_MS)),
    }));
  }
  return items;
}

/** Devolve { items, hidden }: os itens das filas que o usuário pode ler e os alertas; `hidden` conta os itens de fila de domínio que ele não pode ler. */
async function buildDecisao(env, tx) {
  const own = await listDecisionQueue(env.ctx, { now: env.now }, tx);
  const all = await listDecisionQueue({ ...env.ctx, permissions: env.allPermissions }, { now: env.now }, tx);
  const items = [...queueItems(own.items, own.agedHours), ...acknowledgedAlertItems(env)];
  return { items, hidden: Math.max(0, all.total - own.total) }; // itens de fila que o usuário não pode ler: só o número, nunca o conteúdo
}

module.exports = { buildDecisao, KIND };
