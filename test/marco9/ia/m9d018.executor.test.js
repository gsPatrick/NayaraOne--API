'use strict';

// Marco 9, M9-D018 — a validação roda no executor de tools antes de qualquer execução: argumento inválido vira BLOCKED/SCHEMA,
// a tool não executa, o evento ai.tool_call.blocked é publicado e o limite do administrador (ia.tool.*) é lido da empresa.
// Roda em banco descartável (leitura do parâmetro com RLS real), via scripts/withDisposableDb.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('../../testHelpers');
const { TenantSetting } = require('../../../src/models');
const { executeTool } = require('../../../src/features/ai/tools/toolExecutor');
const { loadArgsLimits } = require('../../../src/features/ai/tools/argsSettings');
const { AI_SETTING_DEFAULTS, AI_SETTINGS_SCHEMA } = require('../../../src/features/ai/ai.settings');
const { SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
const { UUID_A, partes, gravador, LIMITES, toolComSchema, schemaOportunidade } = require('../_helpers/iaTools');

after(async () => { await sequelize.close(); });

const roda = (tool, input, extra = {}) => {
  const g = gravador();
  const p = executeTool({ registry: { [tool.name]: tool }, toolName: tool.name, input, contextParts: partes(), recorder: g, argsLimits: LIMITES, ...extra });
  return { g, p };
};

test('adv_tool_argumento_fora_do_schema_rejeitado', async () => {
  const { tool, chamadas } = toolComSchema(schemaOportunidade());
  const { g, p } = roda(tool, { opportunityId: UUID_A, extra: 'x' });
  await assert.rejects(p, (e) => e.statusCode === 400 && e.code === 'AI_TOOL_ARGS_INVALID');
  assert.equal(chamadas.length, 0);
  assert.equal(g.linhas.length, 1);
  assert.equal(g.linhas[0].status, 'BLOCKED');
});

test('m9d018_falha_nao_executa_tool_e_registra_blocked_schema', async () => {
  const { tool, chamadas } = toolComSchema(schemaOportunidade());
  const { g, p } = roda(tool, { opportunityId: '1; DROP TABLE x' });
  await assert.rejects(p, (e) => e.code === 'AI_TOOL_ARGS_INVALID' && e.details.fields.join() === 'opportunityId');
  assert.equal(chamadas.length, 0, 'a tool não pode executar');
  const l = g.linhas[0];
  assert.equal(l.status, 'BLOCKED');
  assert.equal(l.blockedReason, 'SCHEMA');
  assert.deepEqual(l.invalidFields, ['opportunityId']);
  assert.ok(!JSON.stringify(l).includes('DROP'), 'sem o valor informado no registro');
  assert.equal(g.eventos.length, 1);
  assert.equal(g.eventos[0].type, 'ai.tool_call.blocked');
  assert.equal(g.eventos[0].payload.blockedReason, 'SCHEMA');
});

test('m9d018_company_id_bloqueia_com_codigo_proprio_e_registra_schema', async () => {
  const { tool, chamadas } = toolComSchema(schemaOportunidade());
  const { g, p } = roda(tool, { opportunityId: UUID_A, companyId: 'outra-empresa' });
  await assert.rejects(p, (e) => e.statusCode === 400 && e.code === 'AI_TOOL_ARGS_FORBIDDEN_FIELD');
  assert.equal(chamadas.length, 0);
  assert.equal(g.linhas[0].blockedReason, 'SCHEMA');
  assert.deepEqual(g.linhas[0].invalidFields, ['companyId']);
  assert.ok(!JSON.stringify(g.linhas[0]).includes('outra-empresa'));
});

test('m9d018_argumento_valido_executa_com_default_aplicado', async () => {
  const { tool, chamadas } = toolComSchema(schemaOportunidade());
  const { g, p } = roda(tool, { opportunityId: UUID_A });
  const r = await p;
  assert.equal(r.status, 'SUCCEEDED');
  assert.deepEqual(chamadas, [{ opportunityId: UUID_A, limite: 10 }]);
  assert.equal(g.linhas[0].status, 'SUCCEEDED');
});

test('m9d018_tool_de_escrita_valida_antes_de_virar_proposta', async () => {
  const { tool, chamadas } = toolComSchema(
    { type: 'object', properties: { valor: { type: 'string', format: 'money' } }, required: ['valor'] },
    { name: 'finance.proposePayment', riskLevel: 'CRITICAL', category: 'WRITE', domain: 'FINANCIAL', requiresHumanApproval: true },
  );
  const propostas = [];
  const proposeAction = async (x) => { propostas.push(x); return { id: 'p1' }; };
  const ruim = roda(tool, { valor: 1234.5 }, { proposeAction });
  await assert.rejects(ruim.p, (e) => e.code === 'AI_TOOL_ARGS_INVALID');
  assert.equal(propostas.length, 0, 'argumento inválido nem chega a virar proposta');
  const bom = await roda(tool, { valor: '1234.50' }, { proposeAction }).p;
  assert.equal(bom.status, 'PROPOSED');
  assert.deepEqual(propostas[0].args, { valor: '1234.50' });
  assert.equal(chamadas.length, 0);
});

test('m9d018_parametro_do_administrador_vale_na_validacao_e_nasce_no_dicionario', async () => {
  assert.equal(AI_SETTING_DEFAULTS['ia.tool.string_max_caracteres'], 500);
  assert.equal(AI_SETTING_DEFAULTS['ia.tool.array_max_itens'], 50);
  assert.ok(SETTINGS_SCHEMA['ia.tool.string_max_caracteres'] && SETTINGS_SCHEMA['ia.tool.array_max_itens']);
  assert.deepEqual(AI_SETTINGS_SCHEMA['ia.tool.string_max_caracteres'], SETTINGS_SCHEMA['ia.tool.string_max_caracteres']);
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    assert.deepEqual(await loadArgsLimits(tenant, transaction), { stringMax: 500, arrayMax: 50 });
    await TenantSetting.create({ groupId: tenant.groupId, companyId: tenant.companyId, key: 'ia.tool.string_max_caracteres', value: 20, updatedByUserId: tenant.userId }, { transaction });
    assert.deepEqual(await loadArgsLimits(tenant, transaction), { stringMax: 20, arrayMax: 50 });
    // valor corrompido volta ao padrão conservador
    await TenantSetting.update({ value: 'abc' }, { where: { companyId: tenant.companyId, key: 'ia.tool.string_max_caracteres' }, transaction });
    assert.equal((await loadArgsLimits(tenant, transaction)).stringMax, 500);
    await TenantSetting.update({ value: 20 }, { where: { companyId: tenant.companyId, key: 'ia.tool.string_max_caracteres' }, transaction });
    // o executor lê o parâmetro da empresa quando o chamador não informa os limites
    const { tool, chamadas } = toolComSchema({ type: 'object', properties: { texto: { type: 'string' } } });
    const g = gravador();
    const contexto = partes({ companyId: tenant.companyId, groupId: tenant.groupId });
    await assert.rejects(executeTool({ registry: { [tool.name]: tool }, toolName: tool.name, input: { texto: 'a'.repeat(21) }, contextParts: contexto, recorder: g, transaction }), (e) => e.code === 'AI_TOOL_ARGS_INVALID');
    assert.equal(chamadas.length, 0);
    const ok = await executeTool({ registry: { [tool.name]: tool }, toolName: tool.name, input: { texto: 'a'.repeat(20) }, contextParts: contexto, recorder: gravador(), transaction });
    assert.equal(ok.status, 'SUCCEEDED');
  });
});
