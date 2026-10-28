'use strict';

// Marco 9, M9-D027 — ContextBuilder: minimização, pseudonimização, RESTRICTED com as quatro condições, isolamento entre empresas
// e guarda de campos (M9-D915 injetada). Postgres real com nayara_runtime (RLS) em transação com rollback; provider sandbox em espelho.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { upsertSetting } = require('../../../src/features/settings/settings.service');
const { buildContext, registerTaskType, unregisterTaskType } = require('../../../src/features/ai/security');
const { sequelize, q, carregarPessoas, ctxDe, prepararTenants } = require('../../helpers/aiAgents');
const { createSandboxProvider, createAiAccess, TAREFA, CAMPOS_TAREFA, fonte } = require('../_helpers/iaPrivacidade');

let tenantA;
let tenantB;
before(async () => {
  ({ tenantA, tenantB } = await prepararTenants());
  await carregarPessoas();
  registerTaskType(TAREFA, CAMPOS_TAREFA);
  registerTaskType('analisar_documento_restrito', { ...CAMPOS_TAREFA, needsRestricted: true });
  registerTaskType('conferir_nome', { ...CAMPOS_TAREFA, needsName: true });
});
after(async () => { [TAREFA, 'analisar_documento_restrito', 'conferir_nome'].forEach(unregisterTaskType); await sequelize.close(); });

const comPerm = (ctx, ...permissions) => ({ ...ctx, permissions });
const cliente = (tenant, over = {}) => fonte(tenant, {
  id: 'cli-1', key: 'cliente', fields: { nome: 'João da Silva', cpf: '123.456.789-09', telefone: '(11) 91234-5678', observacao: 'só interno' }, ...over,
});
const entrada = (tenant, over = {}) => ({
  runId: null, taskType: TAREFA, instruction: 'Resuma a cobrança de João da Silva para o gestor.', purpose: 'cobrança',
  provider: createSandboxProvider().descriptor, sources: [cliente(tenant), fonte(tenant)], agentContext: { agentCode: 'NAY_FINANCEIRA' }, ...over,
});
async function rejeita(promessa, status, code) {
  const err = await promessa.then(() => null, (e) => e);
  assert.ok(err, `deveria recusar com ${code}`);
  assert.equal(err.code, code, err.message);
  assert.equal(err.statusCode, status);
  return err;
}

test('m9d027_prompt_enviado_ao_provider_sem_pii', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const sandbox = createSandboxProvider();
    const aiAccess = createAiAccess();
    const contexto = await buildContext(ctx, entrada(tenantA, { provider: sandbox.descriptor }), tx, { aiAccess });
    const resposta = await sandbox.complete(contexto.messages);
    const enviado = sandbox.mirror.join('\n');
    for (const proibido of ['123.456.789-09', '12345678909', '91234-5678', 'João', 'Silva', 'só interno', 'nao-deve-passar', 'segredoInterno', 'telefone', 'observacao']) {
      assert.ok(!enviado.includes(proibido), `o payload do provider não pode conter "${proibido}": ${enviado}`);
    }
    assert.match(enviado, /Cliente A/);
    assert.match(enviado, /\[REDIGIDO:cpf\]/);
    assert.ok(enviado.includes('100.00'), 'campo da lista branca passa');
    assert.equal(resposta, 'Resposta para Cliente A: cpf [REDIGIDO:cpf].');
    // a guarda de campos roda ANTES da montagem e vê todos os campos (lista de referências, sem valores)
    assert.equal(aiAccess.calls.length, 1);
    assert.ok(aiAccess.calls[0].fields.every((f) => !('value' in f)), 'a guarda recebe referências, nunca valores');
    assert.deepEqual(aiAccess.calls[0].agentContext, { agentCode: 'NAY_FINANCEIRA' });
  });
});

test('m9d027_sem_guarda_de_campos_o_contexto_nao_e_montado_e_campo_proibido_sai', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    await rejeita(buildContext(ctx, entrada(tenantA), tx, {}), 500, 'AI_ACCESS_GUARD_REQUIRED');
    await rejeita(buildContext(ctx, entrada(tenantA), tx, { aiAccess: {} }), 500, 'AI_ACCESS_GUARD_REQUIRED');
    // campo que a guarda retira nunca chega ao provider, mesmo estando na lista branca da tarefa
    const aiAccess = createAiAccess({ blocked: ['cliente.cpf'] });
    const contexto = await buildContext(ctx, entrada(tenantA), tx, { aiAccess });
    assert.ok(!contexto.messages[1].content.includes('REDIGIDO:cpf'), 'sem o campo, nem o placeholder aparece');
    assert.ok(!contexto.messages[1].content.includes('123.456'));
    // a decisão é auditada com as referências retiradas e sem conteúdo
    const [log] = await q("SELECT after_json::text AS j FROM audit.audit_log WHERE action = 'ai.context.privacy_decision' ORDER BY occurred_at DESC LIMIT 1", {}, tx);
    assert.match(log.j, /cliente\.cpf/);
    assert.ok(!log.j.includes('123.456.789-09') && !log.j.includes('João'));
  });
});

test('m9d027_restricted_exige_quatro_condicoes', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const aiAccess = createAiAccess();
    const restrito = (extra = {}) => fonte(tenantA, { id: 'doc-1', key: 'documento', classification: 'RESTRICTED', fields: { trecho: 'conteúdo restrito do contrato' }, ...extra });
    const ok = { allowsRestricted: true, dataRetention: 'NONE' };
    const roda = (ctx, over) => buildContext(ctx, entrada(tenantA, { taskType: 'analisar_documento_restrito', sources: [restrito()], provider: { ...createSandboxProvider().descriptor, ...ok }, ...over }), tx, { aiAccess });
    const com = comPerm(ctxDe(tenantA), 'ai:use', 'ai:restricted');

    // as quatro condições: entra
    const liberado = await roda(com);
    assert.match(liberado.messages[1].content, /conteúdo restrito do contrato/);
    assert.deepEqual(liberado.notices, []);

    // cada condição que falta recusa com 403 e o código do livro
    const err = await rejeita(roda(comPerm(ctxDe(tenantA), 'ai:use')), 403, 'AI_RESTRICTED_NOT_ALLOWED');
    assert.equal(err.message, 'Este conteúdo é restrito e não pode ser usado pela NAY nesta consulta.');
    await rejeita(roda(com, { purpose: '  ' }), 403, 'AI_RESTRICTED_NOT_ALLOWED');
    await rejeita(roda(com, { purpose: undefined }), 403, 'AI_RESTRICTED_NOT_ALLOWED');
    await rejeita(roda(com, { provider: { ...createSandboxProvider().descriptor, allowsRestricted: false, dataRetention: 'NONE' } }), 403, 'AI_RESTRICTED_NOT_ALLOWED');
    await rejeita(roda(com, { provider: { ...createSandboxProvider().descriptor, allowsRestricted: true, dataRetention: 'THIRTY_DAYS' } }), 403, 'AI_RESTRICTED_NOT_ALLOWED');

    // tarefa que não exige RESTRICTED: o trecho é omitido e a resposta avisa (não é erro)
    const omitido = await roda(com, { taskType: TAREFA });
    assert.ok(!omitido.messages[1].content.includes('conteúdo restrito'));
    assert.deepEqual(omitido.notices, ['Parte do conteúdo restrito não foi usada.']);
    assert.equal(omitido.decisions[0].decision, 'OMITIDO');
    assert.equal(omitido.decisions[0].reason, 'tarefa_nao_exige');

    // classe desconhecida é tratada como RESTRICTED (falha fechada)
    const desconhecida = await roda(comPerm(ctxDe(tenantA), 'ai:use'), { taskType: TAREFA, sources: [restrito({ classification: 'SECRETA' })] });
    assert.ok(!desconhecida.messages[1].content.includes('conteúdo restrito'));
    assert.equal(desconhecida.decisions[0].classification, 'RESTRICTED');
  });
});

test('m9d027_confidential_so_com_provider_e_contrato_de_retencao', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const aiAccess = createAiAccess();
    const conf = fonte(tenantA, { id: 'doc-2', key: 'documento', classification: 'CONFIDENTIAL', fields: { trecho: 'minuta confidencial' } });
    const base = createSandboxProvider().descriptor;
    const roda = (provider) => buildContext(ctx, entrada(tenantA, { sources: [conf], provider }), tx, { aiAccess });
    assert.ok(!(await roda(base)).messages[1].content.includes('minuta'));
    assert.ok(!(await roda({ ...base, allowsConfidential: true })).messages[1].content.includes('minuta'), 'sem contrato de retenção registrado');
    const livre = await roda({ ...base, allowsConfidential: true, contractRef: 'CT-2026-17' });
    assert.match(livre.messages[1].content, /minuta confidencial/);
    for (const classe of ['PUBLIC', 'INTERNAL']) {
      const c = await buildContext(ctx, entrada(tenantA, { sources: [{ ...conf, classification: classe }] }), tx, { aiAccess });
      assert.match(c.messages[1].content, /minuta/);
    }
  });
});

test('m9d027_nomes_pseudonimizados', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const ctx = comPerm(ctxDe(tenantA), 'ai:use');
    const aiAccess = createAiAccess();
    const roda = (over) => buildContext(ctx, entrada(tenantA, over), tx, { aiAccess });
    const padrao = await roda({});
    assert.equal(padrao.pseudonymized, true, 'padrão Ligado para provider externo');
    assert.match(padrao.messages[0].content, /^Resuma a cobrança de Cliente A para o gestor\.$/, 'o nome na instrução também é trocado');
    assert.ok(!JSON.stringify(padrao.messages).includes('Silva'));
    // a re-hidratação devolve o nome ao próprio usuário
    assert.equal(padrao.rehydrate('Cliente A deve R$ 100,00 (CPF [REDIGIDO:cpf])'), 'João da Silva deve R$ 100,00 (CPF 123.456.789-09)');
    // dois nomes: apelidos distintos e estáveis
    const dois = await roda({ sources: [cliente(tenantA), cliente(tenantA, { id: 'cli-2', fields: { nome: 'Maria Souza', cpf: '529.982.247-25' } })] });
    assert.match(dois.messages[1].content, /Cliente A/);
    assert.match(dois.messages[1].content, /Cliente B/);
    // provider local/sandbox (não externo) não pseudonimiza; tarefa que precisa do nome também não
    assert.equal((await roda({ provider: { ...createSandboxProvider().descriptor, external: false } })).pseudonymized, false);
    const nome = await roda({ taskType: 'conferir_nome' });
    assert.equal(nome.pseudonymized, false);
    assert.match(nome.messages[1].content, /João da Silva/);
    assert.ok(!nome.messages[1].content.includes('123.456.789-09'), 'mesmo com o nome, o CPF continua redigido');
    // parâmetro do administrador desliga (ia.privacidade.pseudonimizar_nomes)
    await upsertSetting('ia.privacidade.pseudonimizar_nomes', false, ctx, ctx.userId, tx);
    const desligado = await roda({});
    assert.equal(desligado.pseudonymized, false);
    assert.match(desligado.messages[1].content, /João da Silva/);
    await upsertSetting('ia.privacidade.pseudonimizar_nomes', true, ctx, ctx.userId, tx);
    assert.equal((await roda({})).pseudonymized, true);
  });
});

test('m9d027_nada_de_empresa_a_no_contexto_da_b', async () => {
  await withRollbackTenantTransaction(tenantB, async (tx) => {
    const ctxB = comPerm(ctxDe(tenantB), 'ai:use');
    const aiAccess = createAiAccess();
    const deA = cliente(tenantA, { id: 'cli-A', fields: { nome: 'Cliente Secreto da A', cpf: '529.982.247-25' } });
    const deB = fonte(tenantB, { id: 'parc-B' });
    const contexto = await buildContext(ctxB, entrada(tenantB, { sources: [deA, deB] }), tx, { aiAccess });
    const enviado = JSON.stringify(contexto.messages);
    assert.ok(!enviado.includes('Secreto') && !enviado.includes('529.982') && !enviado.includes('cliente'), `nada da empresa A: ${enviado}`);
    assert.ok(enviado.includes('100.00'), 'o que é da empresa B passa');
    const [log] = await q("SELECT after_json::text AS j FROM audit.audit_log WHERE action = 'ai.context.privacy_decision' ORDER BY occurred_at DESC LIMIT 1", {}, tx);
    assert.match(log.j, /"fontesDeOutraEmpresaDescartadas": 1/);
    // outro grupo com a mesma empresa também é descartado
    const outroGrupo = await buildContext(ctxB, entrada(tenantB, { sources: [{ ...deB, groupId: tenantA.groupId }] }), tx, { aiAccess });
    assert.ok(!outroGrupo.messages[1].content.includes('100.00'));
    // o mapa de re-hidratação é do run: o apelido do run da A não vale no run da B
    const runA = await withRollbackTenantTransaction(tenantA, (txA) => buildContext(comPerm(ctxDe(tenantA), 'ai:use'), entrada(tenantA), txA, { aiAccess }));
    const runB = await buildContext(ctxB, entrada(tenantB, { sources: [cliente(tenantB, { fields: { nome: 'Pessoa da B', cpf: '111.444.777-35' } })] }), tx, { aiAccess });
    assert.equal(runB.rehydrate('Cliente A'), 'Pessoa da B');
    assert.equal(runA.rehydrate('Cliente A'), 'João da Silva');
  });
});

test('m9d027_rehidratacao_so_no_retorno_ao_usuario_pelo_contexto', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const sandbox = createSandboxProvider();
    const contexto = await buildContext(comPerm(ctxDe(tenantA), 'ai:use'), entrada(tenantA, { provider: sandbox.descriptor }), tx, { aiAccess: createAiAccess() });
    const bruta = await sandbox.complete(contexto.messages);
    assert.equal(bruta, 'Resposta para Cliente A: cpf [REDIGIDO:cpf].');
    assert.equal(contexto.rehydrate(bruta), 'Resposta para João da Silva: cpf 123.456.789-09.');
    assert.ok(!JSON.stringify(contexto).includes('123.456.789-09'), 'o objeto devolvido não carrega o mapa nem o valor');
  });
});

test('m9d027_tipo_de_tarefa_desconhecido_falha_fechado', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    await rejeita(buildContext(comPerm(ctxDe(tenantA), 'ai:use'), entrada(tenantA, { taskType: 'nao_registrada' }), tx, { aiAccess: createAiAccess() }), 422, 'AI_TASK_TYPE_UNKNOWN');
    await rejeita(buildContext({ groupId: null, companyId: null }, entrada(tenantA), tx, { aiAccess: createAiAccess() }), 400, 'AI_CONTEXT_INVALID');
  });
});
