'use strict';

// Verificação independente do Marco 9, rodada 6 (12/11/2026; DI-M9R-17): `POST /messages/send` com um `text` longo sem espaço levava tempo QUADRÁTICO na
// redação do texto livre (256 KB: 147 s; 20 MB: mais de 10 minutos), com a API inteira parada. Causa: a regra `connectionPassword` de
// src/shared/redaction/patterns.js recomeçava em cada letra e varria a sequência até o fim. A varredura das demais regras achou o mesmo risco em `jwt`,
// `email`, `emailLoose`, `emailSimple` (cada posição varria a sequência inteira) e em `rgLabeled`, `agencyLabeled`, `pixLabeled`, `cepLabeled`,
// `accountLabeled` e `addressPattern` (separadores `\s*` encostados, que dividem um espaço longo de N^2 maneiras).
// Este arquivo prova: (1) tempo linear, com o caso pedido (1 MB sem espaço em menos de 1 s na função isolada) e uma bateria de entradas adversárias;
// (2) o que cada regra redige é EXATAMENTE o mesmo de antes (as fontes antigas estão copiadas abaixo e comparadas em milhares de textos).
// Cada medição roda num processo filho com prazo: na versão antiga o filho não termina e o teste falha no prazo, sem prender a bateria.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { SOURCES } = require('../../../src/shared/redaction/patterns');

const RAIZ = path.join(__dirname, '..', '..', '..');
const MB = 1048576;

/** Roda `corpo` (JS) num processo filho com prazo; o corpo imprime linhas "MS <rótulo> <milissegundos>". Devolve { status, linhas, stdout, morto }. */
function medir(corpo, prazoMs = 60000) {
  const r = spawnSync(process.execPath, ['-e', corpo], { cwd: RAIZ, encoding: 'utf8', timeout: prazoMs, maxBuffer: 16 * MB });
  const linhas = (r.stdout || '').split('\n').filter((l) => l.startsWith('MS ')).map((l) => { const p = l.split(' '); return { rotulo: p.slice(1, -1).join(' '), ms: Number(p[p.length - 1]) }; });
  return { status: r.status, linhas, stdout: r.stdout || '', stderr: r.stderr || '', morto: r.signal === 'SIGTERM' || (r.error && r.error.code === 'ETIMEDOUT') };
}

const conferirPrazo = (r, limiteMs, esperadas) => {
  const ultima = r.linhas.length ? r.linhas[r.linhas.length - 1].rotulo : '(nenhuma)';
  assert.ok(!r.morto, `o processo não terminou no prazo; última medição concluída: ${ultima}\n${r.stdout.slice(-2000)}`);
  assert.equal(r.status, 0, r.stderr.slice(-2000));
  assert.equal(r.linhas.length, esperadas, r.stdout.slice(-2000));
  const lentos = r.linhas.filter((l) => l.ms >= limiteMs).map((l) => `${l.rotulo}: ${l.ms} ms`);
  assert.deepEqual(lentos, [], `acima de ${limiteMs} ms`);
};

test('tempo: 1 MB sem espaço termina em menos de 1 s na regra connectionPassword, em redactText e em redactFreeText (o caminho do envio)', () => {
  const r = medir(`
    const { rx, redactText } = require('./src/shared/redaction');
    const { redactFreeText } = require('./src/shared/redaction/freeText');
    const t = 'x'.repeat(${MB});
    const medir = (rotulo, f) => { const t0 = process.hrtime.bigint(); f(); console.log('MS ' + rotulo + ' ' + Number((process.hrtime.bigint() - t0) / 1000000n)); };
    medir('connectionPassword gi', () => t.replace(rx('connectionPassword', 'gi'), '#'));
    medir('connectionPassword test', () => rx('connectionPassword', '').test(t));
    medir('redactText segredos', () => redactText(t, { secretsOnly: true }));
    medir('redactText', () => redactText(t));
    medir('redactFreeText', () => redactFreeText(t));
  `);
  conferirPrazo(r, 1000, 5);
});

test('tempo: cada regra da biblioteca, com e sem caixa, em 24 entradas adversárias de 256 KB, fica abaixo de 1,5 s (antes: minutos)', () => {
  const r = medir(`
    const { SOURCES } = require('./src/shared/redaction/patterns');
    const N = 262144;
    const rep = (u) => u.repeat(Math.ceil(N / u.length));
    const entradas = {
      'x': rep('x'), 'a1': rep('a1'), 'eyJ': rep('eyJ'), 'a@': rep('a@'), 'a.': rep('a.'), '+': rep('+'), 'a+': rep('a+'), 'a.a%': rep('a.a%'), 'a://': rep('a://'),
      'xox': rep('xox'), '1': rep('1'), '1-': rep('1-'), 'ab ': rep('ab '),
      'RG + espaços': 'RG' + ' '.repeat(N) + 'x', 'ag nº + espaços': 'ag nº' + ' '.repeat(N) + 'x', 'cc nº + espaços': 'cc nº' + ' '.repeat(N) + 'x',
      'pix + espaços': 'pix' + ' '.repeat(N) + '-', 'CEP + espaços': 'CEP' + ' '.repeat(N) + 'x', 'rua + espaços': 'rua' + ' '.repeat(N) + 'x',
      'rua + quebras': 'rua' + ' \\n'.repeat(N / 2) + 'x', 'rua x + espaços': 'rua ab' + ' '.repeat(N) + 'z', 'rua repetida': rep('rua '),
      'token + espaços': 'token' + ' '.repeat(N) + 'x', 'Bearer + espaços': 'Bearer' + ' '.repeat(N),
    };
    for (const [nome, fonte] of Object.entries(SOURCES)) {
      for (const flags of ['g', 'gi']) {
        for (const [rotulo, texto] of Object.entries(entradas)) {
          const re = new RegExp(fonte, flags);
          const t0 = process.hrtime.bigint();
          texto.replace(re, (m) => m);
          console.log('MS ' + nome + ' ' + flags + ' ' + rotulo + ' ' + Number((process.hrtime.bigint() - t0) / 1000000n));
        }
      }
    }
  `, 60000);
  conferirPrazo(r, 1500, Object.keys(SOURCES).length * 2 * 24);
});

test('tempo: os perfis inteiros (log, texto livre do fornecedor e IA) em 1 MB adversário ficam abaixo de 2 s', () => {
  const r = medir(`
    const { redactText } = require('./src/shared/redaction');
    const { redactFreeText } = require('./src/shared/redaction/freeText');
    const { redactForAi } = require('./src/shared/redaction/aiProfile');
    const N = ${MB};
    const entradas = { 'x': 'x'.repeat(N), 'eyJ': 'eyJ'.repeat(N / 4), 'a@': 'a@'.repeat(N / 2), 'a.': 'a.'.repeat(N / 2), 'rua + espaços': 'rua' + ' '.repeat(N) + 'x', 'RG + espaços': 'RG' + ' '.repeat(N) + 'x' };
    for (const [rotulo, texto] of Object.entries(entradas)) {
      for (const [perfil, f] of Object.entries({ redactText, redactFreeText, redactForAi })) {
        const t0 = process.hrtime.bigint();
        f(texto);
        console.log('MS ' + perfil + ' ' + rotulo + ' ' + Number((process.hrtime.bigint() - t0) / 1000000n));
      }
    }
  `, 60000);
  conferirPrazo(r, 2000, 18);
});

// Fontes ANTERIORES das regras reescritas (b4ad88d2), para provar que o que se redige não mudou.
const ANTIGAS = Object.freeze({
  jwt: 'eyJ[\\w-]+\\.[\\w-]+\\.[\\w-]*',
  connectionPassword: '([a-z][a-z0-9+.-]*:\\/\\/[^/\\s:@]+:)([^@\\s/]+)(@)',
  email: '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+',
  emailLoose: '[^\\s@]+@[^\\s@]+\\.[^\\s@]+',
  emailSimple: '[^\\s@]+@[^\\s@]+',
  rgLabeled: '(\\bRG\\b\\s*(?:n[º°o]\\.?)?\\s*[:=-]?\\s*)(\\d{1,2}\\.?\\d{3}\\.?\\d{3}-?[\\dxX]\\b)',
  pixLabeled: '(\\b(?:chave\\s+)?pix\\b\\s*[:=-]?\\s*)([A-Za-z0-9._%+@-]{8,})',
  agencyLabeled: '(\\bag(?:[eê]ncia|\\.)?\\s*(?:n[º°o]\\.?)?\\s*[:=-]?\\s*)(\\d{3,5}(?:-[\\dxX])?\\b)',
  accountLabeled: '((?<![\\w.-])(?:conta(?:\\s+(?:corrente|poupan[cç]a))?|c\\/c|cc|c\\.c\\.)(?:\\s+|\\s*[:=-]\\s*)(?:n[º°o]\\.?\\s*[:=-]?\\s*)?)(\\d{4,12}-?[\\dxX]\\b)',
  addressPattern: '\\b(?:rua|avenida|av\\.|alameda|travessa|rodovia|estrada|pra[cç]a)\\s+[^\\n,;.]{2,60}?,?\\s*(?:n[º°o]?\\.?\\s*)?\\d{1,6}(?:\\s*[,-]\\s*[^\\n,;]{2,40})?',
  cepLabeled: '(\\bCEP\\b\\s*[:=-]?\\s*)(\\d{8}\\b)',
});

const TOKENS = ['eyJ', 'eyj', 'EYJ', '.', '-', '_', 'a', 'x', 'Z', '1', '9', '@', ':', '//', '://', '/', ' ', '  ', '\t', '\n', '\u00a0', '+', '%', '=', ',', ';', '"',
  'rua', 'Rua ', 'av.', 'praça', 'RG', 'nº', 'n°', 'no', 'n.', 'n', 'ag', 'agência', 'conta', 'conta corrente', 'cc', 'c/c', 'c.c.', 'pix', 'chave pix', 'CEP',
  '12', '123', '1234', '12345', '123456', '12345678', '12.345.678-9', '-x', 'X', 'ê', 'postgres', 'user', 'p@ss', 'a.b', 'com', 'token'];
const WS = [' ', ' ', ' ', '\n', '\t', '\u00a0'];

/** Gerador determinístico (a mesma sequência em toda execução). */
function gerador(semente) {
  let s = semente >>> 0;
  const rnd = (n) => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return s % n; };
  const espacos = (n) => Array.from({ length: n }, () => WS[rnd(WS.length)]).join('');
  return () => {
    let t = '';
    const k = 1 + rnd(12);
    for (let i = 0; i < k; i += 1) {
      const f = rnd(10);
      if (f === 0) t += espacos(rnd(140)); // separadores longos: os rótulos e o endereço mudam de comportamento perto de 60
      else if (f === 1) t += String.fromCharCode(32 + rnd(95));
      else t += TOKENS[rnd(TOKENS.length)];
    }
    return t;
  };
}

const ocorrencias = (fonte, flags, texto) => {
  const out = [];
  texto.replace(new RegExp(fonte, flags), (...args) => { out.push(JSON.stringify(args.slice(0, args.findIndex((a) => typeof a === 'number') + 1))); return ''; });
  return out.join('|');
};

test('o que cada regra reescrita redige é EXATAMENTE o de antes: mesmas posições e mesmos grupos em 6.000 textos, com e sem caixa, e ancorada', () => {
  const proximo = gerador(20261112);
  const diferencas = [];
  for (let i = 0; i < 6000 && diferencas.length < 5; i += 1) {
    const texto = proximo();
    for (const [nome, antiga] of Object.entries(ANTIGAS)) {
      for (const flags of ['g', 'gi']) {
        const a = ocorrencias(antiga, flags, texto);
        const b = ocorrencias(SOURCES[nome], flags, texto);
        if (a !== b) diferencas.push({ nome, flags, texto, antes: a, agora: b });
      }
      const so = (f) => new RegExp(`^${f}$`).test(texto); // uso ancorado (isEmailFormat, detecção de JWT)
      if (so(antiga) !== so(SOURCES[nome])) diferencas.push({ nome, flags: '^$', texto });
    }
  }
  assert.deepEqual(diferencas, []);
});

test('casos nomeados: o resultado de cada regra reescrita, nos perfis que a usam', () => {
  const { redactText } = require('../../../src/shared/redaction');
  const { redactFreeText } = require('../../../src/shared/redaction/freeText');
  const { redactForAi } = require('../../../src/shared/redaction/aiProfile');
  const casos = [
    // senha em cadeia de conexão: o esquema começa na PRIMEIRA letra da sequência (dígitos antes ficam fora)
    [redactText('postgres://app:s3nh4@db:5432/x', { secretsOnly: true }), 'postgres://app:[REDACTED]@db:5432/x'],
    [redactText('1postgres://app:s3nh4@db/x', { secretsOnly: true }), '1postgres://app:[REDACTED]@db/x'],
    [redactText('+.9ab+c.d-e://u:p:q@h', { secretsOnly: true }), '+.9ab+c.d-e://u:[REDACTED]@h'],
    [redactText(`${'x'.repeat(5000)}://u:p@h`, { secretsOnly: true }), `${'x'.repeat(5000)}://u:[REDACTED]@h`],
    // JWT: começa no primeiro "eyJ" da sequência
    [redactText('xxeyJa.b.c fim', { secretsOnly: true }), 'xx[REDACTED] fim'],
    [redactText('eyJeyJa.b.c', { secretsOnly: true }), '[REDACTED]'],
    // e-mail: depois de um e-mail, o seguinte pode começar colado ao domínio
    [redactFreeText('a@b.c%d@e.f'), '[removido][removido]'],
    [redactFreeText('fale com ana.souza@empresa.com.br hoje'), 'fale com [removido] hoje'],
    [redactText('x+y@z.io'), 'x***@z.io'],
    // rótulos com separador longo
    [redactForAi(`RG${' '.repeat(80)}12.345.678-9`), `RG${' '.repeat(80)}[REDIGIDO:rg]`],
    [redactForAi('ag. nº : 1234-5'), 'ag. nº : [REDIGIDO:agencia]'],
    [redactForAi('chave pix - fulano@banco.com'), 'chave pix - [REDIGIDO:pix]'],
    [redactForAi('CEP: 01310100'), 'CEP: [REDIGIDO:cep]'],
    [redactForAi('conta corrente nº 12345-6'), 'conta corrente nº [REDIGIDO:conta]'],
    // endereço: espaço curto, espaço longo (mais de 60) e espaço longo com quebra de linha
    [redactForAi('mora na rua das Flores, 123 - apto 4'), 'mora na [REDIGIDO:endereco]'],
    [redactForAi(`rua${' '.repeat(3)}1`), '[REDIGIDO:endereco]'],
    [redactForAi(`rua${' '.repeat(100)}45`), '[REDIGIDO:endereco]'],
    [redactForAi(`rua${'\n'.repeat(100)}45`), `rua${'\n'.repeat(100)}45`],
    [redactForAi(`rua ${' \n'.repeat(70)}  45`), '[REDIGIDO:endereco]'],
  ];
  for (const [obtido, esperado] of casos) assert.equal(obtido, esperado);
});
