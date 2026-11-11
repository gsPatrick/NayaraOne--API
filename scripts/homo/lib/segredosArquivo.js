'use strict';
/**
 * Senhas e segredos TOTP do reteste FORA da linha de comando (verificação ISO-7 de 11/11/2026: o segredo TOTP digitado na linha
 * de comando fica no histórico do shell). Duas formas aceitas:
 * - HOMO_SEGREDOS_ARQUIVO=<caminho>: arquivo KEY=VALOR (uma variável HOMO_* por linha; # comenta), FORA de qualquer repositório
 *   git e legível só pelo dono (chmod 600). O script recusa o arquivo dentro de um repositório ou aberto para outros usuários.
 * - Variáveis já exportadas no ambiente (ex.: `read -s HOMO_ADMIN_PASSWORD; export HOMO_ADMIN_PASSWORD`). O que vem do ambiente
 *   vale primeiro.
 * Argumento de linha de comando nunca é lido como segredo: qualquer argumento com cara de senha/segredo/TOTP faz o script parar.
 * Nenhum valor é impresso.
 */
const fs = require('fs');
const path = require('path');
const { PararScript } = require('./cliente');

function repositorioQueContem(arquivo) {
  let dir = path.dirname(arquivo);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const acima = path.dirname(dir);
    if (acima === dir) return null;
    dir = acima;
  }
}

function interpretar(texto) {
  const valores = {};
  for (const linha of texto.split(/\r?\n/)) {
    const l = linha.trim();
    if (!l || l.startsWith('#')) continue;
    const m = l.match(/^(?:export\s+)?(HOMO_[A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) throw new PararScript(`HOMO_SEGREDOS_ARQUIVO: linha fora do formato HOMO_NOME=valor (começa com "${l.split('=')[0].slice(0, 30)}").`);
    valores[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return valores;
}

/** Para se algum argumento da linha de comando parecer segredo (o roteiro não recebe segredo por argumento). */
function recusarSegredoNaLinhaDeComando(argv = process.argv.slice(2)) {
  const suspeito = argv.find((a) => /senha|password|secret|segredo|totp|mfa|token/i.test(a));
  if (suspeito) throw new PararScript('RECUSADO: este roteiro não recebe senha, segredo TOTP nem token pela linha de comando. Use HOMO_SEGREDOS_ARQUIVO (arquivo fora do repositório, chmod 600).');
}

/** Ambiente com as variáveis HOMO_* do arquivo de segredos somadas (as do ambiente têm prioridade). */
function carregarSegredos(env = process.env) {
  if (!env.HOMO_SEGREDOS_ARQUIVO) return { ...env };
  const arquivo = path.resolve(String(env.HOMO_SEGREDOS_ARQUIVO).replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  if (!fs.existsSync(arquivo)) throw new PararScript(`HOMO_SEGREDOS_ARQUIVO não existe: ${arquivo}.`);
  const repo = repositorioQueContem(arquivo);
  if (repo) throw new PararScript(`RECUSADO: o arquivo de segredos está dentro do repositório ${repo}. Guarde-o fora de qualquer repositório (ex.: ~/.nayara/).`);
  if (process.platform !== 'win32' && (fs.statSync(arquivo).mode & 0o077)) throw new PararScript(`RECUSADO: o arquivo de segredos pode ser lido por outros usuários. Rode: chmod 600 ${arquivo}`);
  const juntos = { ...env };
  for (const [k, v] of Object.entries(interpretar(fs.readFileSync(arquivo, 'utf8')))) if (juntos[k] === undefined || juntos[k] === '') juntos[k] = v;
  return juntos;
}

module.exports = { carregarSegredos, recusarSegredoNaLinhaDeComando, interpretar, repositorioQueContem };
