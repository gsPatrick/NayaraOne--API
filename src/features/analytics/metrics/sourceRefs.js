'use strict';

// M9-D611 — API pública do rastreio de cada número até os registros de origem (sourceRefs).
module.exports = {
  ...require('./sourceRefs.spec'),
  ...require('./sourceRefs.mode'),
  ...require('./sourceRefs.filter'),
  ...require('./sourceRefs.build'),
  ...require('./sourceRefs.reconcile'),
  ...require('./sourceRefs.detail'),
  ...require('./sourceRefs.settings'),
};
