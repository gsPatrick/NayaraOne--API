#!/usr/bin/env node
'use strict';

// M9-D046 — failure drill da NAY. Só em banco descartável: node scripts/withDisposableDb.js -- bash -c "node scripts/seed-ci-two-tenants.js && node scripts/ai-drill-timeout-proposta.js"
require('./ai-drill/lib/runner').main(require('./ai-drill/cenarios/timeoutEmProposta')).catch((e) => { console.error(`Erro: ${e.message}`); process.exitCode = 1; });
