'use strict';

/**
 * Marketing / automations — serviço da área. A definição (fluxo, versão, publicação e pausa) é da M9-D413 (definition.service.js);
 * o runner é da M9-D414 e a validade da versão está em definition.validity.js.
 */
module.exports = {
  ...require('./definition.service'),
  ...require('./definition.validity'),
};
