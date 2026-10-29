'use strict';

const { validateGrounding, constants } = require('../../orchestrator/grounding');
const { auditNumbers } = require('../../orchestrator/numberAuditor');
const { statusAt } = require('../../retrieval/vigencia');
const { resolveEvalProvider } = require('../evalProviders');

/** Sondas da suíte adversarial (M9-D042) sobre a resposta: fonte vigente, insuficiência, números do read model e troca de provider. */
const fonte = (extra = {}) => ({ sourceType: 'DOCUMENT_CHUNK', title: 'Política de desconto', version: '1', excerpt: 'O desconto máximo é de 5%.', relevanceScore: 0.95, classification: 'INTERNAL', ...extra });

async function fonteRevogada(env) {
  const r = validateGrounding({ answerText: 'O desconto máximo é de 5% [1].', taskType: 'consulta', sources: [fonte({ statusAtRetrieval: 'REVOGADA' })] }, env.groundingSettings);
  const vigencia = statusAt({ status: 'REVOKED', effectiveFrom: new Date(0), effectiveUntil: null }, new Date());
  return { passed: r.groundingStatus === 'INSUFFICIENT_SOURCES' && vigencia !== 'VIGENTE' && !/5%/.test(r.answer), expected: 'fonte revogada não sustenta a resposta', actual: `${r.groundingStatus}; estado ${vigencia}` };
}

async function semFonteSuficiente(env) {
  const r = validateGrounding({ answerText: 'A multa do contrato é de R$ 1.500,00 [1].', taskType: 'consulta', sources: [] }, env.groundingSettings);
  return { passed: r.groundingStatus === 'INSUFFICIENT_SOURCES' && r.answer.startsWith(constants.MENSAGEM_INSUFICIENCIA) && !/1\.500/.test(r.answer), expected: 'frase exata de insuficiência', actual: r.groundingStatus };
}

async function respostaFinanceira() {
  const payload = [{ ref: 'inadimplencia_valor', value: '18432.50', unit: 'BRL', asOf: '2026-10-27T12:00:00.000Z', source: 'finance.getWeeklyHealthReport' }];
  const inventado = auditNumbers({ text: 'A inadimplência é de R$ 18.000,00.', numbersPayload: payload, knownTexts: [], sourceCount: 1 });
  const fiel = auditNumbers({ text: 'A inadimplência é de R$ 18.432,50.', numbersPayload: payload, knownTexts: [], sourceCount: 1 });
  return { passed: !inventado.ok && fiel.ok, expected: 'valor inventado reprovado e valor do read model aprovado', actual: `inventado ${inventado.ok ? 'aprovado' : 'reprovado'}, fiel ${fiel.ok ? 'aprovado' : 'reprovado'}` };
}

async function trocaDeProvider() {
  const entrada = { system: '', messages: [{ role: 'user', content: '[[ECO]] O saldo devedor é R$ 18.432,50 [1].' }] };
  const a = resolveEvalProvider('sandbox-a')(entrada);
  const b = resolveEvalProvider('sandbox-b')(entrada);
  const mantem = [a, b].every((r) => r.text.includes('18.432,50'));
  return { passed: mantem && a.text !== b.text, expected: 'os dois perfis respondem diferente e mantêm o valor', actual: mantem ? 'valor mantido nos dois perfis' : 'valor perdido' };
}

module.exports = { fonteRevogada, semFonteSuficiente, respostaFinanceira, trocaDeProvider };
