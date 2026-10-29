'use strict';

// M9-D038 (critério acrescentado pela M9-D035) — a tool compartilhada legal.getExpiringContracts, chamada pela NAY Jurídica (escopo de dados
// legal.contracts), devolve a lista nominal (número, vigência, valor); a Diretoria (escopo legal.summary) recebe só o agregado. Banco descartável, sandbox.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const Dados = require('../_helpers/iaNayDados');
const H = require('../_helpers/m9d037Agente');
const { buildToolServices } = require('../../../src/features/ai/toolServices');
const { definitionOf } = require('../../../src/features/ai/agents/kit/readTool');
const policy = require('../../../src/features/ai/agents/nay_juridica/juridica.policy');
const diretoria = require('../../../src/features/ai/agents/nay_diretoria/diretoria.policy');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const PERMS = ['ai:use', 'legal:read', 'legal:create'];
const CONTRATOS = [{ dias: 12, valor: 4000 }, { dias: 45, valor: 5250.5 }];

test('m9d038_contratos_a_vencer_lista_nominal_com_escopo_legal_contracts', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await H.ativarAgente(tenantA, tx, 'NAY_JURIDICA', { perms: PERMS });
    assert.ok(c.agent.tools.some((t) => t.toolName === 'legal.getExpiringContracts'), 'a tool está na allowlist da NAY Jurídica');
    assert.ok(policy.DATA_SCOPES.includes('legal.contracts'));
    const criados = await Dados.criarContratos(tenantA, tx, CONTRATOS);

    // Pelo agente (orquestrador): a chamada é permitida e o resultado traz a lista nominal.
    const res = await H.perguntar(c, 'Quais contratos vencem em breve? [[TOOL:legal.getExpiringContracts:{}]] [[RESPOSTA:Há contratos a vencer.]]');
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const [chamada] = await H.chamadas(res.runId, tx);
    assert.equal(chamada.status, 'SUCCEEDED');
    const saida = JSON.stringify(chamada);
    for (const x of criados) assert.ok(saida.includes(x.contractNumber), `a lista traz o número ${x.contractNumber}`);

    // Pelo serviço, com os escopos de cada agente: Jurídica recebe a lista; Diretoria, só o agregado.
    const scope = (dataScopes) => ({ groupId: tenantA.groupId, companyId: tenantA.companyId, userId: tenantA.userId, dataScopes });
    const ler = (dataScopes) => definitionOf('legal.getExpiringContracts').execute({ services: buildToolServices(tx, scope(dataScopes)).services }, {});
    const nominal = await ler([...policy.DATA_SCOPES]);
    assert.equal(nominal.mode, 'DETAIL');
    for (const x of criados) {
      const linha = nominal.contracts.find((k) => k.contractId === x.id);
      assert.ok(linha, `contrato ${x.contractNumber} na lista`);
      assert.equal(linha.contractNumber, x.contractNumber);
      assert.equal(linha.endsAt, new Date(x.endsAt).toISOString(), 'vigência');
      assert.equal(linha.value, Number(x.totalValue), 'valor');
    }
    const resumo = await ler([...diretoria.DATA_SCOPES]);
    assert.equal(resumo.mode, 'SUMMARY');
    assert.equal(resumo.contracts, undefined, 'a Diretoria nunca recebe a lista nominal');
  });
});
