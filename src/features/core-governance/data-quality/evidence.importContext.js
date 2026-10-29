'use strict';

/**
 * Contexto interno de importação (M9-D807 §3.3). Só o código do executor da migração (M9-D900) e da importação BCP (M9-D832) o cria;
 * é uma instância de classe, que não atravessa JSON nem corpo de requisição, de modo que nenhuma rota HTTP consegue montar um.
 * O guard compara com `instanceof`, nunca por campo.
 */
class ImportContext {
  constructor(origin) {
    Object.defineProperty(this, 'origin', { value: String(origin), enumerable: false });
    Object.freeze(this);
  }

  toJSON() {
    throw new Error('importContext não é serializável.');
  }
}

function createImportContext(origin) {
  return new ImportContext(origin);
}

const isImportContext = (value) => value instanceof ImportContext;

module.exports = { createImportContext, isImportContext };
