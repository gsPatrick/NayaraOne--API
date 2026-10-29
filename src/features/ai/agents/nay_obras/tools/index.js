'use strict';

// As quatro tools de leitura que a NAY Obras acrescenta às tools iniciais (M9-D016): uma definição por arquivo.
module.exports = Object.freeze([
  require('./getBudgetVsActual'),
  require('./getDailyReports'),
  require('./getQualityNonConformities'),
  require('./getWarrantyCases'),
]);
