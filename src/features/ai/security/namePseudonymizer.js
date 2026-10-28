'use strict';

/**
 * Pseudonimização de nomes (M9-D027): "João da Silva" vira "Cliente A" no que vai ao provider, com o mesmo apelido para o mesmo
 * nome em todo o run. O apelido entra no mapa do run e volta ao nome só na resposta ao próprio usuário (re-hidratação).
 */
const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'du']);
const ROTULO = 'Cliente';
const MIN_PARTE = 3;

const escapar = (texto) => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Nome completo e, depois, cada parte relevante do nome (maior primeiro, para o nome inteiro vencer). */
function termosDoNome(nome) {
  const partes = nome.split(/\s+/).filter((p) => p.length >= MIN_PARTE && !PARTICULAS.has(p.toLowerCase()));
  return [nome.trim(), ...(partes.length > 1 ? partes : [])];
}

function createNamePseudonymizer(map) {
  const termos = new Map();
  return {
    /** Registra nomes (texto de pessoa). Cada nome ganha um apelido; as partes do nome apontam para o mesmo apelido. */
    learn(nomes) {
      for (const nome of nomes) {
        const limpo = String(nome).trim();
        if (limpo.length < 2) continue;
        const apelido = map.aliasFor(ROTULO, limpo);
        for (const termo of termosDoNome(limpo)) if (!termos.has(termo.toLowerCase())) termos.set(termo.toLowerCase(), apelido);
      }
    },
    apply(texto) {
      if (typeof texto !== 'string' || termos.size === 0) return texto;
      const ordenados = [...termos.keys()].sort((a, b) => b.length - a.length).map(escapar);
      const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${ordenados.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
      return texto.replace(re, (achado) => termos.get(achado.toLowerCase()));
    },
    get size() { return termos.size; },
  };
}

module.exports = { createNamePseudonymizer, ROTULO };
