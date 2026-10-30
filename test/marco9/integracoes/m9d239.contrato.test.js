'use strict';

// Marco 9, M9-D239 — suíte de contrato da M9-D222 para o social-sandbox: fixtures por versão, os 10 cenários verdes, relatório gravado e o prefixo fora das pendências.
const { test } = require('node:test');
const { provarContrato } = require('../_helpers/contratoDemanda');

test('m9d239_contrato_d222_dez_cenarios_verdes_e_fora_das_pendencias', async () => {
  await provarContrato(['social-sandbox'], ['social-']);
});
