'use strict';

// Conta a pagar gerada pela medição aprovada: a descrição é legível (obra, etapa, % medido, dia da aprovação em São Paulo) e nunca mostra
// o id cru da medição nem da etapa. Antes: `Medição aprovada — etapa "<nome ou id da etapa>" (medição <uuid>)`, que aparecia em
// Financeiro > Aprovações (varredura e2e m45-varredura-codigo-cru). Teste puro, sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { measurementPayableDescription, MAX_DESCRIPTION } = require('../src/modules/finance/application/services/measurement-payable.description');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ID = 'b9794a94-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const ETAPA_ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

test('descrição traz obra, etapa, % medido e o dia da aprovação no fuso de São Paulo; nenhum id', () => {
  const d = measurementPayableDescription({ id: ID, projectStageId: ETAPA_ID, projectName: 'Residencial Aurora', stageName: 'Fundação', measuredPct: '50.00' }, '2026-11-17T01:30:00Z');
  assert.equal(d, 'Medição aprovada — obra "Residencial Aurora", etapa "Fundação", 50% medido, aprovada em 16/11/2026');
  assert.doesNotMatch(d, UUID);
});

test('evento antigo sem nome da obra/etapa: a parte some, o id da etapa nunca entra no lugar do nome', () => {
  const d = measurementPayableDescription({ id: ID, projectStageId: ETAPA_ID, measuredPct: 33.5 }, '2026-11-17T15:00:00Z');
  assert.equal(d, 'Medição aprovada — 33,5% medido, aprovada em 17/11/2026');
  assert.equal(measurementPayableDescription({ id: ID, stageName: ETAPA_ID, projectName: '  ' }), 'Medição aprovada');
});

test('nomes longos são encurtados e o texto cabe nos 255 caracteres da coluna', () => {
  const longo = 'Obra '.repeat(80);
  const d = measurementPayableDescription({ projectName: longo, stageName: longo, measuredPct: 100 }, '2026-11-17T15:00:00Z');
  assert.ok(d.length <= MAX_DESCRIPTION, `${d.length}`);
  assert.match(d, /…", etapa "Obra/);
  assert.match(d, /100% medido, aprovada em 17\/11\/2026$/);
});
