'use strict';

// Briefing da NAY Diretoria pelo orquestrador REAL (M9-D693): três defeitos só aparecem fora dos testes com executor simulado e deixavam o Centro de Comando em
// "Briefing indisponível" para sempre. Sem banco: cada peça é testada onde decide.
//  1. a fronteira de termos do agente recusava o pedido do próprio servidor ("estime", "calcule" aparecem no texto que PROÍBE o modelo de estimar);
//  2. a checagem de fontes do orquestrador trocava o JSON do briefing por "fonte insuficiente" (o BI confere os números com a fonte exata por conta própria);
//  3. o provedor de laboratório (ai-sandbox) não devolvia JSON, então a homologação nunca exercitava o fluxo inteiro.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerNayDiretoria } = require('../../../src/features/ai/agents/nay_diretoria');
const { scopeGuard } = require('../../../src/features/ai/agents/scope');
const { finalizeGrounding, isServerGrounded } = require('../../../src/features/ai/orchestrator/grounding/finalizeGrounding');
const { sandboxGenerate } = require('../../../src/features/ai/providers/sandbox/sandboxGenerate');
const { instructionFor } = require('../../../src/features/analytics/briefs/brief.input');
const { parseModelOutput, shapeIssue } = require('../../../src/features/analytics/briefs/brief.schema');

registerNayDiretoria();

const ENTRADA = {
  tipo: 'DAILY', periodo: { inicio: '2026-11-07', fim: '2026-11-07' }, periodoAnterior: { inicio: '2026-11-06', fim: '2026-11-06' },
  itens: [
    { refId: 'i1', tipoSugerido: 'EXCECAO', area: 'FINANCE', metricCode: 'fin.free_cash', nome: 'Caixa livre', motivos: [], valor: { valor: '112000.00', unidade: 'BRL', estado: 'OK', versao: 1 }, variacao: { atual: '112000.00', anterior: '130000.00', absoluta: '-18000.00', percentual: '-13.85' }, alertas: [], fonte: [{ metricCode: 'fin.free_cash' }] },
    { refId: 'i2', tipoSugerido: 'DESTAQUE', area: 'CRM', metricCode: 'crm.win_rate', nome: 'Taxa de ganho', motivos: [], alertas: [], fonte: [{ metricCode: 'crm.win_rate' }] },
  ],
  causasRegistradas: [], concomitantes: [],
};
const instruction = instructionFor(ENTRADA, 'porque, devido, causado por');

test('briefing: o texto do servidor contém termos que a fronteira de termos proíbe a uma pessoa', () => {
  assert.match(instruction, /estime/i);
});

test('briefing: a fronteira de termos não se aplica ao pedido montado pelo servidor', async () => {
  const out = await scopeGuard({ agentCode: 'NAY_DIRETORIA', taskType: 'briefing_executivo', input: instruction }, { tenant: {}, transaction: null });
  assert.equal(out, null);
});

test('briefing: a checagem de fontes do orquestrador devolve o JSON intacto', async () => {
  assert.equal(isServerGrounded('NAY_DIRETORIA', 'briefing_executivo'), true);
  assert.equal(isServerGrounded('NAY_DIRETORIA', 'resumo_saude'), false);
  assert.equal(isServerGrounded('NAY_COMERCIAL', 'briefing_executivo'), false);
  const json = JSON.stringify({ itens: [{ refId: 'i1', fato: 'Caixa livre: 112000.00 BRL.' }] });
  const out = await finalizeGrounding({}, { answerText: json, taskType: 'briefing_executivo', agentCode: 'NAY_DIRETORIA', sources: [] }, null);
  assert.equal(out.answer, json);
  assert.equal(out.groundingStatus, 'NOT_APPLICABLE');
});

test('briefing: o provedor de laboratório devolve itens no formato do BI, só com os números dos DADOS', () => {
  const wrapped = `<untrusted id="user-input" origin="USER_INPUT" classification="INTERNAL">\n${instruction}\n</untrusted>`;
  const out = sandboxGenerate({ system: 'x', messages: [{ role: 'user', content: wrapped }] });
  const data = parseModelOutput(out.text);
  assert.equal(data.itens.length, 2);
  for (const item of data.itens) {
    const candidate = ENTRADA.itens.find((i) => i.refId === item.refId);
    assert.equal(shapeIssue(item, { tipo: candidate.tipoSugerido, metricCode: candidate.metricCode, fonte: candidate.fonte }), null);
  }
  assert.match(data.itens[0].fato, /112000\.00/);
  assert.match(data.itens[0].variacao, /130000\.00/);
  assert.match(data.itens[1].fato, /sem valor confiável/);
});

test('briefing: pergunta comum ao laboratório continua com a resposta de teste', () => {
  const out = sandboxGenerate({ system: '', messages: [{ role: 'user', content: 'olá' }] });
  assert.match(out.text, /^Resposta de teste /);
});
