'use strict';

// M9-D915 — contexto LOG: campo HIGH ou RESTRICTED sempre mascarado, e uma bateria de linhas de log sem CPF ou CNPJ completos. Banco descartável: ver m9d915.campo.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d915Env');
const logger = require('../../../src/utils/logger');

let A;
const CPF = '52998224725'; // válido: a biblioteca de redaction confere os dígitos verificadores
const CPF_FORMATTED = '529.982.247-25';
const CNPJ = '11222333000181';
const CNPJ_FORMATTED = '11.222.333/0001-81';
const skip = () => env.skip();

before(async () => {
  if (!env.DISPOSABLE) return;
  A = (await env.loadTenants()).A;
  env.wiring.install();
  await env.ensure(A);
});
after(async () => { await env.sequelize.close(); });

/** Tudo que o logger escreve em stdout enquanto `fn` roda. */
async function capture(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk, ...rest) => { chunks.push(String(chunk)); return typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1]() : true; };
  try { await fn(); } finally { process.stdout.write = original; }
  return chunks.join('');
}

test('m9d915 logs não contêm CPF completo (nem CNPJ) numa bateria de formas de escrever', { skip: skip() }, async () => {
  const out = await capture(async () => {
    logger.info({ cpf: CPF, taxIdNormalized: CPF_FORMATTED, cnpj: CNPJ, person: { taxId: CNPJ_FORMATTED } }, `cadastro de ${CPF_FORMATTED} e ${CNPJ_FORMATTED}`);
    logger.warn(`pessoa ${CPF} com cnpj ${CNPJ}`);
    logger.error({ err: new Error(`falha ao salvar ${CPF_FORMATTED}`) });
    logger.info({ lista: [CPF, { nested: { documento: CNPJ_FORMATTED } }], url: `/people?cpf=${CPF}` }, 'lista');
  });
  assert.ok(out.length > 0, 'o logger escreveu');
  for (const secret of [CPF, CPF_FORMATTED, CNPJ, CNPJ_FORMATTED]) assert.ok(!out.includes(secret), `o log não pode conter ${secret}`);
});

test('m9d915 contexto LOG: HIGH e RESTRICTED sempre mascarados, mesmo com a permissão dedicada; LOW e MEDIUM seguem', { skip: skip() }, async () => {
  const actor = env.actorOf(A, [env.VIEW_RESTRICTED]);
  const restricted = await env.fieldAccess.resolveField('people.persons', 'tax_id_normalized', actor, 'LOG', { value: env.CPF });
  assert.deepEqual([restricted.rule.outcome, restricted.maskedValue], ['MASKED', '••••••'], 'RESTRICTED em log: máscara total');
  const high = await env.fieldAccess.resolveField('people.persons', 'legal_name', actor, 'LOG', { value: 'Maria da Silva' });
  assert.deepEqual([high.rule.outcome, high.maskedValue], ['MASKED', '****ilva']);
  const medium = await env.fieldAccess.resolveField('people.persons', 'status', actor, 'LOG', { value: 'ACTIVE' });
  assert.deepEqual([medium.rule.outcome, medium.maskedValue], ['CLEAR', 'ACTIVE']);
});
