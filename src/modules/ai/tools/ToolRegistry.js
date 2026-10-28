'use strict';

/**
 * ToolRegistry — registro das tools que a NAY pode chamar, cada uma com permission_code.
 * Esqueleto da M9-D003: o serviço existe e é exportado; o comportamento entra na demanda M9-D006.
 */
class ToolRegistry {
  constructor() {
    this.nome = 'ToolRegistry';
  }
}

module.exports = { ToolRegistry };
