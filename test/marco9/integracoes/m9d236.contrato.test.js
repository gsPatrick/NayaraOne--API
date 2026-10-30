'use strict';

// Marco 9, M9-D236 — suíte de contrato da M9-D222 para os adapters de assinatura (sandbox, sandbox alternativo, Clicksign e ZapSign): fixtures por versão, os 10 cenários verdes, relatório gravado e o prefixo fora das pendências.
const { test } = require('node:test');
const { provarContrato } = require('../_helpers/contratoDemanda');

test('m9d236_contrato_d222_dez_cenarios_verdes_e_fora_das_pendencias', async () => {
  await provarContrato(['signature-sandbox', 'signature-alt-sandbox', 'signature-clicksign', 'signature-zapsign'], ['signature-']);
});
