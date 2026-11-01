'use strict';

/**
 * Quase todos os models declaram `createdAt: 'created_at'` / `updatedAt: 'updated_at'` nas OPÇÕES, o que RENOMEIA o atributo do
 * Sequelize para `created_at` / `updated_at` (não só a coluna). Por isso `instancia.createdAt` / `instancia.updatedAt` voltavam
 * `undefined` (datas inválidas, prazos que nunca vencem) e `where: { updatedAt: ... }` quebra com "column X.updatedAt does not exist".
 * Aqui damos às instâncias leitura (e escrita) pelos nomes camelCase, apontando para o atributo real. NÃO resolve `where`/`order`/
 * `attributes`: nesses o nome certo continua sendo `created_at` / `updated_at` (há guarda de teste para isso).
 */
function defineTimestampAliases(sequelize) {
  for (const Model of Object.values(sequelize.models)) {
    const ts = Model._timestampAttributes || {};
    for (const camel of ['createdAt', 'updatedAt']) {
      const real = ts[camel];
      if (!real || real === camel || Model.rawAttributes[camel]) continue;
      Object.defineProperty(Model.prototype, camel, {
        configurable: true,
        enumerable: false,
        get() { return this.getDataValue(real); },
        set(value) { this.setDataValue(real, value); },
      });
    }
  }
}

module.exports = { defineTimestampAliases };
