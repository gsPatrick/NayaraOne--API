'use strict';

/**
 * M9-D625 (3.3 e 3.6) — regra de consolidação de cada indicador no grupo. Quem entrega o indicador por empresa registra a sua:
 *   { kind: 'SUM', intercompany: null }                              soma das empresas; o indicador não contém transferências entre empresas
 *   { kind: 'SUM', intercompany: { side: 'IN'|'OUT'|'NONE', phase: 'SETTLED'|'PENDING', dueWindow? } }
 *        o indicador de cada empresa contém a perna de transferência do lado `side` (IN = entrada no destino, OUT = saída na origem); o consolidado
 *        elimina os DOIS lados das transferências do grupo: fluxo (phase SETTLED, liquidadas dentro do período do registro) ou posição aberta (phase
 *        PENDING, nas duas pontas pendentes, com `dueWindow: { fromDays, toDays }` opcional em dias a partir da data-base, nulo = sem limite). Com
 *        side 'NONE' nada é eliminado (ex.: caixa: sai de uma conta e entra em outra), mas par incompleto continua deixando o consolidado DEGRADED;
 *   { kind: 'RATE', numeratorDimension, denominatorDimension }       taxa: numerador e denominador das empresas somados e a taxa recalculada
 *        (nunca a média das taxas);
 *   { kind: 'NONE', reason }                                          indicador que não se soma (ex.: composto): o consolidado recusa com 422.
 * O registro é do código; a regra do indicador sem registro é recusar (nunca somar por padrão).
 */
const SIDES = ['IN', 'OUT', 'NONE'];
const PHASES = ['SETTLED', 'PENDING'];
const KINDS = ['SUM', 'RATE', 'NONE'];
const CODE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;
const rules = new Map();

const fail = (code, message) => { throw new Error(`Consolidação de ${code}: ${message}`); };

function assertIntercompany(code, ic) {
  if (ic === null || ic === undefined) return;
  if (!SIDES.includes(ic.side)) fail(code, 'intercompany.side deve ser IN, OUT ou NONE.');
  if (ic.side !== 'NONE' && !PHASES.includes(ic.phase)) fail(code, 'intercompany.phase deve ser SETTLED ou PENDING.');
  const w = ic.dueWindow;
  if (w !== undefined && !(w && ['fromDays', 'toDays'].every((k) => w[k] === null || Number.isInteger(w[k])))) fail(code, 'dueWindow inválido.');
}

function registerConsolidationRule(metricCode, rule) {
  if (!CODE.test(metricCode || '')) fail(metricCode, 'código do indicador inválido.');
  if (!rule || !KINDS.includes(rule.kind)) fail(metricCode, 'kind deve ser SUM, RATE ou NONE.');
  if (rule.kind === 'RATE' && !(rule.numeratorDimension && rule.denominatorDimension)) fail(metricCode, 'RATE exige numeratorDimension e denominatorDimension.');
  if (rule.kind === 'SUM') assertIntercompany(metricCode, rule.intercompany);
  if (rules.has(metricCode)) fail(metricCode, 'já registrada.');
  rules.set(metricCode, Object.freeze({ intercompany: null, ...rule }));
  return rules.get(metricCode);
}

const getConsolidationRule = (metricCode) => rules.get(metricCode) || null;
const listConsolidationRules = () => [...rules.entries()];
const unregisterConsolidationRule = (metricCode) => rules.delete(metricCode); // só para teste

module.exports = { registerConsolidationRule, getConsolidationRule, listConsolidationRules, unregisterConsolidationRule };
