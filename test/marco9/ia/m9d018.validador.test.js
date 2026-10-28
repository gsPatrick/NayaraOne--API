'use strict';

// Marco 9, M9-D018 — validação estrita dos argumentos de tool (Ajv) sem banco: campo desconhecido, tipo errado sem coerção,
// uuid, dinheiro em string decimal, limites de texto e lista, campos de empresa proibidos e defaults declarados.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateToolArgs } = require('../../../src/features/ai/tools/argsValidator');
const { UUID_A, LIMITES, toolComSchema, schemaOportunidade } = require('../_helpers/iaTools');

const valida = (tool, input, limites = LIMITES) => validateToolArgs(tool, input, limites);
const rejeita = (tool, input, codigo = 'AI_TOOL_ARGS_INVALID', status = 400) => assert.throws(() => valida(tool, input), (e) => {
  assert.equal(e.statusCode, status);
  assert.equal(e.code, codigo);
  assert.equal(e.details.blockedReason, 'SCHEMA');
  return true;
});

test('m9d018_argumento_invalido_rejeitado', () => {
  const { tool } = toolComSchema(schemaOportunidade());
  rejeita(tool, { opportunityId: '1; DROP TABLE x' });
  assert.throws(() => valida(tool, { opportunityId: '1; DROP TABLE x' }), (e) => {
    assert.deepEqual(e.details.fields, ['opportunityId']);
    assert.equal(e.message, 'Os argumentos da ferramenta são inválidos: opportunityId.');
    assert.ok(!JSON.stringify(e.details).includes('DROP'), 'o valor informado não volta na resposta');
    return true;
  });
  rejeita(tool, {}); // obrigatório ausente
  rejeita(tool, null);
  rejeita(tool, [UUID_A]);
  rejeita(tool, 'texto');
  // "urn:uuid:" não é uuid de id
  rejeita(tool, { opportunityId: `urn:uuid:${UUID_A}` });
});

test('m9d018_campo_desconhecido_rejeitado', () => {
  const { tool } = toolComSchema({
    type: 'object',
    properties: { filtro: { type: 'object', properties: { nome: { type: 'string' } } } },
  });
  rejeita(tool, { opportunityId: UUID_A });
  assert.throws(() => valida(tool, { extra: 1 }), (e) => { assert.deepEqual(e.details.fields, ['extra']); return true; });
  // também em objeto aninhado, mesmo que o schema não declare additionalProperties
  assert.throws(() => valida(tool, { filtro: { nome: 'a', oculto: true } }), (e) => { assert.deepEqual(e.details.fields, ['filtro.oculto']); return true; });
  // o modelo não escolhe política: permissionCode e afins são campos desconhecidos
  rejeita(tool, { permissionCode: '*', riskLevel: 'LOW', requiresHumanApproval: false });
  assert.deepEqual(valida(tool, { filtro: { nome: 'a' } }).args, { filtro: { nome: 'a' } });
});

test('m9d018_sem_coercao_de_tipo', () => {
  const { tool } = toolComSchema({
    type: 'object',
    properties: { quantidade: { type: 'integer', minimum: 1, maximum: 10 }, ativo: { type: 'boolean' }, nome: { type: 'string' } },
  });
  rejeita(tool, { quantidade: '5' });
  rejeita(tool, { ativo: 'true' });
  rejeita(tool, { nome: 123 });
  rejeita(tool, { quantidade: 5.5 });
  rejeita(tool, { quantidade: 11 });
  rejeita(tool, { quantidade: 0 });
  const entrada = { quantidade: 5, ativo: true, nome: 'ok' };
  assert.deepEqual(valida(tool, entrada).args, entrada);
});

test('m9d018_company_id_como_argumento_rejeitado', () => {
  const { tool } = toolComSchema(schemaOportunidade());
  for (const campo of ['companyId', 'groupId', 'userId', 'company_id', 'GROUP_ID', 'user-id']) {
    for (const valor of [UUID_A, 'qualquer', null, 0]) {
      assert.throws(() => valida(tool, { opportunityId: UUID_A, [campo]: valor }), (e) => {
        assert.equal(e.statusCode, 400);
        assert.equal(e.code, 'AI_TOOL_ARGS_FORBIDDEN_FIELD');
        assert.equal(e.message, 'Este campo é definido pelo servidor e não pode ser informado.');
        assert.equal(e.details.blockedReason, 'SCHEMA');
        assert.deepEqual(e.details.fields, [campo]);
        return true;
      }, `${campo}=${valor}`);
    }
  }
  // aninhado e dentro de lista
  const aninhado = toolComSchema({ type: 'object', properties: { filtro: { type: 'object', properties: { companyId: { type: 'string', format: 'uuid' } } }, itens: { type: 'array', items: { type: 'object', properties: { userId: { type: 'string', format: 'uuid' } } } } } }).tool;
  assert.throws(() => valida(aninhado, { filtro: { companyId: UUID_A } }), (e) => e.code === 'AI_TOOL_ARGS_FORBIDDEN_FIELD' && e.details.fields[0] === 'filtro.companyId');
  assert.throws(() => valida(aninhado, { itens: [{ userId: UUID_A }] }), (e) => e.code === 'AI_TOOL_ARGS_FORBIDDEN_FIELD' && e.details.fields[0] === 'itens[0].userId');
});

test('m9d018_dinheiro_so_string_decimal', () => {
  const { tool } = toolComSchema({ type: 'object', properties: { valor: { type: 'string', format: 'money' } }, required: ['valor'] });
  rejeita(tool, { valor: 1234.5 });
  rejeita(tool, { valor: '1234,50' });
  rejeita(tool, { valor: '1234.567' });
  rejeita(tool, { valor: '-5.00' });
  rejeita(tool, { valor: '1e3' });
  rejeita(tool, { valor: '' });
  for (const ok of ['0', '12', '1234.5', '1234.50']) assert.deepEqual(valida(tool, { valor: ok }).args, { valor: ok });
  // definição que declara dinheiro como número é recusada no registro/uso (nunca float)
  const flutuante = toolComSchema({ type: 'object', properties: { valor: { type: 'number', minimum: 0, maximum: 10 } } }).tool;
  assert.throws(() => valida(flutuante, { valor: 1 }), (e) => e.code === 'AI_TOOL_DEFINITION_INVALID' && e.statusCode === 500);
});

test('m9d018_limites_de_texto_lista_e_numero_com_padroes', () => {
  const { tool } = toolComSchema({
    type: 'object',
    properties: { texto: { type: 'string' }, lista: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 9 } }, curto: { type: 'string', maxLength: 3 } },
  });
  rejeita(tool, { texto: 'a'.repeat(501) });
  assert.ok(valida(tool, { texto: 'a'.repeat(500) }));
  rejeita(tool, { lista: Array.from({ length: 51 }, () => 1) });
  assert.ok(valida(tool, { lista: Array.from({ length: 50 }, () => 1) }));
  rejeita(tool, { curto: 'abcd' });
  // os limites vêm do parâmetro do administrador
  assert.throws(() => valida(tool, { texto: 'a'.repeat(101) }, { stringMax: 100, arrayMax: 50 }), (e) => e.code === 'AI_TOOL_ARGS_INVALID');
  assert.throws(() => valida(tool, { lista: [1, 2, 3] }, { stringMax: 500, arrayMax: 2 }), (e) => e.code === 'AI_TOOL_ARGS_INVALID');
  // número sem minimum/maximum, id sem uuid e lista sem items são definição inválida
  for (const props of [{ n: { type: 'number' } }, { x: { type: 'integer' } }, { opportunityId: { type: 'string' } }, { l: { type: 'array' } }]) {
    const ruim = toolComSchema({ type: 'object', properties: props }).tool;
    assert.throws(() => valida(ruim, {}), (e) => e.code === 'AI_TOOL_DEFINITION_INVALID', JSON.stringify(props));
  }
  // palavra-chave desconhecida no schema também é recusada
  const desconhecida = toolComSchema({ type: 'object', properties: { a: { type: 'string', maxLenght: 5 } } }).tool;
  assert.throws(() => valida(desconhecida, {}), (e) => e.code === 'AI_TOOL_DEFINITION_INVALID');
  // additionalProperties:true na definição é recusado (nada de brecha)
  const aberta = toolComSchema({ type: 'object', additionalProperties: true, properties: {} }).tool;
  assert.throws(() => valida(aberta, {}), (e) => e.code === 'AI_TOOL_DEFINITION_INVALID');
});

test('m9d018_defaults_declarados_aplicados_e_entrada_nao_mutada', () => {
  const { tool } = toolComSchema(schemaOportunidade());
  const entrada = { opportunityId: UUID_A };
  const r = valida(tool, entrada);
  assert.deepEqual(r.args, { opportunityId: UUID_A, limite: 10 });
  assert.deepEqual(entrada, { opportunityId: UUID_A }, 'a entrada original não é alterada');
  // tool sem schema não aceita argumento algum
  const semSchema = toolComSchema(undefined).tool;
  assert.deepEqual(valida(semSchema, {}).args, {});
  rejeita(semSchema, { a: 1 });
});

test('m9d018_free_text_passa_pelo_redactor', () => {
  const { tool } = toolComSchema({ type: 'object', properties: { observacao: { type: 'string', freeText: true, maxLength: 200 }, codigo: { type: 'string', pattern: '^[A-Z]{3}-\\d{3}$', maxLength: 7 } } });
  const r = valida(tool, { observacao: `Cliente pediu retorno. Authorization: ${'Bea'}${'rer'} abcdef0123456789abcdef0123456789abcdef`, codigo: 'ABC-123' });
  assert.ok(!r.args.observacao.includes('abcdef0123456789'), r.args.observacao);
  assert.ok(r.args.observacao.startsWith('Cliente pediu retorno'));
  assert.equal(r.args.codigo, 'ABC-123');
  rejeita(tool, { codigo: 'abc-123' });
  rejeita(tool, { observacao: 'x'.repeat(201) });
});
