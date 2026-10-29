'use strict';

/** outputMappers por família e operação (M9-D219). Os ports leem daqui; quem envia consulta o port, nunca estes arquivos. */
const portal = require('./portal.mappers');
const site = require('./site.mappers');
const { messaging, email } = require('./messaging.mappers');
const { bank, signature, financing, insurance, fiscal } = require('./finance.mappers');
const { social, analytics, ai } = require('./outbound.mappers');

module.exports = { portal, site, messaging, email, bank, signature, financing, insurance, fiscal, social, analytics, ai };
