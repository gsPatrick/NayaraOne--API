'use strict';

// Marco 9, M9-D011 — suíte de contrato da M9-D222 para os adapters de modelo (ai-sandbox, anthropic e openai): fixtures por versão, os 10 cenários verdes, relatório gravado e o prefixo fora das pendências.
const { test } = require('node:test');
const { provarContrato } = require('../_helpers/contratoDemanda');

test('m9d011_contrato_d222_dez_cenarios_verdes_e_fora_das_pendencias', async () => {
  await provarContrato(['ai-sandbox', 'anthropic', 'openai'], ['ai-', 'anthropic', 'openai']);
});
