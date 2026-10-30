'use strict';

// Marco 9, M9-D242 — suíte de contrato da M9-D222 (e M9-D257) para storage-local-disk, storage-sandbox, storage-s3, identity-local e identity-sandbox: fixtures por versão,
// os 10 cenários verdes, relatório gravado e os prefixos fora das pendências.
const { test } = require('node:test');
const { provarContrato } = require('../_helpers/contratoDemanda');

test('m9d242_contrato_d222_dez_cenarios_verdes_e_fora_das_pendencias', async () => {
  await provarContrato(['storage-local-disk', 'storage-sandbox', 'storage-s3', 'identity-local', 'identity-sandbox'], ['storage-', 'identity-']);
});
