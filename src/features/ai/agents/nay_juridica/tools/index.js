'use strict';

// As três tools de leitura que a NAY Jurídica acrescenta às tools iniciais (M9-D016): uma definição por arquivo.
module.exports = Object.freeze([
  require('./compareVersions'),
  require('./getRequirementsChecklist'),
  require('./getDeadlines'),
]);
