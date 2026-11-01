'use strict';

/**
 * Corpus permanente da regra de URL em texto (M9-D433, rodada 5). Tabelas GERADAS a partir de cruzamentos (anfitrião x terminação x sufixo, separador x endereço) mais as
 * listas literais das auditorias das rodadas 4 e 5. Cada entrada é um texto de uma frase; quem usa decide o que esperar:
 *  - HOSTIL: findDisallowedUrls devolve ao menos um (bloqueia);
 *  - AMBIGUO: não bloqueia, mas findReviewUrls devolve ao menos um (vai à aprovação humana);
 *  - LEGITIMO: não bloqueia e não vai à revisão (preço, número legal, e-mail, data).
 * Config de teste sem banco: domínio da empresa nayara.com.br, listas padrão, sem consulta de rede.
 */
const U = require('../../../src/features/marketing/security/url.settings');

const config = Object.freeze({
  allowedDomains: ['nayara.com.br'], shorteners: [...U.DEFAULT_SHORTENERS], maxHops: 3, maxLength: 2048, verifyDestination: false, timeoutMs: 1000, tlds: [...U.DEFAULT_TLDS], maxUrls: 20,
  fileExtensions: [...U.DEFAULT_FILE_EXTENSIONS],
});

const HOSTS = ['evil', 'Evil', 'my.evil', 'a.b.evil'];
const KNOWN_TLDS = ['com', 'Com', 'COM', 'net', 'org', 'br', 'io', 'xyz', 'in', 'fr', 'zip', 'gov', 'рф', 'xn--p1ai'];
const IDN_TLDS = ['भारत', 'বাংলা', 'ਭਾਰਤ', 'ભારત', 'భారత్', 'ಭಾರತ', 'ഭാരതം', 'ලංකා', 'ଭାରତ', 'संगठन', 'சிங்கப்பூர்', 'भारतम्', 'भारोत', 'कॉम', 'नेट', 'ভারত'];
const SUFFIXES = ['/login', '/Login', '/x?y=1', '/a#f', ':8080/x'];
const SEPARATORS = ['', ' ', ':', ';', ',', '_', '-', '–', '…', '...', '/', '|', '(', '[', '{', '<', '"', "'", '*', '~', '+', '!', '?', '=', '​', '­', '　', ' '];

/** Endereço de domínio com terminação CONHECIDA (ou IDN real) e caminho: sempre bloqueia, qualquer que seja o separador colado antes. */
function generatedHostile() {
  const out = [];
  for (const host of HOSTS) for (const tld of [...KNOWN_TLDS]) for (const suffix of SUFFIXES) out.push(`Acesse ${host}.${tld}${suffix} agora`);
  for (const tld of IDN_TLDS) out.push(`Acesse evil.${tld}/login agora`, `Acesse evil.${tld} agora`);
  for (const sep of SEPARATORS) out.push(`Acesse${sep}evil.com/login`, `Acesse${sep}www.evil.com`);
  return out;
}

const HOSTILE_LITERAL = [
  'Acesse evil.com/login@x', 'Acesse evil.com/p@ss', 'Acesse evil.com/a?u=b@c', 'Acesse www.evil.com/a@b', 'Veja evil.com/login@nayara.com.br',
  'Acesse evil̀.com/login', 'Acesse x́.com/p', 'Acesse–evil.com/login', 'Veja //[::1]/x', 'Veja //@evil.com', 'Escreva nayara.com.br@evil.com', 'Veja nayara.com.br@evil.com/x',
  'Veja 127.1/x', 'Veja 2130706433', 'Veja 0x7f000001', 'Veja 0177.0.0.1', 'Veja 1.2.3.4', 'Veja Rb.gy/Abc12', 'Veja Bit.ly', 'Veja javascript:alert(1)', 'Veja mailto:a@evil.com', 'Veja hxxps://evil.com',
  `Veja evil.com/${'.'.repeat(3000)}a`, `Veja evil.com/${'-'.repeat(3000)}a`, `Veja evil.com/${',;:!?'.repeat(600)}a`,
];

const AMBIGUOUS = [
  'Av.Paulista/Centro', 'S.Paulo/SP', 'Sr.Silva/Sra.Souza', 'Rua.das.Flores/100', 'Av.Paulista', 'foto.jpg', 'planta.pdf', 'Compre.Agora', 'Trav.das.Flores', 'p.ex. casa', 'Sala.Comercial/Térreo',
  'Ex.Casa/lote', 'cond.sul/norte', '3 dorm.suíte/closet', 'evil.lol', 'evil.zzz/login', 'Casa.Linda', 'Bom.dia',
];

const PRICES = [
  'Aluguel R$ 2.000/mês', 'R$ 3.000/mês', 'R$ 10.000/mês', 'R$ 1.000/m²', 'R$ 5.000/m²', 'IPTU 1.045/ano', 'Fração 0.5/1', 'R$ 1.500.000,00', 'R$ 1.500/mês', 'Valor 12.345.678',
  'Nayara Ltda, CNPJ 12.345.678/0001-90', 'Decreto 10.123/19', 'Lei 8.245/91', 'Processo 12.345.678/9', 'Art. 10.2/3', 'Contrato 2020.123/45', 'Inscrição 123.456.7890/001',
];

const LEGITIMATE = [
  ...PRICES, 'maria.pro@nayara.com.br', 'jose.me@x.com', 'ana.co@x.com', 'Escreva para contato@nayara.com.br', 'Preço R$ 1.000,00 em 10.12.2026', 'pi 3.14 e v1.2.3', 'e/ou km/h',
  'versão 1.2.3.4x', 'Fale com @maria hoje', 'Às 10:30, sala 2', 'Acesse www.nayara.com.br', 'Veja nayara.com.br/imovel/1', 'Protocolo 1234567', 'Tel. 11 99999-9999', 'CEP 01310-100',
  'Apto 52.B', '1.200 m²', 'área 120,5m2', 'Entrada 20%', 'Taxa 0,99%', 'Prazo 12x', 'S.A.', 'Ltda.', 'etc.', 'e.g.',
];

module.exports = { config, generatedHostile, HOSTILE_LITERAL, AMBIGUOUS, PRICES, LEGITIMATE };
