'use strict';

/**
 * Leitura do código do Marketing para as guardas do "Não improvisar" (M9-D440). Sempre relativa a uma RAIZ (a API ou uma cópia dela com a violação injetada), nunca ao diretório fixo.
 * Comentários são apagados mantendo as quebras de linha, então o número da linha de um achado é o do arquivo original.
 */
const fs = require('node:fs');
const path = require('node:path');

const RAIZ_PADRAO = path.join(__dirname, '..', '..', '..');
const PASTA = 'src/features/marketing';

/** Apaga comentários de bloco e de linha preservando as linhas. */
function semComentarios(texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, (m, antes) => antes);
}

const linhaDe = (texto, indice) => texto.slice(0, indice).split('\n').length;

function listar(raiz, sub = '') {
  const base = path.join(raiz, PASTA, sub);
  const saida = [];
  const andar = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, e.name);
      if (e.isDirectory()) andar(completo);
      else if (e.name.endsWith('.js')) saida.push(path.relative(path.join(raiz, PASTA), completo).split(path.sep).join('/'));
    }
  };
  andar(base);
  return saida.sort();
}

/** Texto do arquivo (relativo a src/features/marketing) sem comentários; null se o arquivo não existe. */
function ler(raiz, arquivo) {
  const completo = path.join(raiz, PASTA, arquivo);
  return fs.existsSync(completo) ? semComentarios(fs.readFileSync(completo, 'utf8')) : null;
}

/** Achados de uma expressão regular em todos os arquivos (opcionalmente filtrados): [{ arquivo, linha, trecho }]. */
function achar(raiz, regex, { somente = () => true } = {}) {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const saida = [];
  for (const arquivo of listar(raiz).filter(somente)) {
    const texto = ler(raiz, arquivo);
    for (const m of texto.matchAll(re)) saida.push({ arquivo, linha: linhaDe(texto, m.index), trecho: m[0].trim().slice(0, 120) });
  }
  return saida;
}

/** O arquivo precisa existir e conter o padrão; senão devolve a violação. */
function exigir(raiz, arquivo, padrao, regra) {
  const texto = ler(raiz, arquivo);
  if (texto === null) return [{ arquivo, linha: 1, regra: `${regra} (o arquivo ${arquivo} não existe)` }];
  return padrao.test(texto) ? [] : [{ arquivo, linha: 1, regra }];
}

/** Posição (linha) da primeira ocorrência do padrão, ou -1. */
function posicao(texto, padrao) {
  const m = padrao.exec(texto);
  return m ? m.index : -1;
}

module.exports = { RAIZ_PADRAO, PASTA, semComentarios, linhaDe, listar, ler, achar, exigir, posicao };
