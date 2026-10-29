'use strict';

// Marco 9, M9-D214 — classe de risco e confirmação de TODA operação dos ports; attempts com RLS; ligação do enqueuer real.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../testHelpers');
const { PORTS } = require('../../../src/features/integrations/providers/ports');
const { DOMAIN_CAPABILITIES } = require('../../../src/features/integrations/providers/catalog.domains');
const { OPERATION_POLICY } = require('../../../src/features/integrations/providers/ports/operationPolicy');

after(async () => { await sequelize.close(); });

test('dispatch_politica_de_toda_operacao_dos_ports', () => {
  for (const [domain, ops] of Object.entries(DOMAIN_CAPABILITIES)) {
    for (const op of ops) {
      const def = PORTS[domain].operations[op];
      assert.ok(def, `${domain}.${op} existe no port`);
      assert.ok(['SAFE', 'DANGEROUS'].includes(def.opClass), `${domain}.${op} tem opClass`);
      assert.ok(['ON_RESPONSE', 'ON_STATUS'].includes(def.confirmation), `${domain}.${op} tem confirmation`);
      assert.equal(def.opClass, OPERATION_POLICY[domain][op].opClass);
    }
  }
  // As regras do livro: efeito que não se desfaz é DANGEROUS e se confirma por status; remoção idempotente e consulta são SAFE.
  const perigosas = [['BANK', 'submitPayment'], ['SIGNATURE', 'createEnvelope'], ['PORTAL', 'publishListing'], ['SITE', 'publishPage'], ['SOCIAL', 'publishPost'], ['SOCIAL', 'deletePost'], ['FISCAL', 'issueNfse'], ['INSURANCE', 'propose']];
  for (const [d, o] of perigosas) {
    assert.deepEqual([PORTS[d].operations[o].opClass, PORTS[d].operations[o].confirmation], ['DANGEROUS', 'ON_STATUS'], `${d}.${o}`);
  }
  const seguras = [['MESSAGING', 'sendText'], ['EMAIL', 'sendEmail'], ['PORTAL', 'unpublishListing'], ['SITE', 'unpublishPage'], ['SOCIAL', 'getPostStatus'], ['BANK', 'getPaymentStatus'], ['MESSAGING', 'getStatus']];
  for (const [d, o] of seguras) assert.equal(PORTS[d].operations[o].opClass, 'SAFE', `${d}.${o}`);
  // E-mail aceito pela fila do fornecedor só conta como SUBMITTED: ON_RESPONSE com status final declarado.
  assert.deepEqual([...PORTS.EMAIL.operations.sendEmail.finalStatuses], ['DELIVERED']);
});

test('dispatch_attempts_tem_rls_e_force', async () => {
  const [rows] = await sequelize.query(`SELECT c.relrowsecurity, c.relforcerowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS politica
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'integration' AND c.relname = 'dispatch_attempts'`);
  assert.equal(rows.length, 1, 'integration.dispatch_attempts existe');
  assert.deepEqual([rows[0].relrowsecurity, rows[0].relforcerowsecurity, rows[0].politica], [true, true, 1]);
});
