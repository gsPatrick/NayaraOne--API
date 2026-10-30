'use strict';

/** As 7 guardas do "Não improvisar" (M9-D257, Guia §13), em ordem, com a lista de exceções (vazia). */
const common = require('./common');
const guards = [require('./guard1.sdk'), require('./guard2.segredo'), require('./guard3.webhook'), require('./guard4.retry'), require('./guard5.dto'), require('./guard6.financeiro'), require('./guard7.pronto')];

/** Roda uma guarda e tira as violações cobertas por exceção aprovada. */
function runGuard(guard, opts = {}) {
  const { itens, invalidas } = common.loadExceptions(opts.excecoes);
  return [...invalidas, ...guard.scan(opts).filter((v) => !common.ehExcecao(v, itens))];
}

function runAll(opts = {}) {
  return guards.map((g) => ({ rule: g.rule, name: g.name, violations: runGuard(g, opts) }));
}

module.exports = { guards, runGuard, runAll, ...common };
