'use strict';

/**
 * M9-D605 (3.1) — regra `nayara/no-float-money` para src/features/analytics/metrics/formulas/: a fórmula é função pura e o dinheiro nunca
 * passa por ponto flutuante. Proíbe relógio (Date.now, new Date() sem argumento), sorteio (Math.random), Number(...)/parseFloat/
 * Number.parseFloat, .toFixed, Math.round/floor/ceil/trunc, `+x` (coerção) e literal numérico com fração. Use money.js.
 */
const MATH_ROUNDING = new Set(['round', 'floor', 'ceil', 'trunc']);

module.exports = {
  meta: { type: 'problem', schema: [], messages: { proibido: 'Fórmula do BI: {{what}} não é permitido (dinheiro em decimal, sem relógio nem sorteio). Use money.js.' } },
  create(context) {
    const report = (node, what) => context.report({ node, messageId: 'proibido', data: { what } });
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type === 'Identifier' && (c.name === 'Number' || c.name === 'parseFloat')) report(node, `${c.name}()`);
        if (c.type !== 'MemberExpression' || c.computed || c.property.type !== 'Identifier') return;
        const owner = c.object.type === 'Identifier' ? c.object.name : null;
        const prop = c.property.name;
        if (owner === 'Date' && prop === 'now') report(node, 'Date.now()');
        else if (owner === 'Math' && prop === 'random') report(node, 'Math.random()');
        else if (owner === 'Math' && MATH_ROUNDING.has(prop)) report(node, `Math.${prop}()`);
        else if (owner === 'Number' && prop === 'parseFloat') report(node, 'Number.parseFloat()');
        else if (prop === 'toFixed') report(node, '.toFixed()');
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) report(node, 'new Date() sem argumento');
      },
      UnaryExpression(node) {
        if (node.operator === '+' && node.argument.type !== 'Literal') report(node, 'coerção unária (+x)');
      },
      Literal(node) {
        if (typeof node.value === 'number' && (!Number.isInteger(node.value) || /[.eE]/.test(node.raw))) report(node, `o número ${node.raw}`);
      },
    };
  },
};
