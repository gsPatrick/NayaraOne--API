'use strict';

// Detecta o ponto exato do imóvel (EXATO de intReadModel) em qualquer estrutura gravada, sem falso positivo com a coordenada pública aproximada
// (que pode começar com os mesmos dígitos ou coincidir em um dos eixos): vazamento é o PAR lat/lng exato como números, ou a coordenada completa em texto.
const { EXATO } = require('./intReadModel');

const TEXTO = [new RegExp(`${String(EXATO.lat).replace('.', '\\.')}(?!\\d)`), new RegExp(`${String(EXATO.lng).replace('.', '\\.')}(?!\\d)`)];

function temPontoExato(valor) {
  if (valor === null || valor === undefined) return false;
  if (typeof valor === 'string') return TEXTO.some((r) => r.test(valor));
  if (Array.isArray(valor)) return valor.some(temPontoExato);
  if (typeof valor === 'object') {
    if (Number(valor.lat) === EXATO.lat && Number(valor.lng) === EXATO.lng) return true;
    return Object.values(valor).some(temPontoExato);
  }
  return false;
}

module.exports = { temPontoExato };
