'use strict';

// M9-D046 — failure drills (a) provider cai, (b) orçamento estoura e (c) índice de RAG indisponível. Provider sandbox, banco descartável.
const { test, after } = require('node:test');
const { rodarDrill, exigirVerde, F } = require('../_helpers/iaDrill');

after(async () => { await F.sequelize.close(); });

test('m9d046_drill_provider_cai', async () => exigirVerde(await rodarDrill(require('../../../scripts/ai-drill/cenarios/provedorCai'))));
test('m9d046_drill_orcamento_estoura', async () => exigirVerde(await rodarDrill(require('../../../scripts/ai-drill/cenarios/orcamentoEstoura'))));
test('m9d046_drill_indice_rag_indisponivel_responde_insuficiencia', async () => exigirVerde(await rodarDrill(require('../../../scripts/ai-drill/cenarios/indiceRag'))));
