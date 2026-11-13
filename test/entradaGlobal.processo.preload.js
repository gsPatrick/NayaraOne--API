'use strict';

// Apoio de test/entradaGlobal.processo.test.js (rodada 8): injeta, SEM alterar o código da API, as falhas da rodada 8 da verificação, carregado com
// `node -r <este arquivo> app.js`. Gatilho: arquivo JSON em CI_FALHA_DIR (lido a cada 100 ms e apagado), { tipo, chave }:
//  - 'ue': abre uma transação, pega a trava consultiva `chave` e lança uma exceção num callback (o commit nunca roda);
//  - 'ur': o mesmo, com uma promessa rejeitada sem tratamento no lugar da exceção;
//  - 'segura': abre a transação, pega a trava e não faz mais nada (conexão presa no pool, sessão "idle in transaction").
const fs = require('node:fs');
const path = require('node:path');

const DIR = process.env.CI_FALHA_DIR;
if (DIR) {
  setInterval(() => {
    let nomes = [];
    try { nomes = fs.readdirSync(DIR).filter((n) => n.endsWith('.json')).sort(); } catch (_e) { return; }
    for (const nome of nomes) {
      const arquivo = path.join(DIR, nome);
      let g;
      try { g = JSON.parse(fs.readFileSync(arquivo, 'utf8')); fs.unlinkSync(arquivo); } catch (_e) { continue; }
      disparar(g);
    }
  }, 100).unref();
}

async function disparar(g) {
  const { sequelize } = require(path.join(process.cwd(), 'src/models'));
  const tx = await sequelize.transaction();
  await sequelize.query('SELECT pg_advisory_xact_lock(:chave)', { replacements: { chave: g.chave }, transaction: tx });
  console.log(`CI_FALHA_INJETADA ${g.tipo} trava ${g.chave}`);
  if (g.tipo === 'ue') setTimeout(() => { throw new Error('CI exceção sem tratamento no meio de uma transação'); }, 0);
  if (g.tipo === 'ur') setTimeout(() => { Promise.reject(new Error('CI rejeição sem tratamento no meio de uma transação')); }, 0);
}
