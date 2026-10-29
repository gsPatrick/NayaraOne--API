'use strict';

const { getDataQuality } = require('./quality.query');

/**
 * Dados mestres e qualidade — serviço do módulo. GET /data-quality devolve o resumo da empresa e os cadastros avaliados (M9-D806); a nota, as issues e
 * a varredura estão em quality.*.js; designação de donos e curadores em stewardship.*; filas de merge e review em merge.*.
 */
module.exports = { getDataQuality };
