'use strict';

// Marco 9, M9-D004 (reabertura, teste m9d004_run_grava_agent_version_pelo_orquestrador que falhava só na suíte completa). Causa real: o
// redactor do perfil `ai` trocava pedaços de um UUID por máscara em cerca de 0,35% dos ids ("0bd60392-200b-..." tem "60392-200", que
// parece CEP; "cc823232-..." parece conta "cc"), o pedido seguia ao modelo com o id corrompido e a ferramenta recusava o argumento
// (AI_TOOL_ARGS_INVALID: opportunityId). Id de entidade nunca é dado pessoal. Sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { redactForAi, redactText, redactDeepForAi } = require('../../../src/shared/redaction');
const { redactForStorage, createPiiRedactor } = require('../../../src/features/ai/security/piiRedactor');

const QUE_FALHAVAM = [
  '0bd60392-200b-4740-ba8a-c791a5d439b3', '32f95663-039a-4c8c-abc1-9585800fb2de', '4da92309-971d-40bb-bc08-dd9352111ce9',
  'cc823232-8c32-457f-92e8-45b54fdc7c88', 'cc064905-c15d-4483-b688-90b2a103a279', 'cec17787-932d-4b19-a56f-06d84cb1903a',
];

test('m9d004_uuid_que_parecia_cep_ou_conta_atravessa_o_redactor_intacto', () => {
  for (const id of QUE_FALHAVAM) {
    const pedido = `Resuma [[TOOL:crm.getOpportunity:{"opportunityId":"${id}"}]] [[RESPOSTA:Ok [1].]]`;
    assert.equal(redactForAi(pedido), pedido, id);
    assert.equal(redactForAi(id), id, id);
    assert.equal(redactText(id), id, id);
    assert.equal(redactForStorage(id), id, id);
    assert.equal(createPiiRedactor().text(pedido), pedido, id);
    assert.equal(redactDeepForAi({ opportunityId: id }).opportunityId, id, id);
  }
});

test('m9d004_uuid_aleatorio_nunca_e_alterado_pelo_redactor', () => {
  for (let i = 0; i < 60000; i += 1) {
    const id = crypto.randomUUID();
    const texto = `id ${id} fim`;
    assert.equal(redactForAi(texto), texto, id);
  }
});

test('m9d004_cep_e_conta_de_verdade_continuam_mascarados', () => {
  assert.equal(redactForAi('CEP 01310-100, e 01310-100.'), 'CEP [REDIGIDO:cep], e [REDIGIDO:cep].');
  assert.equal(redactForAi('moro na Rua A, 12 - 01310-100'), 'moro na Rua A, 12 - [REDIGIDO:cep]');
  assert.equal(redactForAi('Ag. 1234 conta corrente 123456-7'), 'Ag. [REDIGIDO:agencia] conta corrente [REDIGIDO:conta]');
  assert.equal(redactForAi('cc: 12345-6 e c/c 98765-4 e conta nº 12345-6'), 'cc: [REDIGIDO:conta] e c/c [REDIGIDO:conta] e conta nº [REDIGIDO:conta]');
});
