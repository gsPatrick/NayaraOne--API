'use strict';

// M9-D046 — o portão de liberação para produção: PRODUCAO só com todos os itens aprovados por pessoas, aprovação final de pessoa distinta e
// DEV_DEPLOY e LAB_VALIDATION no portão. Provider sandbox, nayara_runtime (RLS real), transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { getSetting } = require('../../../src/features/settings/settings.service');
const { inserirAgente, levarPara } = require('../../helpers/aiAgents');
const K = require('../_helpers/iaPortaoProducao');
const P = require('../_helpers/iaProviders');
const { providerRegistry } = require('../../../src/features/ai/providers');
const { registerAiAdapters } = require('../../../src/features/ai/providers/builtIn');
const agentLifecycle = require('../../../src/features/ai/agents/agentLifecycle.service');

let tenantA; let tenantB;
before(async () => { ({ tenantA, tenantB } = await K.prepararTenants()); await K.carregarPessoas(); registerAiAdapters(); });
after(async () => { await K.sequelize.close(); });

const ambiente = (t, tx) => getSetting('ia.ambiente', t, tx, 'LAB');

test('m9d046_producao_recusada_sem_portao_completo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await K.limpar(tenantA, tx);
    const p = await K.pessoas(tenantA);
    const sem = await K.irParaProducao(p.registra, tx).then(() => null, (e) => e);
    assert.equal(sem.statusCode, 409);
    assert.equal(sem.code, 'AI_PRODUCTION_GATE_INCOMPLETE');
    assert.equal(sem.message, 'Faltam aprovações para liberar a NAY em produção: DEV_DEPLOY, LAB_VALIDATION, RED_TEAM, PENTEST, PRIVACY_REVIEW, PRODUCTION_APPROVAL.');
    assert.equal(await ambiente(tenantA, tx), 'LAB', 'o ambiente continua LAB');
    // Sem PENTEST (os demais aprovados): a mensagem lista só o que falta.
    await K.aprovarGlobais(p.registra, tx, ['DEV_DEPLOY', 'LAB_VALIDATION', 'RED_TEAM', 'PRIVACY_REVIEW']);
    const semPentest = await K.irParaProducao(p.registra, tx).then(() => null, (e) => e);
    assert.deepEqual(semPentest.details.missing, ['PENTEST', 'PRODUCTION_APPROVAL']);
    // Item REJECTED ou PENDING não conta como aprovado.
    await K.service.register(K.ctxAdmin(p.registra), { item: 'PENTEST', status: 'REJECTED', notes: 'achado grave aberto' }, tx);
    assert.deepEqual((await K.irParaProducao(p.registra, tx).then(() => null, (e) => e)).details.missing, ['PENTEST', 'PRODUCTION_APPROVAL']);
    // Completo (a aprovação final é de outra pessoa): PRODUCAO é aceita; voltar a LAB nunca é recusado.
    await K.aprovar(p.registra, tx, 'PENTEST');
    await K.aprovar(p.aprova, tx, 'PRODUCTION_APPROVAL');
    await K.irParaProducao(p.registra, tx);
    assert.equal(await ambiente(tenantA, tx), 'PRODUCAO');
    await P.ajustar(tenantA, 'ia.ambiente', 'LAB', tx);
    assert.equal(await ambiente(tenantA, tx), 'LAB');
  });
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    // A aprovação da empresa A não vale para a B.
    const sem = await K.irParaProducao(tenantB, tx).then(() => null, (e) => e);
    assert.equal(sem.code, 'AI_PRODUCTION_GATE_INCOMPLETE');
  });
});

test('m9d046_producao_exige_agente_avaliado_e_provedor_revisado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await K.limpar(tenantA, tx);
    const p = await K.pessoas(tenantA);
    await K.aprovarGlobais(p.registra, tx);
    // Um agente ativo e habilitado exige a sua AGENT_EVALUATION; uma conexão real ativa exige o PROVIDER_REVIEW do provedor.
    const agente = await inserirAgente(tenantA, tx, { code: 'NAY_TESTE_D046' });
    await levarPara(agente.id, 'ACTIVE', tx);
    await P.ativarConexao(tenantA, tx, { providerCode: 'openai' });
    const falta = await K.irParaProducao(p.registra, tx).then(() => null, (e) => e);
    assert.deepEqual(falta.details.missing, ['AGENT_EVALUATION (NAY_TESTE_D046)', 'PROVIDER_REVIEW (openai)', 'PRODUCTION_APPROVAL']);
    await K.aprovar(p.registra, tx, 'AGENT_EVALUATION', { scopeRef: 'nay_teste_d046' });
    await K.aprovar(p.registra, tx, 'PROVIDER_REVIEW', { scopeRef: 'OpenAI' });
    await K.aprovar(p.aprova, tx, 'PRODUCTION_APPROVAL');
    await K.irParaProducao(p.registra, tx);
    assert.equal(await ambiente(tenantA, tx), 'PRODUCAO');
  });
});

test('m9d046_aprovador_distinto', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await K.limpar(tenantA, tx);
    const p = await K.pessoas(tenantA);
    await K.aprovarGlobais(p.registra, tx);
    // Quem registrou os demais itens não aprova a produção: 403, e nada é gravado.
    const mesma = await K.aprovar(p.registra, tx, 'PRODUCTION_APPROVAL').then(() => null, (e) => e);
    assert.equal(mesma.statusCode, 403);
    assert.equal(mesma.code, 'AI_GATE_SELF_APPROVAL_BLOCKED');
    assert.equal(mesma.message, 'Outra pessoa precisa aprovar a liberação em produção.');
    assert.equal((await K.service.list(K.ctxAdmin(p.registra), { item: 'PRODUCTION_APPROVAL' }, tx)).gates.length, 0);
    // Quem só APROVOU (outra pessoa registrou) também não pode: a aprovação final é de uma terceira pessoa.
    await K.aprovar(p.aprova, tx, 'AGENT_EVALUATION', { scopeRef: 'NAY_X' });
    const aprovadorDeItem = await K.aprovar(p.aprova, tx, 'PRODUCTION_APPROVAL').then(() => null, (e) => e);
    assert.equal(aprovadorDeItem.code, 'AI_GATE_SELF_APPROVAL_BLOCKED');
    // Uma pessoa que não tocou em nenhum item aprova.
    const ok = await K.aprovar(p.outra, tx, 'PRODUCTION_APPROVAL');
    assert.equal(ok.gate.approvedBy, p.outra.userId);
    // Item registrado depois por quem aprovou a produção invalida a distinção: a produção deixa de ser liberada.
    await K.aprovar(p.outra, tx, 'RED_TEAM');
    const depois = await K.irParaProducao(p.registra, tx).then(() => null, (e) => e);
    assert.ok(depois.details.missing.includes('PRODUCTION_APPROVAL (aprovador distinto)'), JSON.stringify(depois.details));
  });
});

test('m9d046_producao_exige_dev_deploy_e_lab_validation', async () => {
  for (const faltando of ['DEV_DEPLOY', 'LAB_VALIDATION']) {
    await withRollbackTenantTransaction(tenantA, async (tx) => {
      await K.limpar(tenantA, tx);
      const p = await K.pessoas(tenantA);
      await K.aprovarGlobais(p.registra, tx, K.GLOBAIS.filter((i) => i !== faltando));
      // A aprovação final também só vale com o portão completo: sem o item, 409 listando-o.
      const final = await K.aprovar(p.aprova, tx, 'PRODUCTION_APPROVAL').then(() => null, (e) => e);
      assert.equal(final.code, 'AI_PRODUCTION_GATE_INCOMPLETE');
      assert.deepEqual(final.details.missing, [faltando]);
      // Item aprovado e depois revogado (REJECTED), com a aprovação final já dada: PRODUCAO é recusada e a mensagem lista o item.
      await K.aprovar(p.registra, tx, faltando);
      await K.aprovar(p.aprova, tx, 'PRODUCTION_APPROVAL');
      await K.irParaProducao(p.registra, tx);
      await P.ajustar(tenantA, 'ia.ambiente', 'LAB', tx);
      await K.service.register(K.ctxAdmin(p.registra), { item: faltando, status: 'REJECTED', notes: 'revogado' }, tx);
      const err = await K.irParaProducao(p.registra, tx).then(() => null, (e) => e);
      assert.equal(err.statusCode, 409, faltando);
      assert.equal(err.code, 'AI_PRODUCTION_GATE_INCOMPLETE');
      assert.deepEqual(err.details.missing, [faltando]);
      assert.match(err.message, new RegExp(`: ${faltando}\\.$`));
      // Aprovado de novo, PRODUCAO volta; a seguir, o item revogado bloqueia a habilitação de agente com provedor real.
      await K.aprovar(p.registra, tx, faltando);
      await K.irParaProducao(p.registra, tx);
      await P.ativarConexao(tenantA, tx, { providerCode: 'openai' });
      await K.aprovar(p.registra, tx, 'PROVIDER_REVIEW', { scopeRef: 'openai' });
      const agente = await inserirAgente(tenantA, tx, { code: `NAY_HAB_${faltando.slice(0, 3)}` });
      await K.aprovar(p.registra, tx, 'AGENT_EVALUATION', { scopeRef: agente.code });
      await K.service.register(K.ctxAdmin(p.registra), { item: faltando, status: 'REJECTED', notes: 'revogado' }, tx);
      await levarPara(agente.id, 'HOMOLOGATED', tx);
      const ativar = await agentLifecycle.activate(K.ctxAdmin(p.outra), agente.code, 1, tx).then(() => null, (e) => e);
      assert.equal(ativar.code, 'AI_PRODUCTION_GATE_INCOMPLETE', 'habilitar agente com provedor real em PRODUCAO');
      assert.ok(ativar.details.missing.includes(faltando));
    });
  }
});

test('m9d046_agente_so_com_provedor_de_testes_nao_depende_do_portao_na_habilitacao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await K.limpar(tenantA, tx);
    const p = await K.pessoas(tenantA);
    // Em LAB nada muda: o agente é habilitado (a recusa do portão só vale em PRODUCAO com provedor real).
    const agente = await inserirAgente(tenantA, tx, { code: 'NAY_LAB_D046' });
    await levarPara(agente.id, 'HOMOLOGATED', tx);
    const { assertAgentEnableAllowed } = require('../../../src/features/ai/releaseGates');
    await assertAgentEnableAllowed(K.ctxAdmin(p.outra), agente.code, tx);
    assert.equal(providerRegistry.has('ai-sandbox'), true);
  });
});
