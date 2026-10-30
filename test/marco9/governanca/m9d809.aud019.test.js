'use strict';

// M9-D809 — AUD-019 (JUR-013): contrato pertence à empresa correta. A empresa A não lê nem baixa anexo de contrato da empresa B: 404 pela API e zero linhas pelo banco (RLS). Banco descartável.
process.env.PORT = process.env.M9D809_AUD019_PORT || '21719';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, encerrar } = require('../_helpers/m9d809Http');
const { contratoComAnexo } = require('../_helpers/m9d809Legal');
const { withTenantTransaction } = require('../../testHelpers');
const { Contract, ContractVersion, File } = require('../../../src/models');

let api;
before(async () => { api = await iniciar(21719); });
after(async () => { await encerrar(); });

test('m9d809 AUD-019 usuário da empresa A não lê nem baixa anexo de contrato da empresa B', async (t) => {
  if (api.skip) return t.skip(api.skip);
  const { http } = api;
  const { contractId, fileId } = await contratoComAnexo(http.tenants.B);

  // a empresa dona enxerga o que é dela (controle positivo)
  assert.equal((await http.call('gestorB', 'GET', `/legal/contracts/${contractId}`)).status, 200);
  assert.equal((await http.call('gestorB', 'GET', `/files/${fileId}`)).status, 200);

  // a empresa A recebe 404 em tudo: contrato, metadado e conteúdo do anexo
  for (const caminho of [`/legal/contracts/${contractId}`, `/legal/contracts/${contractId}/timeline`, `/files/${fileId}`, `/files/${fileId}/content`]) {
    const res = await http.call('gestor', 'GET', caminho);
    assert.equal(res.status, 404, `${caminho}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, false);
  }
  const lista = await http.call('gestor', 'GET', '/legal/contracts');
  assert.equal(lista.status, 200);
  assert.ok(!JSON.stringify(lista.body).includes(contractId), 'o contrato de B não aparece na listagem de A');

  // pelo banco, no contexto da empresa A (RLS FORCE): zero linhas do contrato, da versão e do arquivo de B
  const linhas = await withTenantTransaction(http.tenants.A, async (transaction) => ({
    contratos: await Contract.count({ where: { id: contractId }, transaction }),
    versoes: await ContractVersion.count({ where: { contractId }, transaction }),
    arquivos: await File.count({ where: { id: fileId }, transaction }),
  }));
  assert.deepEqual(linhas, { contratos: 0, versoes: 0, arquivos: 0 });
});
