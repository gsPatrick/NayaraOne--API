'use strict';

/**
 * M9-D686 — conteúdo do painel Saúde Geral (`health`) com os padrões do livro/CSV: uma linha por área, três KPIs principais cada e a regra de semáforo de cada KPI
 * (`config.trafficLight`). Dado puro: o mesmo texto alimenta a migration que publica a versão 2 e os testes. A versão da empresa nasce dos parâmetros dela (health.apply).
 */
const { AREAS } = require('../health/health.areas');
const { buildHealthWidgets } = require('../health/health.widgets');
const { RULES } = require('../../healthSettings');
const { parseRule } = require('../health/health.rules');

const DEFAULT_RULES = new Map(Object.values(RULES).map((r) => [r.metricCode, { dimension: r.dimension, ...parseRule(r.default) }]));

const HEALTH_PANEL = Object.freeze({ code: 'health', widgets: buildHealthWidgets(AREAS, DEFAULT_RULES) });

module.exports = { HEALTH_PANEL, DEFAULT_RULES };
