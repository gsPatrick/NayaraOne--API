'use strict';

// Marco 9, M9-D237 — suíte de contrato da M9-D222 para bank-sandbox e bank-santander (este contra o objeto antigo duplo): fixtures por versão, os 10 cenários verdes, relatório gravado e o prefixo fora das pendências.
const { test } = require('node:test');
const { provarContrato } = require('../_helpers/contratoDemanda');

test('m9d237_contrato_d222_dez_cenarios_verdes_e_fora_das_pendencias', async () => {
  await provarContrato(['bank-sandbox', 'bank-santander'], ['bank-']);
});
