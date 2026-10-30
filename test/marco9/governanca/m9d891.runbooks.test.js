'use strict';

// M9-D891: runbooks operacionais, ADR e higiene dos documentos (sem segredo). Teste de conteúdo de arquivos, sem banco.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { RAIZ, MODULOS, RUNBOOKS, ADR, ler, documentos, secoes } = require('../_helpers/m9d891Docs');
const { rx } = require('../../../src/shared/redaction/patterns');
const { containsSecretLike, looksLikeEmbeddedSecret, containsEmail } = require('../../../src/shared/redaction/detect');

const PACOTE = JSON.parse(ler(path.join(RAIZ, 'package.json')));
const SECOES_RUNBOOK = ['Sintoma', 'Causa provável', 'Passo a passo', 'Como confirmar', 'Quem escalar'];

/** Linhas de comando dentro dos blocos ``` do documento. */
function comandos(markdown) {
  const linhas = [];
  let dentro = false;
  for (const linha of markdown.split('\n')) {
    if (/^\s*```/.test(linha)) { dentro = !dentro; continue; }
    if (dentro && linha.trim()) linhas.push(linha.trim());
  }
  return linhas;
}
const EXECUTAVEL = /^(curl|npm run|node|bash)\b/;

test('m9d891 todo runbook tem comando executável', () => {
  const arquivos = fs.readdirSync(RUNBOOKS).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(arquivos, MODULOS.map((m) => m.runbook).sort(), 'oito runbooks, um por módulo');
  for (const f of arquivos) {
    const texto = ler(path.join(RUNBOOKS, f));
    const doc = secoes(texto);
    for (const s of SECOES_RUNBOOK) assert.ok(doc.has(s) && doc.get(s).length >= 20, `${f}: falta a seção "${s}"`);
    const cmds = comandos(texto).filter((c) => EXECUTAVEL.test(c));
    assert.ok(cmds.length >= 2, `${f}: precisa de comandos reais (curl, npm run, node ou bash)`);
    // o que o comando chama existe: script npm, arquivo de script e job
    for (const c of cmds) {
      const npm = c.match(/^npm run ([\w:-]+)/);
      if (npm) assert.ok(PACOTE.scripts[npm[1]], `${f}: npm run ${npm[1]} não existe no package.json`);
      const script = c.match(/^(?:node|bash) (scripts\/[\w./-]+\.(?:js|sh))/);
      if (script) assert.ok(fs.existsSync(path.join(RAIZ, script[1])), `${f}: ${script[1]} não existe`);
      for (const job of c.matchAll(/require\('\.\/(src\/engines\/jobs\/\w+)'\)/g)) assert.ok(fs.existsSync(path.join(RAIZ, `${job[1]}.js`)), `${f}: ${job[1]} não existe`);
    }
  }
});

test('m9d891 as rotas citadas nos runbooks existem no README do módulo', () => {
  for (const m of MODULOS) {
    const readme = ler(path.join(RAIZ, 'src', 'features', 'core-governance', m.pasta, 'README.md'));
    const texto = ler(path.join(RUNBOOKS, m.runbook));
    for (const c of comandos(texto).filter((x) => x.startsWith('curl'))) {
      const rota = c.match(/"\$API(\/[a-z0-9/-]+)/i);
      if (!rota) continue;
      const base = `/${rota[1].split('/')[1]}`; // prefixo da rota (calendar, data-quality, dlp, exports, feature-flags, ...)
      assert.ok(readme.includes(base), `${m.runbook}: o prefixo ${base} não aparece no README de ${m.pasta}`);
    }
  }
});

test('m9d891 cada decisão tem ADR com contexto, decisão, alternativas, consequências, data e responsável', () => {
  const adrs = fs.readdirSync(ADR).filter((f) => /^\d{4}-.+\.md$/.test(f)).sort();
  assert.ok(adrs.length >= 62, `K1 a K14 (14), duplicidades (10) e os 38 parâmetros do catálogo: ${adrs.length}`);
  for (const f of adrs) {
    const doc = secoes(ler(path.join(ADR, f)));
    for (const s of ['Contexto', 'Decisão', 'Alternativas', 'Consequências', 'Data', 'Responsável']) assert.ok(doc.get(s) && doc.get(s).length > 3, `${f}: falta "${s}"`);
    assert.match(doc.get('Data'), /^\d{4}-\d{2}-\d{2}$/, `${f}: data AAAA-MM-DD`);
  }
  const titulos = adrs.map((f) => ler(path.join(ADR, f)).split('\n')[0]);
  for (let k = 1; k <= 14; k += 1) assert.ok(titulos.some((t) => t.includes(` K${k} `)), `falta o ADR da decisão K${k}`);
  // cada parâmetro do catálogo do bloco, quando o repositório de documentos está ao lado, tem o seu ADR com padrão e origem
  const csv = path.join(RAIZ, '..', 'Maturacao', 'demandas', 'marco-9', '_parametros-bloco-EF.csv');
  if (fs.existsSync(csv)) {
    const chaves = ler(csv).trim().split('\n').slice(1).map((l) => l.split('","')[1]);
    assert.equal(chaves.length, 38);
    const corpo = adrs.map((f) => ler(path.join(ADR, f))).join('\n');
    for (const k of chaves) assert.ok(corpo.includes(`Parâmetro \`${k}\``), `falta o ADR do parâmetro ${k}`);
  } else {
    assert.equal(titulos.filter((t) => t.includes('Parâmetro ')).length, 38);
  }
});

test('m9d891 documentos não contêm segredos', () => {
  const docs = documentos();
  assert.ok(docs.length >= 8 + 1 + 8 + 62);
  for (const arq of docs) {
    const nome = path.relative(RAIZ, arq);
    ler(arq).split('\n').forEach((linha, i) => {
      const onde = `${nome}:${i + 1}`;
      assert.equal(containsSecretLike(linha), false, `${onde}: segredo reconhecível`);
      assert.equal(containsEmail(linha), false, `${onde}: endereço de e-mail`);
      assert.equal(rx('connectionPassword', 'i').test(linha), false, `${onde}: cadeia de conexão com senha`);
      for (const token of linha.split(/[\s`"'<>(),;|]+/)) {
        assert.equal(looksLikeEmbeddedSecret(token), false, `${onde}: valor com segredo embutido`);
        // só o endereço de loopback aparece (o banco descartável exige 127.0.0.1); qualquer outro IP reprova
        if (net.isIPv4(token) && token !== '127.0.0.1') assert.fail(`${onde}: endereço IP ${token}`);
      }
    });
  }
});

test('m9d891 teste do novato executado e registrado', { todo: 'aguarda o verificador independente executar a operação de cada módulo e preencher docs/governance/teste-do-novato.md' }, () => {
  const linhas = ler(path.join(RAIZ, 'docs', 'governance', 'teste-do-novato.md')).split('\n').filter((l) => /^\| (calendar|data-quality|lineage|dlp|bcp|api-governance|finops|feature-flags) \|/.test(l));
  assert.equal(linhas.length, 8, 'uma linha por módulo');
  for (const l of linhas) {
    const [modulo, operacao, data, responsavel, resultado] = l.split('|').slice(1, 6).map((c) => c.trim());
    assert.ok(operacao && !/a preencher/.test(operacao), `${modulo}: operação não registrada`);
    assert.match(data, /^\d{4}-\d{2}-\d{2}$/, `${modulo}: data`);
    assert.ok(responsavel && !/a preencher/.test(responsavel), `${modulo}: responsável`);
    assert.ok(resultado && !/a preencher/.test(resultado), `${modulo}: resultado`);
  }
});
