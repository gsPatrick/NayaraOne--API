'use strict';

// M9-D809 — AUD-015 (JUR-003): os 12 tipos de contrato no contrato público e a remoção de um deles é breaking change. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clone, lint, rulesOf } = require('../_helpers/m9d840Contracts');
const { operacaoDoContrato } = require('../_helpers/m9d809Http');
const { CONTRACT_TYPES } = require('../../../src/modules/legal/contracts/application/contract.service');

// Os 12 tipos do caderno do Marco 5 (§3) e os 3 legados que o serviço continua aceitando (SALE, LEASE, SERVICE).
const DOZE_DO_LIVRO = ['SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN', 'CONSTRUCTION', 'ADDENDUM', 'KEY_DELIVERY', 'USED_PROPERTY_DELIVERY'];
const DOZE = ['SALE', 'SALE_CASH', 'SALE_FINANCED', 'SALE_TRADE', 'SALE_INSTALLMENTS', 'LEASE', 'LEASE_RESIDENTIAL', 'LEASE_COMMERCIAL', 'LEASE_SEASONAL', 'PROPERTY_ADMIN', 'SERVICE', 'CONSTRUCTION', 'ADDENDUM', 'KEY_DELIVERY', 'USED_PROPERTY_DELIVERY'];

test('m9d809 AUD-015 o contrato OpenAPI lista os 12 tipos de contrato e remover um é breaking change', () => {
  const { doc } = operacaoDoContrato('POST /legal/contracts');
  const tipo = doc.components.schemas.ContractType;
  assert.deepEqual(tipo.enum, DOZE, 'o enum do contrato público tem os 12 tipos do livro e os 3 legados');
  for (const t of DOZE_DO_LIVRO) assert.ok(tipo.enum.includes(t), `o contrato público aceita o tipo do livro ${t}`);
  assert.equal(tipo['x-closed'], true, 'enum fechado: valor novo em resposta também é breaking');
  assert.deepEqual([...CONTRACT_TYPES].sort(), [...tipo.enum].sort(), 'o contrato público e o serviço aceitam exatamente os mesmos tipos');
  assert.equal(new Set(tipo.enum).size, 15);

  // o escopo fechado exige a operação de criação e a de listagem
  assert.ok(operacaoDoContrato('GET /legal/contracts').op, 'a listagem de contratos consta no contrato');

  // base = o contrato versionado; candidato idêntico passa; sem um dos tipos o lint reprova com mudança incompatível
  const igual = lint(doc, clone(doc));
  assert.deepEqual(igual.changes, [], 'contrato idêntico: nenhuma mudança');
  for (const removido of ['LEASE_COMMERCIAL', 'CONSTRUCTION']) {
    const candidato = clone(doc);
    candidato.components.schemas.ContractType.enum = DOZE.filter((t) => t !== removido);
    const relatorio = lint(doc, candidato);
    assert.ok(relatorio.changes.length > 0, `remover ${removido} deve ser reprovado`);
    assert.ok(relatorio.changes.every((c) => c.code === 'GOV_OPENAPI_BREAKING_CHANGE'), JSON.stringify(rulesOf(relatorio)));
  }
});
