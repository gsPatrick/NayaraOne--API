'use strict';

const errors = require('../ingest.errors');
const { createSqlConnector } = require('./sql.connector');

/**
 * Conector da fonte: o que lê o sistema antigo. Contrato (todos os métodos assíncronos):
 *  - readEvents({ after, upTo?, limit }) -> [{ sourceKey, op: 'I'|'U'|'D', position, record }] em ordem de posição (CDC; `after` exclusivo, `upTo` inclusivo)
 *  - readRows({ afterTs, afterKey, upTo?, limit }) -> [{ sourceKey, updatedAt, record }] em ordem (updatedAt, sourceKey), estritamente depois do par informado (WATERMARK)
 *  - readAllRows({ afterKey, upToKey?, limit }) -> [{ sourceKey, record }] em ordem de chave (FULL_DIFF)
 *  - listKeys() -> todas as chaves existentes hoje na origem (comparação de exclusões)
 *  - close()
 * O conector `SQL` (padrão) lê tabelas/visões do legado por uma conexão somente leitura cujo endereço vem da variável de ambiente NOMEADA em `secret_ref`; nenhum segredo
 * fica na fonte nem em arquivo. Outros conectores se registram por nome (`register`), por exemplo um de arquivo ou de API.
 */
const registry = new Map();
const register = (name, factory) => registry.set(name, factory);
const unregister = (name) => registry.delete(name);

async function open(source) {
  const name = (source.config && source.config.connector) || 'SQL';
  if (registry.has(name)) return registry.get(name)(source);
  if (name === 'SQL') return createSqlConnector(source);
  throw errors.connectorMissing(name);
}

module.exports = { open, register, unregister };
