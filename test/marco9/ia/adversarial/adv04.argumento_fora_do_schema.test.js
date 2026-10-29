'use strict';

// Suíte adversarial da NAY (M9-D042), teste 4 do livro. Dona: M9-D018. Provider sandbox, banco descartável, rollback.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');
const { executeTool } = require('../../../../src/features/ai/tools/toolExecutor');
const { partes, gravador, LIMITES, toolComSchema, schemaOportunidade, UUID_A } = require('../../_helpers/iaTools');

after(async () => { await F.sequelize.close(); });

test('adv_tool_argumento_fora_do_schema_rejeitado', async () => {
  for (const input of [{ opportunityId: '1;DROP', extra: 'campo fora do schema' }, { opportunityId: '1;DROP' }, { opportunityId: UUID_A, extra: 'x' }]) {
    const { tool, chamadas } = toolComSchema(schemaOportunidade());
    const g = gravador();
    const erro = await executeTool({ registry: { [tool.name]: tool }, toolName: tool.name, input, contextParts: partes(), recorder: g, argsLimits: LIMITES }).then(() => null, (e) => e);
    assert.equal(erro.statusCode, 400, JSON.stringify(input));
    assert.equal(erro.code, 'AI_TOOL_ARGS_INVALID');
    assert.equal(chamadas.length, 0, 'a tool não executa');
    assert.equal(g.linhas[0].status, 'BLOCKED');
    assert.equal(g.linhas[0].blockedReason, 'SCHEMA');
    assert.ok(!JSON.stringify(g.linhas[0]).includes('DROP'), 'o valor informado não vai para o registro');
    assert.equal(g.eventos[0].type, 'ai.tool_call.blocked');
  }
});
