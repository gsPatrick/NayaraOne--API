'use strict';

const AppError = require('../../../utils/AppError');

/** M9-D611 (4) — recusas do rastreio até o registro de origem. */
const drilldownForbidden = () => AppError.forbidden('Você não tem permissão para ver o detalhe deste indicador.', 'ANALYTICS_DRILLDOWN_FORBIDDEN');
const filterHashInvalid = () => AppError.badRequest('Filtro de detalhe inválido.', 'ANALYTICS_FILTER_HASH_INVALID');
const sourceSpecMissing = (metricCode) => AppError.unprocessable(`O indicador ${metricCode} não declara a origem do número.`, 'ANALYTICS_SOURCE_SPEC_MISSING', { metricCode });

module.exports = { drilldownForbidden, filterHashInvalid, sourceSpecMissing };
