'use strict';

// M9-D834 — catálogo dos 11 formulários contingenciais (governance.bcp_form_templates): campos da tabela 3.2, payload_schema, ação fixa pelo tipo, o validador que segue o modelo
// semeado e o isolamento. Banco descartável (o teste de RLS e o de alteração do modelo usam o superusuário do cluster descartável).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { QueryTypes } = require('sequelize');
const env = require('../_helpers/bcpEnv');
const { SPEC } = require('../_helpers/m9d834Spec');

const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const TYPES = ['TEXT', 'INTEGER', 'CENTS', 'DATE', 'DATETIME', 'ENUM', 'PERSON_DOC', 'PHONE', 'REF'];
let A;

before(async () => { if (env.DISPOSABLE) A = (await env.loadTenants()).A; });
after(async () => { if (env.DISPOSABLE) { await env.cleanBcp(); await env.sequelize.close(); } });

const templates = () => env.adminQuery('SELECT * FROM governance.bcp_form_templates ORDER BY sector, form_type').then((r) => r.rows);

test('m9d834 existem os 11 formulários dos seis setores com os campos da tabela 3.2', { skip: skip() }, async () => {
  const rows = await templates();
  assert.equal(rows.length, 11);
  assert.equal(new Set(rows.map((r) => r.sector)).size, 6);
  for (const spec of SPEC) {
    const row = rows.find((r) => r.sector === spec.sector && r.form_type === spec.formType);
    assert.ok(row, `${spec.sector}/${spec.formType} existe`);
    assert.equal(row.intended_action, spec.action);
    assert.ok(row.title && row.title.length > 3, 'título em português');
    const byKey = Object.fromEntries(row.fields.map((f) => [f.key, f]));
    assert.deepEqual(Object.keys(byKey).sort(), [...spec.required, ...spec.optional].sort(), `${spec.formType}: campos`);
    for (const key of spec.required) assert.equal(byKey[key].required, true, `${spec.formType}.${key} obrigatório`);
    for (const key of spec.optional) assert.equal(byKey[key].required, false, `${spec.formType}.${key} opcional`);
    for (const f of row.fields) {
      assert.ok(TYPES.includes(f.type), `tipo ${f.type}`);
      assert.ok(f.label && f.label.length > 1, `${f.key} tem rótulo`);
      if (f.type === 'ENUM') assert.ok(Array.isArray(f.enum) && f.enum.length >= 2, `${f.key} lista os valores`);
    }
    assert.deepEqual(row.payload_schema.required.slice().sort(), spec.required.slice().sort(), 'o esquema exige os mesmos obrigatórios');
  }
  const dup = await env.adminQuery("SELECT count(*)::int AS n FROM (SELECT sector, form_type FROM governance.bcp_form_templates GROUP BY 1, 2 HAVING count(*) > 1) d");
  assert.equal(dup.rows[0].n, 0, 'UNIQUE (sector, form_type)');
});

test('m9d834 payload_schema rejeita valor monetário decimal', { skip: skip() }, async () => {
  const row = (await templates()).find((r) => r.form_type === 'RECEBIMENTO');
  const validate = new Ajv({ allErrors: true }).compile(row.payload_schema);
  const base = { pagador: 'Maria', documento: '12345678909', valorCentavos: 125000, forma: 'PIX', data: '2026-10-20', referenciaParcela: 'P1', comprovanteAnexado: 'SIM' };
  assert.equal(validate(base), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...base, valorCentavos: '1250.00' }), false, 'texto decimal');
  assert.equal(validate({ ...base, valorCentavos: 1250.5 }), false, 'fração');
  assert.equal(validate({ ...base, valorCentavos: 0 }), false, 'zero');
  assert.equal(validate({ ...base, forma: 'BOLETO' }), false, 'fora da lista');
  const { valorCentavos, ...missing } = base;
  assert.equal(validate(missing), false, 'obrigatório ausente');
  for (const r of await templates()) assert.equal(new Ajv().validateSchema(r.payload_schema), true, `${r.form_type} é um JSON Schema válido`);
});

test('m9d834 o validador do payload segue o modelo semeado (nem o catálogo em código nem uma cópia)', { skip: skip() }, async () => {
  const { validatePayload } = require('../../../src/features/core-governance/bcp/bcp.payload');
  const formTemplates = require('../../../src/features/core-governance/bcp/formTemplates.repository');
  const load = () => env.inTx(A, (tx) => formTemplates.findByFormType('RECEBIMENTO', tx));
  const template = await load();
  assert.equal(template.intendedAction, 'RECEIVE_PAYMENT');
  assert.deepEqual(validatePayload(template, env.RECEBIMENTO), []);
  const dec = validatePayload(template, { ...env.RECEBIMENTO, valorCentavos: '1250.00' });
  assert.deepEqual(dec.map((e) => [e.field, e.code]), [['valorCentavos', 'INVALID']]);
  assert.deepEqual(validatePayload(template, { ...env.RECEBIMENTO, data: '2026-02-30' }).map((e) => e.field), ['data'], 'data inexistente');
  const original = (await templates()).find((r) => r.form_type === 'RECEBIMENTO').payload_schema;
  const changed = JSON.parse(JSON.stringify(original));
  changed.properties.forma.enum = ['BOLETO'];
  try {
    await env.adminQuery('UPDATE governance.bcp_form_templates SET payload_schema = $1 WHERE form_type = $2', [JSON.stringify(changed), 'RECEBIMENTO']);
    const after = await load();
    assert.deepEqual(validatePayload(after, env.RECEBIMENTO).map((e) => e.field), ['forma'], 'a mudança no modelo muda o resultado');
  } finally {
    await env.adminQuery('UPDATE governance.bcp_form_templates SET payload_schema = $1 WHERE form_type = $2', [JSON.stringify(original), 'RECEBIMENTO']);
  }
});

test('m9d834 intended_action é fixo pelo form_type', { skip: skip() }, async () => {
  const rows = await templates();
  assert.equal(new Set(rows.map((r) => r.form_type)).size, 11, 'cada tipo existe uma vez só');
  assert.equal(new Set(rows.map((r) => r.intended_action)).size, 11, 'uma ação por tipo');
  await assert.rejects(() => env.adminQuery("UPDATE governance.bcp_form_templates SET intended_action = 'REGISTER_LEAD' WHERE form_type = 'RECEBIMENTO'"), /unique|duplicate|viol/i, 'a ação não repete entre tipos');
});

test('m9d834 isolamento: catálogo só de leitura para o role de execução, igual para os dois grupos', { skip: skip() }, async () => {
  const meta = await env.adminQuery(`SELECT c.relrowsecurity, c.relforcerowsecurity, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'governance' AND c.relname = 'bcp_form_templates'`);
  assert.deepEqual([meta.rows[0].relrowsecurity, meta.rows[0].relforcerowsecurity, meta.rows[0].policies], [true, true, 1]);
  const { B } = await env.loadTenants();
  const read = (t) => env.inTx(t, (tx) => env.sequelize.query('SELECT form_type FROM governance.bcp_form_templates ORDER BY 1', { transaction: tx, type: QueryTypes.SELECT }));
  assert.deepEqual(await read(A), await read(B));
  assert.equal((await read(A)).length, 11);
  // Sem política de escrita e com FORCE RLS, nenhuma linha é alterada (ou o privilégio é negado): o catálogo continua intacto.
  const write = (sql) => env.failure(env.inTx(A, (tx) => env.sequelize.query(`${sql} RETURNING 1`, { transaction: tx, type: QueryTypes.SELECT }).then((r) => assert.equal(r.length, 0, 'nenhuma linha afetada'))));
  const denied = (err) => err === null || /permission|privil|row-level|violates/i.test(err.message);
  assert.ok(denied(await write("UPDATE governance.bcp_form_templates SET title = 'x'")), 'UPDATE não altera nada');
  assert.ok(denied(await write("DELETE FROM governance.bcp_form_templates")), 'DELETE não apaga nada');
  const insert = await env.failure(env.inTx(A, (tx) => env.sequelize.query("INSERT INTO governance.bcp_form_templates (sector, form_type, title, intended_action, fields, payload_schema) VALUES ('OBRAS', 'X', 'X', 'X', '[]', '{}')", { transaction: tx })));
  assert.ok(insert, 'INSERT recusado');
  assert.equal((await templates()).length, 11);
  assert.ok((await templates()).every((r) => r.title !== 'x'));
});
