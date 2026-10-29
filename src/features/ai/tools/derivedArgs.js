'use strict';

// M9-D021 — argumento "derivado de conteúdo não confiável": valor que só existe dentro de texto untrusted (copiado de PDF,
// e-mail, site ou mensagem) e que o ator não escreveu nem o servidor resolveu. O executor marca `derivedFromUntrusted` e, se a
// tool altera estado ou envia para fora, a chamada vira proposta (D019) em vez de execução.

const { normalizeText } = require('../security/textNormalizer');
const { loadInjectionLimits } = require('../orchestrator/injectionDetector');

function folhas(valor, caminho, saida, profundidade = 0) {
  if (profundidade > 20 || valor === null || valor === undefined) return saida;
  if (typeof valor === 'string' || typeof valor === 'number') saida.push({ caminho, texto: String(valor) });
  else if (Array.isArray(valor)) valor.forEach((v, i) => folhas(v, `${caminho}[${i}]`, saida, profundidade + 1));
  else if (typeof valor === 'object') Object.entries(valor).forEach(([k, v]) => folhas(v, caminho ? `${caminho}.${k}` : k, saida, profundidade + 1));
  return saida;
}

/** Caminhos dos argumentos cujo valor aparece em `untrustedTexts` e não em `actorTexts` nem em `trustedValues`. */
function findDerivedFields(args, { untrustedTexts = [], actorTexts = [], trustedValues = new Set(), minChars = 4 } = {}) {
  if (!untrustedTexts.length) return [];
  const doc = untrustedTexts.map(normalizeText);
  const ator = actorTexts.map(normalizeText);
  return folhas(args, '', []).filter(({ texto }) => {
    const v = normalizeText(texto);
    if (v.length < minChars || trustedValues.has(texto)) return false;
    return doc.some((d) => d.includes(v)) && !ator.some((a) => a.includes(v));
  }).map((f) => f.caminho);
}

/** Como findDerivedFields; o mínimo de caracteres vem de `injectionLimits` ou do parâmetro da empresa (ia.injecao.derivado_min_caracteres). */
async function checkDerived({ args, untrustedTexts, actorTexts, trustedValues, injectionLimits, tenant, transaction }) {
  if (!untrustedTexts || !untrustedTexts.length) return [];
  const limites = injectionLimits || await loadInjectionLimits(tenant, transaction);
  return findDerivedFields(args, { untrustedTexts, actorTexts, trustedValues, minChars: limites.derivedMinChars });
}

module.exports = { findDerivedFields, checkDerived };
