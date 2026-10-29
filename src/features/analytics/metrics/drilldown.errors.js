'use strict';

const AppError = require('../../../utils/AppError');

/** M9-D690 (4) — recusas do detalhe. 403 e filtro adulterado vêm de sourceRefs.errors (M9-D611). */
const drilldownNotAvailable = () => AppError.conflict('Este indicador não oferece detalhe.', 'ANALYTICS_DRILLDOWN_NOT_AVAILABLE');
const pageSizeInvalid = (max) => AppError.badRequest(`Tamanho de página inválido (máximo ${max}).`, 'ANALYTICS_PAGE_SIZE_INVALID', { maximo: max });
const pageInvalid = () => AppError.badRequest('Página inválida.', 'ANALYTICS_PAGE_INVALID');
const componentRequired = (components) => AppError.badRequest('Este indicador é composto: informe qual componente abrir.', 'ANALYTICS_DRILLDOWN_COMPONENT_REQUIRED', { components });
const metricNotFound = () => AppError.notFound('Métrica não encontrada.', 'ANALYTICS_METRIC_NOT_FOUND');

module.exports = { drilldownNotAvailable, pageSizeInvalid, pageInvalid, componentRequired, metricNotFound };
