'use strict';

/**
 * M9-D686 (3.1 c) — regras de semáforo por KPI. O texto do parâmetro do administrador ("AMARELO < 60%; VERMELHO < 40%") vira
 * `trafficLight = { dimension?, yellow: { operator, value }, red: { operator, value } }`, o formato gravado em `dashboard_widgets.config.trafficLight` (e lido pelo
 * briefing da NAY, M9-D693: `red.operator` em LT, LTE, GT, GTE, EQ ou NEQ e `red.value` numérico). Só apresentação: o limiar não é fórmula de KPI. Sem banco.
 */
const { compareThreshold, OPERATORS: KNOWN_OPERATORS } = require('../../alerts/decimal'); // a MESMA comparação do motor de alertas e do briefing da NAY

const OPERATORS = Object.freeze({ '<': 'LT', '<=': 'LTE', '>': 'GT', '>=': 'GTE', '=': 'EQ', '==': 'EQ', '!=': 'NEQ' });
const KEYS = Object.freeze(['yellow', 'red']);
const LIGHT_OF = Object.freeze({ AMARELO: 'yellow', VERMELHO: 'red' });
const RULE_RE = /^(AMARELO|VERMELHO)\s*(?:se\s+)?(<=|>=|==|!=|<|>|=)\s*(-?\d+(?:[.,]\d+)?)\s*(?:%|p\.p\.)?$/i;

/** "AMARELO < 99,9%; VERMELHO < 99%" -> { yellow: { operator: 'LT', value: 99.9 }, red: { operator: 'LT', value: 99 } }; null se o texto não for uma regra válida. */
function parseRule(text) {
  const sections = String(text === undefined || text === null ? '' : text).split(';').map((s) => s.trim()).filter(Boolean);
  if (!sections.length || sections.length > 2) return null;
  const rule = {};
  for (const section of sections) {
    const m = RULE_RE.exec(section);
    if (!m) return null;
    const key = LIGHT_OF[m[1].toUpperCase()];
    if (rule[key]) return null;
    rule[key] = { operator: OPERATORS[m[2]], value: Number(m[3].replace(',', '.')) };
  }
  return rule;
}

/** O valor (texto decimal) satisfaz a condição { operator, value }? Comparação decimal exata. */
function holds(value, condition) {
  if (value === null || value === undefined || !condition) return false;
  return compareThreshold(String(value), condition.operator, String(condition.value));
}

/** 'VERMELHO' | 'AMARELO' | 'VERDE' para o valor, pela regra (vermelho vale mais que amarelo). */
function lightOf(value, rule) {
  if (!rule) return 'VERDE';
  if (holds(value, rule.red)) return 'VERMELHO';
  if (holds(value, rule.yellow)) return 'AMARELO';
  return 'VERDE';
}

/** Regra publicada no widget: o formato é conferido (operador conhecido, limite numérico); inválida = sem regra. */
function ruleOfWidget(config) {
  const light = config && config.trafficLight;
  if (!light || typeof light !== 'object') return null;
  const ok = (c) => c && KNOWN_OPERATORS.includes(c.operator) && Number.isFinite(Number(c.value));
  if (!KEYS.some((k) => ok(light[k])) || KEYS.some((k) => light[k] && !ok(light[k]))) return null;
  return { dimension: typeof light.dimension === 'string' ? light.dimension : null, yellow: light.yellow || null, red: light.red || null };
}

module.exports = { parseRule, holds, lightOf, ruleOfWidget, OPERATORS };
