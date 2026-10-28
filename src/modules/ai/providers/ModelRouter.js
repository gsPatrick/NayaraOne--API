'use strict';

/**
 * ModelRouter — escolhe o provider/modelo de cada run (sandbox determinístico ou adapter real).
 * Esqueleto da M9-D003: o serviço existe e é exportado; o comportamento entra na demanda M9-D012.
 */
class ModelRouter {
  constructor() {
    this.nome = 'ModelRouter';
  }
}

module.exports = { ModelRouter };
