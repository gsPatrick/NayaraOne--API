'use strict';

// M9-D026 — números financeiros vêm de read model determinístico: placeholders {{num:ref}}, NumberAuditor, regeração única,
// aritmética decimal exata e `calcular_*` sem modelo. Função pura (sem banco), com o provider sandbox roteirizado.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const numbers = require('../../../src/features/ai/orchestrator/numbers');
const { sumItems } = require('../../../src/features/ai/tools/numbers/financeNumbers');
const { payloadInadimplencia, modeloSandbox } = require('../_helpers/m9d025Fixtures');

test('m9d026_numero_sem_origem_rejeitado', async () => {
  const payload = payloadInadimplencia();
  const ruim = numbers.auditNumbers({ text: 'A inadimplência é de cerca de R$ 18 mil.', numbersPayload: payload });
  assert.equal(ruim.ok, false);
  assert.deepEqual(ruim.violations.map((v) => v.raw), ['18 mil']);
  // 18.432,5 e 18.432,50 são o mesmo número do read model; 18.432,51 não é
  assert.equal(numbers.auditNumbers({ text: 'Inadimplência: R$ 18.432,50 em 7 parcelas.', numbersPayload: payload }).ok, true);
  assert.equal(numbers.auditNumbers({ text: 'Inadimplência: R$ 18.432,5.', numbersPayload: payload }).ok, true);
  assert.equal(numbers.auditNumbers({ text: 'Inadimplência: R$ 18.432,51.', numbersPayload: payload }).ok, false);
  // unidade importa: o 7 é contagem, não percentual
  assert.equal(numbers.auditNumbers({ text: 'Subiu 7%.', numbersPayload: payload }).ok, false);
  // placeholder sem item, data e identificador desconhecidos, marcador sem fonte
  assert.equal(numbers.auditNumbers({ text: 'Total {{num:nao_existe}}.', numbersPayload: payload }).ok, false);
  assert.equal(numbers.auditNumbers({ text: 'Vence em 12/12/2030.', numbersPayload: payload }).ok, false);
  assert.equal(numbers.auditNumbers({ text: 'Contrato CT-2026-9 em atraso.', numbersPayload: payload }).ok, false);
  assert.equal(numbers.auditNumbers({ text: 'Valor [3].', numbersPayload: payload, sourceCount: 1 }).ok, false);
  // data do snapshot, ordinal e numeração de lista são conhecidos/estruturais
  assert.equal(numbers.auditNumbers({ text: '1. Posição em 27/10/2026 às 14:05, 1º relatório [1].', numbersPayload: payload, sourceCount: 1 }).ok, true);
  // dado conhecido das fontes (data do contrato) pode aparecer
  assert.equal(numbers.auditNumbers({ text: 'Vence em 30/11/2026.', numbersPayload: payload, knownTexts: ['vence em 30/11/2026'] }).ok, true);
  // persistindo o número sem origem depois da nova geração e sem sobrar frase verificada: 422
  await assert.rejects(
    numbers.enforceNumbers({ text: 'Cerca de R$ 18 mil.', numbersPayload: payload, regenerate: async () => 'Uns R$ 20 mil.' }),
    (e) => e.statusCode === 422 && e.code === 'AI_NUMBER_NOT_FROM_SOURCE' && e.message === 'A resposta continha valores que não vêm das fontes e foi bloqueada.',
  );
});

test('m9d026_numero_em_texto_livre_regerado_uma_vez', async () => {
  const payload = payloadInadimplencia();
  // 1ª saída inventa 18 mil; a regeração corrige com placeholders
  const modelo = modeloSandbox(['A inadimplência é de cerca de R$ 18 mil.', 'A inadimplência é de R$ {{num:inad_valor}} em {{num:inad_parcelas}} parcelas [1].']);
  const primeiro = await modelo({ attempt: 1, violations: [] });
  const r = await numbers.enforceNumbers({ text: primeiro, numbersPayload: payload, sourceCount: 1, regenerate: modelo });
  assert.equal(modelo.chamadas.length, 2, 'regerou exatamente uma vez');
  assert.equal(r.regenerated, true);
  assert.equal(r.numbersFromReadModelOnly, false);
  assert.equal(r.text, 'A inadimplência é de R$ 18.432,50 em 7 parcelas [1].');
  assert.equal(modelo.chamadas[1].violations[0].raw, '18 mil', 'a nova geração recebe o motivo');
  // persistindo: devolve só as frases verificadas e marca numbersFromReadModelOnly
  const teimoso = modeloSandbox(['Há R$ 20 mil em atraso.', 'Há R$ 21 mil em atraso. O total é R$ {{num:inad_valor}}.']);
  const t1 = await teimoso({ attempt: 1 });
  const p = await numbers.enforceNumbers({ text: t1, numbersPayload: payload, regenerate: teimoso });
  assert.equal(teimoso.chamadas.length, 2, 'nunca regera duas vezes');
  assert.equal(p.numbersFromReadModelOnly, true);
  assert.equal(p.text, 'O total é R$ 18.432,50.');
  assert.ok(!/mil/.test(p.text));
  // número correto de primeira não chama o modelo de novo
  const certo = modeloSandbox(['Inadimplência: R$ {{num:inad_valor}}.']);
  const c = await numbers.enforceNumbers({ text: await certo({}), numbersPayload: payload, regenerate: certo });
  assert.equal(certo.chamadas.length, 1);
  assert.equal(c.regenerated, false);
});

test('m9d026_modelo_nao_faz_aritmetica_somas_exatas', async () => {
  assert.equal(numbers.sumExact(['1000.10', '2000.20']), '3000.30');
  assert.notEqual(0.1 + 0.2, 0.3, 'com float 0,1 + 0,2 erra');
  assert.equal(numbers.sumExact(['0.1', '0.2']), '0.30');
  assert.equal(numbers.sumExact(['0.005', '0.005']), '0.01', 'meio para cima uma vez, no fim');
  const itens = [
    { ref: 'a', label: 'A', value: '1000.10', unit: 'BRL', source: 'rm', asOf: '2026-10-27T17:05:00.000Z' },
    { ref: 'b', label: 'B', value: '2000.20', unit: 'BRL', source: 'rm', asOf: '2026-10-27T17:05:00.000Z' },
  ];
  const total = sumItems(itens, 'total', 'Total');
  assert.equal(total.value, '3000.30');
  const payload = [...itens, total];
  // o modelo somou por conta própria um valor que não está no payload: reprovado; o servidor soma e o modelo só aponta
  assert.equal(numbers.auditNumbers({ text: 'A soma é R$ 3.000,31.', numbersPayload: itens }).ok, false);
  assert.equal(numbers.auditNumbers({ text: 'A soma é R$ 3.000,30.', numbersPayload: itens }).ok, false, 'mesmo certo: sem origem no read model');
  const r = await numbers.enforceNumbers({ text: 'A soma é {{num:total}}.', numbersPayload: payload });
  assert.equal(r.text, 'A soma é R$ 3.000,30.');
});

test('m9d026_task_calcular_nao_chama_modelo', async () => {
  const payload = payloadInadimplencia();
  const modelo = modeloSandbox([]); // qualquer chamada estoura o teste
  const r = await numbers.produceNumericAnswer({ taskType: 'calcular_inadimplencia', numbersPayload: payload, model: modelo });
  assert.equal(modelo.chamadas.length, 0);
  assert.equal(r.modelCalled, false);
  assert.equal(r.routingPath, 'RULE');
  assert.match(r.text, /Inadimplência: R\$ 18\.432,50/);
  assert.match(r.text, /Parcelas: 7/);
  assert.equal(numbers.forcedRoutingPath('calcular_projecao'), 'RULE');
  assert.equal(numbers.forcedRoutingPath('CALCULAR_x'), 'RULE');
  assert.equal(numbers.forcedRoutingPath('explicar_inadimplencia'), null);
  assert.equal(numbers.isCalculationTask('calcular'), false);
  // tarefa que não é de cálculo usa o modelo, mas só para explicar: os números passam pelo auditor
  const explicar = modeloSandbox(['Está em R$ {{num:inad_valor}}, em {{num:inad_parcelas}} parcelas.']);
  const e = await numbers.produceNumericAnswer({ taskType: 'explicar_inadimplencia', numbersPayload: payload, model: explicar });
  assert.equal(e.modelCalled, true);
  assert.equal(e.text, 'Está em R$ 18.432,50, em 7 parcelas.');
});

test('m9d026_formato_pt_br_e_arredondamento_half_up', async () => {
  const f = (value, unit) => numbers.formatItem({ ref: 'x', value, unit });
  assert.equal(f('18432.5', 'BRL'), 'R$ 18.432,50');
  assert.equal(f('1234567.891', 'BRL'), 'R$ 1.234.567,89');
  assert.equal(f('0.005', 'BRL'), 'R$ 0,01', 'meio para cima');
  assert.equal(f('2.675', 'BRL'), 'R$ 2,68', 'sem o erro de 2,675 em float');
  assert.equal(f('1.005', 'BRL'), 'R$ 1,01');
  assert.equal(f('-1234.565', 'BRL'), '-R$ 1.234,57');
  assert.equal(f('12.345', '%'), '12,35%');
  assert.equal(f('30', 'dias'), '30 dias');
  assert.equal(f('7', 'un'), '7');
  assert.equal(f('1000', 'un'), '1.000');
  // o servidor absorve o "R$" e o "%" que o modelo escreveu junto do placeholder
  const payload = [{ ref: 'v', value: '18432.5', unit: 'BRL' }, { ref: 'p', value: '12.5', unit: '%' }, { ref: 'd', value: '30', unit: 'dias' }];
  assert.equal(numbers.renderPlaceholders('R$ {{num:v}} e {{num:v}}, {{num:p}}%, {{num:d}} dias', payload), 'R$ 18.432,50 e R$ 18.432,50, 12,50%, 30 dias');
});

test('m9d026_payload_das_tools_financeiras_do_registry', async () => {
  const { numbersFromToolOutput } = require('../../../src/features/ai/tools/numbers/financeNumbers');
  const out = {
    generatedAt: '2026-10-27T17:05:00.000Z', overdueReceivable: { count: 7, total: 18432.5 }, overduePayable: { count: 1, total: 100 },
    overdueTotal: 18532.5, delinquencyRatio: 0.12,
  };
  const itens = numbersFromToolOutput('finance.getDelinquency', out);
  const por = Object.fromEntries(itens.map((i) => [i.ref, i]));
  assert.equal(por.inadimplencia_valor.value, '18432.50');
  assert.equal(por.inadimplencia_parcelas.value, '7');
  assert.equal(por.inadimplencia_percentual.value, '12');
  assert.ok(itens.every((i) => i.asOf === out.generatedAt && i.source === 'finance.getWeeklyHealthReport'));
  const texto = await numbers.enforceNumbers({ text: 'Inadimplência: {{num:inadimplencia_valor}} ({{num:inadimplencia_percentual}}) em {{num:inadimplencia_parcelas}} parcelas.', numbersPayload: itens });
  assert.equal(texto.text, 'Inadimplência: R$ 18.432,50 (12,00%) em 7 parcelas.');
  assert.deepEqual(numbersFromToolOutput('crm.getOpportunity', { x: 1 }), []);
});
