'use strict';

// M9-D915 — AI_allowed: o guarda de campos da IA (aiAccess.assertAllowed) e o ContextBuilder da NAY (M9-D027) usando o guarda real. Banco descartável: ver m9d915.campo.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d915Env');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { buildContext, registerTaskType, unregisterTaskType } = require('../../../src/features/ai/security');
const { resolveDeps } = require('../../../src/features/ai/orchestrator/flow/flow.deps');
const policyService = require('../../../src/features/core-governance/dlp/policy.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const TASK = 'm9d915_registro';
const P = (column) => `people.persons.${column}`;
const FIELDS = [
  { ref: P('tax_id_normalized'), sourceId: 's1', name: 'cpf' },
  { ref: P('status'), sourceId: 's1', name: 'status' },
  { ref: P('preferred_name'), sourceId: 's1', name: 'apelido' },
];
let A;
const skip = () => env.skip();
const agent = (extra = {}) => ({ agentCode: 'NAY_FINANCEIRA', ...extra });
const ctxOf = () => ({ groupId: A.groupId, companyId: A.companyId, userId: A.userId, permissions: ['ai:use'] });
const runtime = (tx) => ({ ctx: ctxOf(), transaction: tx });

before(async () => {
  if (!env.DISPOSABLE) return;
  A = (await env.loadTenants()).A;
  await env.ensure(A);
  env.wiring.install(); // o resolvedor de classe do guard lê o registro (como na aplicação)
  registerTaskType(TASK, { fields: ['registro.cpf', 'registro.status', 'registro.apelido'], nameFields: [] });
});
after(async () => { unregisterTaskType(TASK); await env.sequelize.close(); });

test('m9d915 AI access classification retira campos com ai_allowed falso', { skip: skip() }, async () => {
  const verdict = await env.aiAccess.assertAllowed(FIELDS, agent(), runtime(null));
  assert.ok(verdict.removedFields.includes(P('tax_id_normalized')), 'cpf (ai_allowed=false) fora do contexto');
  assert.ok(verdict.allowedFields.includes(P('status')), 'status (MEDIUM, ai_allowed=true) entra');
  assert.equal(verdict.removed.find((item) => item.ref === P('tax_id_normalized')).reason, 'AI_RESTRICTED');
  const rows = await env.auditRows(A, 'governance.ai_access');
  assert.deepEqual(rows[0].after_json.allowedFields.includes(P('status')), true);
  assert.deepEqual([rows[0].after_json.agent, rows[0].after_json.removedFields.map((item) => item.ref).includes(P('tax_id_normalized'))], ['NAY_FINANCEIRA', true], 'cada decisão é auditada com agente, permitidos e retirados');
  assert.ok(!JSON.stringify(rows[0]).includes(env.CPF), 'a auditoria só guarda referências');
});

test('m9d915 campo ai_allowed com máscara entra mascarado, e a lista fechada de agentes recebe em claro só LOW e MEDIUM', { skip: skip() }, async () => {
  await env.withColumn(A, 'status', { classification: 'MEDIUM', masking: 'PARTIAL', ai_allowed: true }, async () => {
    const verdict = await env.aiAccess.assertAllowed(FIELDS, agent(), runtime(null));
    assert.equal(verdict.masks[P('status')]('ACTIVE-ACCOUNT'), '****OUNT', 'notes MEDIUM com masking PARTIAL entra com máscara');
    await env.inTx(A, (tx) => upsertSetting('governanca.ia.agentes_claro', 'NAY_FINANCEIRA, NAY_COBRANCA', A, A.userId, tx));
    try {
      const claro = await env.aiAccess.assertAllowed(FIELDS, agent(), runtime(null));
      assert.equal(claro.masks[P('status')]('ACTIVE-ACCOUNT'), 'ACTIVE-ACCOUNT', 'agente da lista fechada recebe LOW/MEDIUM em claro');
      const outro = await env.aiAccess.assertAllowed(FIELDS, { agentCode: 'NAY_OUTRO' }, runtime(null));
      assert.equal(outro.masks[P('status')]('ACTIVE-ACCOUNT'), '****OUNT', 'agente fora da lista continua com máscara');
      await env.withColumn(A, 'preferred_name', { classification: 'HIGH', masking: 'PARTIAL', ai_allowed: true }, async () => {
        const alto = await env.aiAccess.assertAllowed(FIELDS, agent(), runtime(null));
        assert.equal(alto.masks[P('preferred_name')]('Maria Souza'), '****ouza', 'HIGH segue mascarado mesmo para o agente em claro');
      });
    } finally { await env.inTx(A, (tx) => upsertSetting('governanca.ia.agentes_claro', 'NENHUM', A, A.userId, tx)); }
  });
});

test('m9d915 RESTRICTED nunca entra no prompt', { skip: skip() }, async () => {
  await env.withColumn(A, 'tax_id_normalized', { ai_allowed: true }, async () => {
    const verdict = await env.aiAccess.assertAllowed(FIELDS, agent(), runtime(null));
    assert.ok(verdict.removedFields.includes(P('tax_id_normalized')));
    assert.ok(!verdict.allowedFields.includes(P('tax_id_normalized')));
  });
});

test('m9d915 a política de AI do DLP e o ai_allowed valem juntos', { skip: skip() }, async () => {
  const tenantRef = { groupId: A.groupId, companyId: A.companyId };
  const edit = (allowed) => env.inTx(A, (tx) => policyService.updatePolicy(tenantRef, { userId: A.userId }, 'MEDIUM', 'AI', { allowed }, tx));
  await edit(false);
  try {
    const verdict = await env.aiAccess.assertAllowed(FIELDS, agent(), runtime(null));
    assert.equal(verdict.removed.find((item) => item.ref === P('status')).reason, 'AI_POLICY_DENY', 'a política nega: o campo sai mesmo com ai_allowed=true');
  } finally { await edit(true); }
  const back = await env.aiAccess.assertAllowed(FIELDS, agent(), runtime(null));
  assert.ok(back.allowedFields.includes(P('status')));
});

test('m9d915 violação tentada (strict) bloqueia com 403 e audita a tentativa; referência inválida e falha do registro retiram o campo', { skip: skip() }, async () => {
  const err = await env.refused(env.aiAccess.assertAllowed(FIELDS, agent({ strict: true }), runtime(null)));
  assert.deepEqual([err.status, err.code, err.message], [403, 'GOV_AI_FIELD_FORBIDDEN', 'Este dado não pode ser enviado à IA.']);
  assert.ok(err.details.fields.includes(P('tax_id_normalized')));
  const blocked = await env.auditRows(A, 'governance.ai_access.blocked');
  assert.ok(blocked.length >= 1, 'a tentativa fica na auditoria');
  const bad = await env.aiAccess.assertAllowed([{ ref: 'cliente.cpf', name: 'cpf' }, { ref: 'x', name: 'x' }], agent(), runtime(null));
  assert.deepEqual([bad.allowedFields, bad.removedFields], [[], ['cliente.cpf', 'x']], 'sem schema.tabela.coluna não há como decidir: fora');
  assert.equal((await env.refused(env.aiAccess.assertAllowed(FIELDS, agent(), {}))).code, 'GOV_AI_CONTEXT_INVALID');
});

test('m9d915 o ContextBuilder da NAY (M9-D027) chama aiAccess.assertAllowed antes de montar o contexto', { skip: skip() }, async () => {
  const calls = [];
  const spy = { assertAllowed: (fields, agentContext, rt) => { calls.push(fields.map((f) => f.ref)); return env.aiAccess.assertAllowed(fields, agentContext, rt); } };
  const source = { id: 's1', key: 'registro', classification: 'INTERNAL', groupId: A.groupId, companyId: A.companyId, fields: { cpf: env.CPF, status: 'ATIVO', apelido: 'Maria' },
    fieldRefs: { cpf: P('tax_id_normalized'), status: P('status'), apelido: P('preferred_name') } };
  const input = { runId: null, taskType: TASK, instruction: 'Resuma o cadastro.', purpose: 'cadastro', provider: { code: 'sandbox', external: false }, sources: [source], agentContext: agent() };
  await withRollbackTenantTransaction(A, async (tx) => {
    const built = await buildContext(ctxOf(), input, tx, { aiAccess: spy });
    assert.equal(calls.length, 1, 'chamou o guarda uma vez, antes de montar');
    const prompt = JSON.stringify(built.messages);
    assert.ok(!prompt.includes(env.CPF), 'o CPF não vai ao prompt');
    assert.ok(prompt.includes('ATIVO'), 'o campo liberado entra');
    const err = await env.refused(buildContext(ctxOf(), input, tx, {}));
    assert.deepEqual([err.status, err.code], [500, 'AI_ACCESS_GUARD_REQUIRED'], 'sem a guarda o contexto não é montado');
  });
});

test('m9d915 o orquestrador usa o guarda real por padrão e aiAccess nulo o desliga', { skip: skip() }, async () => {
  assert.equal(resolveDeps({ toolRegistry: {} }).aiAccess, env.aiAccess, 'sem informar, vale o guarda real da governança');
  assert.equal(resolveDeps({ toolRegistry: {}, aiAccess: null }).aiAccess, null);
  const custom = { assertAllowed: async () => ({ allowedFields: [], removedFields: [] }) };
  assert.equal(resolveDeps({ toolRegistry: {}, aiAccess: custom }).aiAccess, custom);
});

test('m9d915 isolamento entre empresas: o ajuste de uma empresa não vale para a outra', { skip: skip() }, async () => {
  const tenants = await env.loadTenants();
  await env.ensure(tenants.B);
  await env.withColumn(A, 'status', { ai_allowed: false }, async () => {
    const asA = await env.aiAccess.assertAllowed(FIELDS, agent(), runtime(null));
    const asB = await env.aiAccess.assertAllowed(FIELDS, agent(), { ctx: { groupId: tenants.B.groupId, companyId: tenants.B.companyId, userId: tenants.B.userId, permissions: [] }, transaction: null });
    assert.ok(asA.removedFields.includes(P('status')));
    assert.ok(asB.allowedFields.includes(P('status')), 'a empresa B segue com o seu registro');
  });
});
