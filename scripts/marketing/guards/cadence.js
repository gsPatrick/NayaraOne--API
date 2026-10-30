'use strict';

const { scanDirectory } = require('../../lib/noHardcodedCadence');
const path = require('node:path');
const { PASTA, achar } = require('./source');

const NOME = 'guard_no_hardcoded_cadence';
const REGRAS = {
  cadencia: 'lista de dias de cadência escrita no código; o valor vem do parâmetro marketing.cadencia.* (cadence.defaults.js é o único lugar dos padrões)',
  horario_de_silencio: 'horário de silêncio escrito no código; o valor vem do parâmetro marketing.quiet_hours',
  fuso: 'fuso do horário de silêncio escrito no código; leia o parâmetro marketing.quiet_hours',
  frequency_cap: 'frequency cap escrito no código; leia o parâmetro marketing.frequency_cap.global',
};

// Número solto (ou conta de números) atribuído a um nome de espera, silêncio, backoff, janela ou limite de frequência. 0 e 1 não são cadência. Os dicionários *.settings.js e o cadence.defaults.js
// são o lugar dos padrões e ficam de fora; a unidade de tempo (MIN, DAY_MS) é constante, não cadência.
const NOME_DE_CADENCIA = '(?:delay|cooldown|quiet|backoff|cadenc|interval|espera|frequency|freq|window|janela|ttl|cap)';
const ATRIBUICAO = new RegExp(`\\b(\\w*${NOME_DE_CADENCIA}\\w*)\\s*[:=]\\s*((?:\\d[\\d_]*\\s*[*+/-]\\s*)*\\d[\\d_]*)\\s*(?=[,;)}\\n])`, 'gi');
const PERMITIDO = /\.settings\.js$|cadence\/cadence\.defaults\.js$/;

/** Literais de cadência no código do Marketing, fora dos dicionários de parâmetros. */
function verificar(raiz) {
  const deScanner = scanDirectory(path.join(raiz, PASTA)).map((f) => ({
    arquivo: path.relative(path.join(raiz, PASTA), f.file).split(path.sep).join('/'), linha: f.line, regra: `${REGRAS[f.kind]}: ${f.text}`,
  }));
  const porNome = achar(raiz, ATRIBUICAO, { somente: (arquivo) => !PERMITIDO.test(arquivo) })
    .filter((a) => {
      const numero = a.trecho.split(/[:=]/).slice(1).join('=').trim();
      return !/^[01]$/.test(numero.replace(/[,;)}\s]+$/, ''));
    })
    .map((a) => ({ arquivo: a.arquivo, linha: a.linha, regra: `número de espera, silêncio ou frequência escrito no código (${a.trecho}); o valor vem de parâmetro (getMarketingParam)` }));
  return [...deScanner, ...porNome];
}

module.exports = { NOME, verificar };
