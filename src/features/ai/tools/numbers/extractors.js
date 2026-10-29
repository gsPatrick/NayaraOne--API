'use strict';

// Extratores de numbersPayload registrados por tool (M9-D026 para as tools dos agentes de obras e jurídico). O extrator recebe a saída já
// validada da tool e devolve itens { ref, label, value (texto decimal), unit (BRL|%|dias|un), source, asOf }; o servidor escreve o valor.
const extractors = new Map();

function registerNumberExtractor(toolName, fn) {
  if (typeof toolName !== 'string' || typeof fn !== 'function') throw new TypeError('extrator inválido');
  extractors.set(toolName, fn);
}

const hasNumberExtractor = (toolName) => extractors.has(toolName);
const extractNumbers = (toolName, output) => (extractors.has(toolName) ? extractors.get(toolName)(output) : []);

module.exports = { registerNumberExtractor, hasNumberExtractor, extractNumbers };
