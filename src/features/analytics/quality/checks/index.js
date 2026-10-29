'use strict';

// M9-D696 (3.3) — catálogo de checks: um arquivo <read-model>.checks.js por read model. O CI falha se um read model não declarar (M9-D705).
require('./rm_finance_health.checks');
require('./rm_finance_sector_margin.checks');
