'use strict';

// M9-D712 — API pública da semente do registry e da tabela de criticidade das métricas.
module.exports = {
  ...require('./criticality.table'),
  ...require('./seed.definitions'),
  ...require('./seed.service'),
};
