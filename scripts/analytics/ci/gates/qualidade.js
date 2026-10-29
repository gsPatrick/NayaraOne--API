'use strict';

/**
 * M9-D705 etapa 8 (quality checks) — portão do catálogo: todo read model registrado declara os checks mínimos do livro (freshness,
 * reconciliação, invariante e completude). A decisão é do catálogo da M9-D696 (`assertEveryReadModelDeclaresChecks`); aqui só vira lista.
 */
function avaliarChecksPorReadModel(modelos, quality) {
  try {
    quality.assertEveryReadModelDeclaresChecks(modelos);
    return { ok: true, problemas: [] };
  } catch (e) {
    return { ok: false, problemas: [e.message] };
  }
}

module.exports = { avaliarChecksPorReadModel };
