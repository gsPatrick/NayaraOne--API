'use strict';

// M9-D026 / AI-014 — tarefa `calcular_*` é SEMPRE regra determinística (RULE): nenhum modelo é chamado. As demais tarefas
// financeiras podem usar o modelo, mas só para explicar: os números passam pelo NumberAuditor.

const { enforceNumbers } = require('./enforceNumbers');
const { renderPlaceholders, isPayloadItem } = require('./placeholders');

const CALCULATION_TASK = /^calcular_/i;
const isCalculationTask = (taskType) => CALCULATION_TASK.test(String(taskType || ''));

/** Caminho de roteamento imposto pelo tipo da tarefa (null = o ModelRouter decide). */
const forcedRoutingPath = (taskType) => (isCalculationTask(taskType) ? 'RULE' : null);

/** Texto montado só com placeholders: o valor escrito é o do read model, formatado pelo servidor. */
function deterministicAnswer(numbersPayload) {
  const lines = numbersPayload.filter(isPayloadItem).map((i) => `${i.label || i.ref}: {{num:${i.ref}}}`);
  return renderPlaceholders(lines.join('\n'), numbersPayload);
}

/**
 * Produz a resposta numérica. `model({ attempt, violations })` devolve o texto do modelo; para `calcular_*` nunca é chamado.
 * Retorno: { text, routingPath, modelCalled, numbersFromReadModelOnly, attempts }.
 */
async function produceNumericAnswer({ taskType, numbersPayload, model, knownTexts = [], sourceCount = null }) {
  if (isCalculationTask(taskType)) {
    return { text: deterministicAnswer(numbersPayload), routingPath: 'RULE', modelCalled: false, numbersFromReadModelOnly: true, attempts: 0 };
  }
  const first = await model({ attempt: 1, violations: [] });
  const out = await enforceNumbers({ text: first, numbersPayload, knownTexts, sourceCount, regenerate: model });
  return { text: out.text, routingPath: 'MODEL', modelCalled: true, numbersFromReadModelOnly: out.numbersFromReadModelOnly, attempts: out.attempts };
}

module.exports = { isCalculationTask, forcedRoutingPath, deterministicAnswer, produceNumericAnswer };
