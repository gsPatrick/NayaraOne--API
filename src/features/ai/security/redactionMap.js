'use strict';

/**
 * Mapa `placeholder -> valor` de UM run (M9-D027). Vive só na memória do processo durante o run: serve para devolver ao
 * próprio usuário o texto com os dados que ele já poderia ver. Nunca é gravado, serializado, logado nem enviado ao provider
 * (toJSON/inspect devolvem texto fixo). Segredo (token, senha) não entra: placeholder de segredo não tem volta.
 */
const escapar = (texto) => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 1 -> A, 26 -> Z, 27 -> AA. */
function letras(n) {
  let resto = n;
  let saida = '';
  while (resto > 0) {
    resto -= 1;
    saida = String.fromCharCode(65 + (resto % 26)) + saida;
    resto = Math.floor(resto / 26);
  }
  return saida;
}

class RedactionMap {
  #porPlaceholder = new Map();

  #porValor = new Map();

  #contagem = new Map();

  /** Mesmo valor => mesmo placeholder; valor novo do mesmo tipo => `[REDIGIDO:tipo#2]`, `#3`... */
  placeholderFor(tipo, valor, { reversible = true } = {}) {
    const base = `[REDIGIDO:${tipo}]`;
    if (!reversible || typeof valor !== 'string') return base;
    return this.#registrar(tipo, valor, (n) => (n === 1 ? base : `[REDIGIDO:${tipo}#${n}]`));
  }

  /** Nome fictício estável ("Cliente A", "Cliente B"...) para um valor; vale na re-hidratação como qualquer placeholder. */
  aliasFor(rotulo, valor) {
    return this.#registrar(`alias:${rotulo}`, valor, (n) => `${rotulo} ${letras(n)}`);
  }

  #registrar(chaveTipo, valor, montar) {
    const chave = `${chaveTipo}\u0000${valor}`;
    if (this.#porValor.has(chave)) return this.#porValor.get(chave);
    const n = (this.#contagem.get(chaveTipo) || 0) + 1;
    this.#contagem.set(chaveTipo, n);
    const placeholder = montar(n);
    this.#porValor.set(chave, placeholder);
    this.#porPlaceholder.set(placeholder, valor);
    return placeholder;
  }

  get size() { return this.#porPlaceholder.size; }

  /** Troca os placeholders conhecidos pelos valores originais (só no texto devolvido ao usuário). Desconhecido fica como está. */
  rehydrate(texto) {
    if (typeof texto !== 'string' || this.#porPlaceholder.size === 0) return texto;
    const chaves = [...this.#porPlaceholder.keys()].sort((a, b) => b.length - a.length).map(escapar);
    return texto.replace(new RegExp(chaves.join('|'), 'g'), (p) => this.#porPlaceholder.get(p));
  }

  toJSON() { return '[mapa de redaction do run: não serializável]'; }

  [Symbol.for('nodejs.util.inspect.custom')]() { return '[RedactionMap]'; }
}

module.exports = { RedactionMap };
