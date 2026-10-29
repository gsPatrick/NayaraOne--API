'use strict';

/**
 * M9-D632 — parâmetros do administrador dos KPIs de visitas, propostas, imóveis ativos, imóveis sem venda por período e mudanças de preço (aba "BI e
 * Centro de Comando" em /painel/configuracoes): `analytics.owner.<código>` de cada um dos cinco indicadores. As faixas de "imóvel sem venda" seguem
 * `analytics.imoveis.faixas_sem_venda_dias` (comercial.settings, padrão do livro 30,90,180). Arquivo sem dependência de settings.service no topo.
 */
const { ownerDefaults, ownerSchema } = require('./comercialKpi.settings');

const IMOVEIS_KPI_CODES = Object.freeze(['crm.visits', 'crm.proposals', 'prop.active_properties', 'prop.without_sale_by_period', 'prop.price_changes']);
const IMOVEIS_KPI_DEFAULTS = Object.freeze(ownerDefaults(IMOVEIS_KPI_CODES));
const IMOVEIS_KPI_SETTINGS_SCHEMA = Object.freeze(ownerSchema(IMOVEIS_KPI_CODES));

module.exports = { IMOVEIS_KPI_CODES, IMOVEIS_KPI_DEFAULTS, IMOVEIS_KPI_SETTINGS_SCHEMA };
