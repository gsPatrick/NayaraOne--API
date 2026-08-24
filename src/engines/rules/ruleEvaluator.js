'use strict';

/**
 * Avaliador puro da DSL segura declarativa do Motor de Regras (03_MOTORES_TRANSVERSAIS.md §1.5).
 *
 * `condition_ast_json` é uma árvore de nós dos seguintes formatos:
 *
 *   { "and": [<node>, <node>, ...] }
 *   { "or":  [<node>, <node>, ...] }
 *   { "not": <node> }
 *   { "fact": "<caminho.no.contexto>", "op": "==", "value": <literal> }
 *
 * Operadores suportados: ==, !=, >, >=, <, <=, IN, NOT_IN.
 * `fact` é resolvido contra o `context` avaliado em tempo de chamada via caminho separado
 * por ponto (ex. "financial.amount"). Não há acesso a filesystem, rede, relógio externo,
 * secrets, SQL ou código arbitrário — apenas os literais explícitos do AST e os valores do
 * `context` fornecido pelo chamador.
 */

class RuleEvaluationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleEvaluationError';
  }
}

function resolveFact(context, path) {
  return path.split('.').reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), context);
}

const COMPARATORS = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  IN: (a, b) => Array.isArray(b) && b.includes(a),
  NOT_IN: (a, b) => Array.isArray(b) && !b.includes(a),
};

/**
 * Avalia um nó do AST contra o contexto. Lança RuleEvaluationError em qualquer formato
 * inválido — nunca retorna "true" por omissão (fail-closed também na avaliação em si).
 */
function evaluateNode(node, context) {
  if (!node || typeof node !== 'object') {
    throw new RuleEvaluationError('Nó de condição inválido (esperado objeto).');
  }

  if (Array.isArray(node.and)) {
    return node.and.every((child) => evaluateNode(child, context));
  }
  if (Array.isArray(node.or)) {
    return node.or.some((child) => evaluateNode(child, context));
  }
  if (node.not !== undefined) {
    return !evaluateNode(node.not, context);
  }
  if (node.fact !== undefined) {
    const comparator = COMPARATORS[node.op];
    if (!comparator) {
      throw new RuleEvaluationError(`Operador não suportado: ${node.op}`);
    }
    const factValue = resolveFact(context, node.fact);
    return comparator(factValue, node.value);
  }

  throw new RuleEvaluationError('Nó de condição não reconhecido (esperado and/or/not/fact).');
}

module.exports = { evaluateNode, resolveFact, RuleEvaluationError };
