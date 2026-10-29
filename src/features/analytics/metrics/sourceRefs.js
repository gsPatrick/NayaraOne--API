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
require('./sourceSpecs.finance'); // origem dos componentes do read model financeiro (M9-D615)
require('./sourceSpecs.finance.results'); // origem da margem por setor, comissões e repasses (M9-D623)
require('./sourceSpecs.crm'); // origem dos KPIs do funil comercial (M9-D630 e M9-D631)
require('./sourceSpecs.obras.custo'); // origem dos KPIs de avanço, custo e margem das obras (M9-D650)
require('./sourceSpecs.obras.operacao'); // origem dos KPIs de atrasos, medições e não conformidades das obras (M9-D651)
require('./sourceSpecs.legal'); // origem dos KPIs do Jurídico (M9-D660)
require('./sourceSpecs.correspondent'); // origem dos KPIs do Correspondente Bancário (M9-D661)
require('./sourceSpecs.obraCustos'); // origem do desperdício, custo pós-obra e recorrência (M9-D652)
