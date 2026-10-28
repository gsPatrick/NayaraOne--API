'use strict';

const { buildMarketingRouter } = require('../marketing.module');

// Nenhuma rota HTTP: a lista de supressão é consultada pelos serviços internos (M9-D418). A permissão
// marketing:suppression:manage vale para a remoção feita por serviço.
module.exports = buildMarketingRouter([]);
