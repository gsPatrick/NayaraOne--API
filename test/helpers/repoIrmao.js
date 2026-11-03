'use strict';

// Artefatos que só existem ao lado da API no ambiente de quem desenvolve: a pasta irmã Maturacao/ (sem remoto) e o repositório NayaraOne--FRONT.
// O CI faz checkout só da API. Regra: o teste que depende deles EXIGE o artefato e FALHA se ele não existir (suíte local e suíte oficial, sem pular em silêncio).
// Só quando o workflow declara CI_SEM_REPOS_IRMAOS=1 E o artefato realmente não está lá, o teste vira "pulado" com a mensagem NAO_APLICAVEL_NO_CI (visível no spec e no JUnit,
// nunca como passou). Com o artefato presente o teste roda inteiro, mesmo com a variável ligada. Não é teste.
const fs = require('node:fs');
const path = require('node:path');

const API_ROOT = path.join(__dirname, '..', '..');
const MARCADOR = 'NAO_APLICAVEL_NO_CI';
const sem = () => process.env.CI_SEM_REPOS_IRMAOS === '1';

/** Caminho absoluto de um artefato irmão da API (ex.: irmao('Maturacao', 'demandas', 'parametros.csv')). */
const irmao = (...partes) => path.join(API_ROOT, '..', ...partes);

/** Motivo de pulo (texto) só se o CI declarou a ausência E algum dos caminhos (relativos à pasta pai da API) falta; senão `false`. */
function motivoNaoAplicavel(caminhos) {
  if (!sem()) return false;
  const faltam = caminhos.filter((c) => !fs.existsSync(irmao(...c.split('/'))));
  return faltam.length ? `${MARCADOR}: ${faltam.join(', ')} ausente no CI (CI_SEM_REPOS_IRMAOS=1); coberto na suíte local` : false;
}

/** `test` do node:test que só pula pela regra acima; opções e função passam intactas. */
function testeComIrmaos(caminhos, base = require('node:test').test) {
  return (nome, a, b) => {
    const [opcoes, fn] = typeof a === 'function' ? [{}, a] : [a || {}, b];
    const skip = motivoNaoAplicavel(caminhos);
    return base(nome, skip ? { ...opcoes, skip } : opcoes, fn);
  };
}

module.exports = { MARCADOR, irmao, motivoNaoAplicavel, testeComIrmaos };
