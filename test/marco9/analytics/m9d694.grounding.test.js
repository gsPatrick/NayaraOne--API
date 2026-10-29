'use strict';

// M9-D694 (3.3) — o validador determinístico: número que não casa com a entrada, afirmação de causa sem registro, palavras de causalidade
// fora de uma citação de registro. Parte pura (sem banco): o modelo não consegue desligar a verificação.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateBriefItem: validateItem } = require('../../../src/features/analytics/briefs');
const { numbersIn, allowedNumbers, firstMismatch } = require('../../../src/features/analytics/briefs/groundingNumbers');
const { WORDS } = { WORDS: ['porque', 'devido a', 'causado por', 'por causa de', 'em razao de'] };

const ENTRADA = {
  tipo: 'DAILY', periodo: { inicio: '2026-10-27', fim: '2026-10-27' },
  itens: [{
    refId: 'i1', metricCode: 'fin.free_cash', valor: { valor: '112000.0000', versao: 1 },
    variacao: { atual: '112000', anterior: '130000', absoluta: '-18000', percentual: '-13.85', periodoAnterior: { endDate: '2026-10-26' } },
  }],
  causasRegistradas: [{ id: 'crm.loss_reasons:motivo=PRECO', valor: '6' }, { id: 'crm.loss_reasons:motivo=TOTAL', valor: '14' }],
};
const ctx = () => ({ causeIds: new Set(ENTRADA.causasRegistradas.map((c) => c.id)), allowed: allowedNumbers(ENTRADA), words: WORDS });
const item = (over) => ({ refId: 'i1', tipo: 'EXCECAO', fato: 'O caixa livre ficou em R$ 112.000,00.', variacao: '', incerteza: '', acaoSugerida: '', tipoAfirmacao: 'FATO', ...over });

test('m9d694 NAY inventa causa e o grounding bloqueia', () => {
  const v = validateItem(item({ fato: 'O caixa caiu porque os clientes perderam confiança.' }), ctx());
  assert.equal(v.ok, false);
  assert.equal(v.code, 'ANALYTICS_BRIEF_CAUSE_UNGROUNDED');
  // afirmação marcada como CAUSA sem fonteCausa
  const semFonte = validateItem(item({ tipoAfirmacao: 'CAUSA', fato: 'Segundo o registro de motivos, o caixa caiu por preço.' }), ctx());
  assert.deepEqual([semFonte.ok, semFonte.code], [false, 'ANALYTICS_BRIEF_CAUSE_UNGROUNDED']);
  // fonteCausa apontando para registro que não existe na entrada
  const inventada = validateItem(item({ tipoAfirmacao: 'CAUSA', fonteCausa: ['crm.loss_reasons:motivo=CONFIANCA'], fato: 'Segundo o registro de perdas, o motivo informado foi confiança.' }), ctx());
  assert.deepEqual([inventada.ok, inventada.code], [false, 'ANALYTICS_BRIEF_CAUSE_UNGROUNDED']);
});

test('m9d694 causa com registro-fonte é aceita e citada', () => {
  const ok = validateItem(item({
    tipoAfirmacao: 'CAUSA', fonteCausa: ['crm.loss_reasons:motivo=PRECO', 'crm.loss_reasons:motivo=TOTAL'],
    fato: 'Segundo o registro de motivos de perda, 6 de 14 foram por preço, o motivo informado foi preço devido a negociação.',
  }), ctx());
  assert.deepEqual(ok, { ok: true });
  // sem a citação "segundo o registro" a frase de causa não passa, mesmo com fonte existente
  const semCitacao = validateItem(item({ tipoAfirmacao: 'CAUSA', fonteCausa: ['crm.loss_reasons:motivo=PRECO'], fato: 'Perdemos 6 negócios por preço.' }), ctx());
  assert.equal(semCitacao.ok, false);
});

test('m9d694 número fora da entrada reprova o item', () => {
  const bad = validateItem(item({ fato: 'O caixa livre ficou em R$ 113.000,00.' }), ctx());
  assert.deepEqual([bad.ok, bad.code], [false, 'ANALYTICS_BRIEF_NUMBER_MISMATCH']);
  assert.match(bad.reason, /113\.000,00/);
  // casa até a 2ª casa, com ou sem sinal e em qualquer formato de escrita
  for (const fato of ['O caixa caiu R$ 18.000,00 (-13,85%).', 'Queda de 18000.00 contra 130.000,00.', 'Variação de -13,85% em 2026-10-27 às 06:05, lançamento P-221.']) {
    assert.deepEqual(validateItem(item({ fato }), ctx()), { ok: true }, fato);
  }
  assert.equal(validateItem(item({ fato: 'A queda foi de 13,86%.' }), ctx()).code, 'ANALYTICS_BRIEF_NUMBER_MISMATCH', '2ª casa diferente reprova');
  assert.equal(validateItem(item({ fato: 'Foram 7 itens.' }), ctx()).ok, false, 'contagem que não vem da entrada');
  assert.equal(validateItem(item({ incerteza: 'Pode chegar a R$ 999,00.' }), ctx()).code, 'ANALYTICS_BRIEF_NUMBER_MISMATCH', 'o número em qualquer campo de texto é conferido');
  assert.equal(validateItem(item({ acaoSugerida: 'Cobrir R$ 20.000,00.' }), ctx()).code, 'ANALYTICS_BRIEF_NUMBER_MISMATCH');
});

test('m9d694 palavras de causalidade fora de fonteCausa reprovam', () => {
  for (const fato of ['A queda ocorreu porque sim.', 'Devido a atrasos, o caixa caiu.', 'Queda causado por inadimplência.', 'Por causa de feriados.', 'Em razão de ajustes.', 'PORQUE maiúsculo', 'Em razão  de espaço duplo']) {
    const v = validateItem(item({ fato }), ctx());
    assert.deepEqual([fato, v.ok, v.code], [fato, false, 'ANALYTICS_BRIEF_CAUSE_UNGROUNDED']);
  }
  assert.equal(validateItem(item({ incerteza: 'O motivo é desconhecido porque falta registro.' }), ctx()).ok, false, 'também nos outros campos');
  // palavras parecidas não reprovam
  assert.deepEqual(validateItem(item({ fato: 'O caixa livre ficou em R$ 112.000,00, sem registro de reporque.' }), ctx()), { ok: true });
  assert.equal(numbersIn('Hoje há 2 exceções: (1) prazo, (2) caixa').length, 3);
  assert.equal(firstMismatch('R$ 112.000,00', ctx().allowed), null);
});
