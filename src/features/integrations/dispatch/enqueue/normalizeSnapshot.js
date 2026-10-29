'use strict';

const AppError = require('../../../../utils/AppError');

const MAX_DEPTH = 20;
const invalido = (detalhe) => AppError.unprocessable('Os dados não atendem ao formato exigido pelo fornecedor.', 'INTEGRATION_PAYLOAD_INVALID', { problemas: [detalhe] });

/** Número como texto decimal: sem expoente, sem "-0", sem separador de milhar. */
function decimalString(n, caminho) {
  if (!Number.isFinite(n)) throw invalido(`${caminho}: número inválido`);
  const texto = n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  return texto === '-0' ? '0' : texto;
}

function visitar(valor, caminho, nivel, vistos) {
  if (valor === null || typeof valor === 'boolean' || typeof valor === 'string') return valor;
  if (typeof valor === 'number') return decimalString(valor, caminho);
  if (typeof valor === 'bigint') return valor.toString();
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) throw invalido(`${caminho}: data inválida`);
    return valor.toISOString();
  }
  if (typeof valor !== 'object') throw invalido(`${caminho}: tipo não suportado`);
  if (nivel >= MAX_DEPTH) throw invalido(`${caminho}: profundidade acima de ${MAX_DEPTH}`);
  if (vistos.has(valor)) throw invalido(`${caminho}: referência circular`);
  vistos.add(valor);
  const saida = Array.isArray(valor)
    ? valor.map((v, i) => (v === undefined ? null : visitar(v, `${caminho}[${i}]`, nivel + 1, vistos)))
    : Object.fromEntries(Object.keys(valor).filter((k) => valor[k] !== undefined).map((k) => [k, visitar(valor[k], `${caminho}.${k}`, nivel + 1, vistos)]));
  vistos.delete(valor);
  return saida;
}

/**
 * normalizeSnapshot — a forma do conteúdo aprovado (M9-D214 3.1 item 4): números viram texto decimal, datas viram ISO-8601 em UTC e
 * `undefined` some. O resultado é o que se grava em `payload_snapshot` e o que o hash cobre (a ordem das chaves é do JSON canônico).
 */
function normalizeSnapshot(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalido('$: o conteúdo precisa ser um objeto');
  return visitar(payload, '$', 0, new Set());
}

module.exports = { normalizeSnapshot, decimalString };
