'use strict';

/**
 * Varredura de segredos do texto a indexar (M9-D022, passo 6). "Não indexar secrets": o trecho com credencial (chave, token, senha,
 * string de conexão, chave privada) é REMOVIDO antes de virar chunk e contado em `removed`. Chave privada PEM sai de ponta a ponta
 * (do BEGIN ao END) e conta uma vez. As expressões vêm da biblioteca única de redaction (M9-D246); aqui só se decide o que fazer.
 */
const { rx } = require('../../../shared/redaction');
const { containsSecret } = require('../guards/secretPatterns');

const hasConnectionPassword = (linha) => rx('connectionPassword', '').test(linha);
const looksSecret = (linha) => containsSecret(linha) || hasConnectionPassword(linha);

/**
 * scanSecrets(texto) => { text, removed, removedChars, totalChars, percent }
 * `percent` = parte do texto original (em caracteres, de 0 a 100) que era credencial; o chamador compara com ia.rag.segredos_rejeitar_percentual.
 */
function scanSecrets(texto) {
  const original = String(texto || '');
  const totalChars = original.length;
  let removed = 0;
  let removedChars = 0;
  const semChaves = original.replace(rx('pem'), (bloco) => { removed += 1; removedChars += bloco.length; return '\n'; });
  const mantidas = [];
  for (const linha of semChaves.split('\n')) {
    if (linha.trim() && looksSecret(linha)) { removed += 1; removedChars += linha.length; continue; }
    mantidas.push(linha);
  }
  const text = mantidas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, removed, removedChars, totalChars, percent: totalChars ? Math.min(100, (removedChars / totalChars) * 100) : 0 };
}

module.exports = { scanSecrets };
