'use strict';

/**
 * promptBuilder (M9-D027): monta o que vai ao provider. Só os campos da lista branca do taskType (minimização), nomes trocados
 * por "Cliente A" quando a tarefa não precisa do nome e o provider é externo (parâmetro ia.privacidade.pseudonimizar_nomes), e
 * redaction de tudo o que sobrar (`[REDIGIDO:tipo]`). O mapa do run fica em memória para a re-hidratação da resposta.
 */
const { getTaskType } = require('./taskTypes');
const { pickFields, valuesAt } = require('./fieldPicker');
const { createPiiRedactor } = require('./piiRedactor');
const { createNamePseudonymizer } = require('./namePseudonymizer');
const { contextInvalid } = require('./privacy.errors');

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

/**
 * buildPrompt({ taskType, instruction, data, provider, pseudonymizeNames, knownNames, redactor })
 * -> { messages, context, pseudonymized, redactor }. `data` é a lista de registros do contexto (objeto ou lista); `provider.external`
 * false (sandbox/local) não pseudonimiza; ausente conta como externo.
 */
function buildPrompt({ taskType, instruction, data, provider, pseudonymizeNames = true, knownNames = [], redactor = createPiiRedactor() } = {}) {
  const task = getTaskType(taskType);
  if (typeof instruction !== 'string' || !instruction.trim()) throw contextInvalid('A instrução da tarefa é obrigatória.');
  const minimized = pickFields(data, task.fields);
  const external = !provider || provider.external !== false;
  const pseudonymize = pseudonymizeNames === true && external && !task.needsName;
  let context = minimized;
  let system = instruction;
  if (pseudonymize) {
    const pseudonyms = createNamePseudonymizer(redactor.map);
    pseudonyms.learn([...task.nameFields.flatMap((path) => valuesAt(minimized, path)), ...knownNames]);
    context = mapStrings(minimized, pseudonyms.apply);
    system = pseudonyms.apply(instruction);
  }
  const safeContext = redactor.deep(context);
  const safeSystem = redactor.text(system);
  const messages = [{ role: 'system', content: safeSystem }, { role: 'user', content: JSON.stringify(safeContext) }];
  return { messages, context: safeContext, pseudonymized: pseudonymize, redactor };
}

module.exports = { buildPrompt };
