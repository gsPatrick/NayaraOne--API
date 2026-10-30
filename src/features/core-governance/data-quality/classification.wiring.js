'use strict';

const resolver = require('../dlp/classification.resolver');
const maskSpec = require('./retention.maskSpec');
const service = require('./classification.service');

/**
 * Liga o registro de classificação (M9-D910) nos dois encaixes que as outras demandas deixaram prontos: o resolvedor de classificação do guard de DLP
 * (`dlp/classification.resolver.js#setResolver`, M9-D821: uma classe por recurso pedido, a mais alta prevalece) e a interface `maskSpecFor` da anonimização da
 * retenção (`retention.maskSpec.js#setProvider`, M9-D911). Chamado uma vez ao carregar o módulo.
 */
function install() {
  resolver.setResolver((tenant, resources, transaction) => service.resolveResources(tenant, resources, transaction));
  maskSpec.setProvider((schema, table, column, ctx) => service.maskSpecFor(ctx.tenant, schema, table, column, ctx.transaction));
}

module.exports = { install };
