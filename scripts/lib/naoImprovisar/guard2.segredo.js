'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { scanRepository } = require('../secretScanner');
const { API_ROOT, violation, listJs, rawLines, norm } = require('./common');

const ENV_OU_FIXTURE = /(^|\/)\.env(\.[\w.-]+)?$|(^|\/)fixtures?\/|\.fixture\.js$|(^|\/)_helpers\//;
const SENSIVEL = /(secret|token|password|senha)/i;
// Nome que é referência, rastro ou controle (nunca o valor): secret_ref, *_at, hash, versão, contagem, tipo.
const SO_REFERENCIA = /(ref\b|_ref|Ref\b|hash|fingerprint|version|_at\b|At\b|expires|rotat|count|status|kind|Kind|policy|required)/;
const REF_FORMAT_IN = 'src/features/integrations/registry/connections.service.js';

/** Colunas dos modelos e migrations das tabelas de integração: um nome *secret*, *token* ou *password* que não seja só referência indica segredo guardado no banco comum. */
function colunas(root) {
  const achados = [];
  const modelos = listJs(root, 'src/models').filter((f) => /\/Integration[^/]*\.js$/.test(f));
  for (const rel of modelos) {
    rawLines(root, rel).forEach((linha, i) => {
      const m = /^\s*(\w+)\s*:\s*\{\s*type:|field:\s*'(\w+)'/.exec(linha);
      const nome = m && (m[1] || m[2]);
      if (nome && SENSIVEL.test(nome) && !SO_REFERENCIA.test(nome)) achados.push(violation(2, rel, i + 1, `Coluna "${nome}" de tabela de integração parece guardar segredo; o segredo vive no cofre e a tabela guarda só a referência (secret_ref).`, linha));
    });
  }
  const migrations = listJs(root, 'migrations');
  for (const rel of migrations) {
    const linhas = rawLines(root, rel);
    if (!linhas.some((l) => /"integration"\."\w+"|integration\.\w+/.test(l) && /CREATE TABLE|ADD COLUMN/i.test(l))) continue;
    linhas.forEach((linha, i) => {
      const m = /^\s*(\w+)\s+(?:varchar|text|bytea|jsonb|character)/i.exec(linha);
      if (m && SENSIVEL.test(m[1]) && !SO_REFERENCIA.test(m[1])) achados.push(violation(2, rel, i + 1, `Coluna "${m[1]}" criada numa tabela de integração parece guardar segredo.`, linha));
    });
  }
  return achados;
}

/** Regra 2: "Não guardar secret em .env compartilhado/repo/DB comum": .env e fixtures sem padrão de segredo, colunas só de referência, formato de referência exigido no cadastro. */
function scan({ root = API_ROOT } = {}) {
  const allowlistFile = path.join(root, 'scripts', 'secretScan.allowlist.json');
  const { findings } = scanRepository({ root, allowlistFile });
  const achados = findings.filter((f) => ENV_OU_FIXTURE.test(f.file)).map((f) => violation(2, f.file, f.line, `Padrão de segredo (${f.pattern}) em .env ou fixture do repositório.`, f.sample));
  achados.push(...colunas(root));
  const svc = path.join(root, REF_FORMAT_IN);
  if (fs.existsSync(svc) && !/validarSecretRefDaConexao|assertRefFormat|isValidRef/.test(fs.readFileSync(svc, 'utf8'))) {
    achados.push(violation(2, norm(REF_FORMAT_IN), 1, 'O cadastro de connection precisa exigir o formato de referência do cofre (validarSecretRefDaConexao) em `secret_ref`.'));
  }
  return achados;
}

module.exports = { rule: 2, name: 'segredo_fora_do_cofre', scan };
