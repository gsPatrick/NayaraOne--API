'use strict';

/**
 * Marketing / tracking — serviço da área (M9-D431): links de rastreio assinados, clique com consentimento, origem do lead, venda
 * atribuída (first-touch e last-touch) e relatório por campanha e canal.
 */
module.exports = {
  ...require('./tracking.links.service'),
  ...require('./tracking.lead.service'),
  ...require('./tracking.sale.service'),
  ...require('./tracking.report.service'),
  ...require('./tracking.redirect.service'),
  ...require('./tracking.url'),
  recordEvent: require('./tracking.events.service').recordEvent,
};
