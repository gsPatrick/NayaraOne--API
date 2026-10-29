'use strict';

/**
 * Webhooks de entrada (M9-D210 3.1). A caixa de entrada persistente e o worker moram em ../inbox (M9-D203); esta pasta
 * recebe o roteador e os verificadores de assinatura da M9-D211 e, até lá, expõe a mesma caixa como porta do módulo.
 */
const inbox = require('../inbox');

module.exports = { inbox };
