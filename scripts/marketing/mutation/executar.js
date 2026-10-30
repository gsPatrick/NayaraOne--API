#!/usr/bin/env node
'use strict';

/**
 * Mutation check do Marketing: para cada mutação do grupo, copia a API, injeta a violação e roda o teste nomeado; o teste TEM de reprovar. Mutação que passa é defeito do teste.
 * Só roda em banco descartável (DISPOSABLE_DB=1): node scripts/withDisposableDb.js -- bash -c "node scripts/seed-ci-two-tenants.js && node scripts/marketing/mutation/executar.js --grupo adversariais".
 * Opções: --grupo adversariais|guardas  --relatorio arquivo.json  --so id1,id2
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const arvore = require('./arvore');

const GRUPOS = { adversariais: './adversariais', guardas: './guardas' };

function argumento(nome) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function rodar(mutacao) {
  const dir = arvore.criarCopia();
  try {
    arvore.aplicar(dir, mutacao.edicoes);
    const r = spawnSync('node', ['--test', '--test-concurrency=1', mutacao.teste], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' }, maxBuffer: 64 * 1024 * 1024 });
    const saida = `${r.stdout}\n${r.stderr}`;
    const reprovados = Number((saida.match(/^ℹ fail (\d+)/m) || [])[1] || 0);
    const passados = Number((saida.match(/^ℹ pass (\d+)/m) || [])[1] || 0);
    const motivo = (saida.match(/^\s*(?:AssertionError|Error|TypeError)[^\n]*\n?[^\n]*/m) || [''])[0].trim().slice(0, 200);
    return { reprovou: r.status !== 0 && reprovados > 0, status: r.status, falhas: reprovados, passados, motivo, resumo: saida.split('\n').filter((l) => /^(✖|ℹ fail|ℹ pass)/.test(l)).slice(0, 8).join('\n') };
  } finally {
    arvore.remover(dir);
  }
}

function main() {
  if (process.env.DISPOSABLE_DB !== '1') { console.error('RECUSADO: o mutation check só roda em banco descartável (scripts/withDisposableDb.js).'); return 2; }
  const grupo = argumento('grupo');
  if (!GRUPOS[grupo]) { console.error(`Uso: --grupo ${Object.keys(GRUPOS).join('|')}`); return 2; }
  const so = (argumento('so') || '').split(',').filter(Boolean);
  const mutacoes = require(GRUPOS[grupo]).filter((m) => !so.length || so.includes(m.id));
  const relatorio = [];
  let sobreviveu = false;
  const controle = rodar({ teste: require(GRUPOS[grupo])[0].teste, edicoes: [] });
  if (controle.falhas > 0 || controle.status !== 0) { console.error(`CONTROLE REPROVADO: a cópia sem mutação já falha (${controle.motivo}); o mutation check não vale.`); return 2; }
  console.log(`controle: a cópia sem mutação passa (${controle.passados} teste(s)).`);
  for (const m of mutacoes) {
    const r = rodar(m);
    sobreviveu = sobreviveu || !r.reprovou;
    relatorio.push({ id: m.id, teste: path.basename(m.teste), mutacao: m.descricao, reprovou: r.reprovou, falhas: r.falhas, motivo: r.motivo });
    console.log(`${r.reprovou ? 'MORTA   ' : 'SOBREVIVEU'} ${m.id} (${path.basename(m.teste)}): ${m.descricao} -> ${r.falhas} teste(s) reprovado(s)${r.motivo ? ` [${r.motivo.split('\n')[0]}]` : ''}`);
    if (!r.reprovou) console.log(r.resumo);
  }
  const out = argumento('relatorio');
  if (out) fs.writeFileSync(out, `${JSON.stringify({ grupo, geradoEm: new Date().toISOString(), resultado: sobreviveu ? 'MUTACAO_SOBREVIVEU' : 'TODAS_MORTAS', mutacoes: relatorio }, null, 2)}\n`);
  console.log(sobreviveu ? 'MUTATION CHECK: uma mutação sobreviveu, o teste não protege a regra.' : `MUTATION CHECK: as ${mutacoes.length} mutações foram detectadas.`);
  return sobreviveu ? 1 : 0;
}

process.exit(main());
