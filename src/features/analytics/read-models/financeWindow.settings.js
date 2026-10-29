'use strict';

/**
 * M9-D621 — parâmetros do administrador dos seis KPIs de contas a pagar e recebíveis em 7, 30 e 60 dias (aba "BI e Centro de Comando" em
 * /painel/configuracoes): o owner de cada indicador (papel responsável pela reconciliação), `analytics.owner.<código>`. As janelas de 7, 30 e 60 dias
 * são do livro e não são parâmetro. O owner é lido na publicação do indicador (finance.definitions, via readOwner). Arquivo sem dependência no topo.
 */
const WINDOW_CODES = Object.freeze(['fin.payables_7d', 'fin.payables_30d', 'fin.payables_60d', 'fin.receivables_7d', 'fin.receivables_30d', 'fin.receivables_60d']);
const DEFAULT_OWNER = 'Diretoria Financeira (papel financeiro-gestor)';

const FINANCE_WINDOW_DEFAULTS = Object.freeze(Object.fromEntries(WINDOW_CODES.map((code) => [`analytics.owner.${code}`, DEFAULT_OWNER])));
const FINANCE_WINDOW_SETTINGS_SCHEMA = Object.freeze(Object.fromEntries(WINDOW_CODES.map((code) => [`analytics.owner.${code}`, { type: 'string' }])));

module.exports = { WINDOW_CODES, FINANCE_WINDOW_DEFAULTS, FINANCE_WINDOW_SETTINGS_SCHEMA };
