'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const personService = require('../src/features/people/person.service');

// Os erros de validação de pessoa devolvem details.fields (campo + mensagem em português simples) e nunca citam groupId/companyId ao usuário.
test('createPerson sem nome devolve o campo legalName e não cita groupId/companyId', async () => {
  await assert.rejects(
    () => personService.createPerson({ groupId: 'g', companyId: 'c', legalName: '  ' }, null, {}),
    (err) => {
      assert.equal(err.statusCode ?? err.status, 400);
      assert.equal(err.code, 'PERSON_VALIDATION');
      assert.deepEqual(err.details.fields.map((f) => f.field), ['legalName']);
      assert.doesNotMatch(err.message, /groupId|companyId|legalName/);
      return true;
    }
  );
});

test('createPerson sem contexto de sessão não culpa o campo do formulário', async () => {
  await assert.rejects(
    () => personService.createPerson({ legalName: 'Ana' }, null, {}),
    (err) => {
      assert.equal(err.code, 'PERSON_VALIDATION');
      assert.deepEqual(err.details.fields, []);
      assert.doesNotMatch(err.message, /groupId|companyId/);
      return true;
    }
  );
});
