'use strict';

// M9-D046 — failure drills (d) outbox parado, (e) secret revogado, (f) circuito aberto e (g) timeout em proposta. Provider sandbox, banco descartável
// (o drill do outbox grava de verdade). Cada teste roda o cenário de scripts/ai-drill e exige todas as checagens verdes.
const { test, after } = require('node:test');
const { rodarDrill, exigirVerde, F } = require('../_helpers/iaDrill');
const { DISPOSABLE } = require('../_helpers/aiHttpEnv');
const assert = require('node:assert/strict');

after(async () => { await F.sequelize.close(); });

test('m9d046_drill_outbox_parado_sem_perda', async () => {
  assert.ok(DISPOSABLE, 'o drill do outbox grava de verdade: roda só no banco descartável');
  exigirVerde(await rodarDrill(require('../../../scripts/ai-drill/cenarios/outboxParado')));
});
test('m9d046_drill_secret_revogado_falha_fechada', async () => exigirVerde(await rodarDrill(require('../../../scripts/ai-drill/cenarios/secretRevogado'))));
test('m9d046_drill_circuito_aberto', async () => exigirVerde(await rodarDrill(require('../../../scripts/ai-drill/cenarios/circuitoAberto'))));
test('m9d046_drill_timeout_em_proposta_sem_duplicar', async () => exigirVerde(await rodarDrill(require('../../../scripts/ai-drill/cenarios/timeoutEmProposta'))));
