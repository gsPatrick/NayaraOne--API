'use strict';
/**
 * Senhas e segredos TOTP do roteiro de aceite FORA da linha de comando (verificação de 11/11/2026, ISO-7): HOMO_SEGREDOS_ARQUIVO
 * aponta um arquivo KEY=VALOR (uma por linha, # comenta) com as variáveis HOMO_* (ex.: HOMO_ADMIN_PASSWORD,
 * HOMO_OUTRA_EMPRESA_MFA_SECRET). O arquivo precisa estar FORA de qualquer repositório git e legível só pelo dono (chmod 600).
 * O que já veio do ambiente vale primeiro. Nenhum valor é impresso.
 */
const fs = require('fs');
const path = require('path');
const { PararScript } = require('./cliente');

function dentroDeRepositorio(arquivo) {
  let dir = path.dirname(arquivo);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const acima = path.dirname(dir);
    if (acima === dir) return null;
    dir = acima;
  }
}

function lerArquivo(texto) {
  const valores = {};
  for (const linha of texto.split(/\r?\n/)) {
    const l = linha.trim();
    if (!l || l.startsWith('#')) continue;
    const m = l.match(/^(?:export\s+)?(HOMO_[A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) throw new PararScript(`HOMO_SEGREDOS_ARQUIVO: linha fora do formato HOMO_NOME=valor (${l.split('=')[0].slice(0, 40)}).`);
    valores[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return valores;
}

/** Devolve o ambiente com as variáveis HOMO_* do arquivo de segredos (as do ambiente têm prioridade). */
function carregarSegredos(env = process.env) {
  if (!env.HOMO_SEGREDOS_ARQUIVO) return env;
  const arquivo = path.resolve(env.HOMO_SEGREDOS_ARQUIVO.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  if (!fs.existsSync(arquivo)) throw new PararScript(`HOMO_SEGREDOS_ARQUIVO não existe: ${arquivo}.`);
  const repo = dentroDeRepositorio(arquivo);
  if (repo) throw new PararScript(`RECUSADO: o arquivo de segredos está dentro do repositório ${repo}. Guarde-o fora de qualquer repositório (ex.: ~/.nayara/).`);
  if (process.platform !== 'win32' && (fs.statSync(arquivo).mode & 0o077)) {
    throw new PararScript(`RECUSADO: o arquivo de segredos pode ser lido por outros usuários. Rode: chmod 600 ${arquivo}`);
  }
  const doArquivo = lerArquivo(fs.readFileSync(arquivo, 'utf8'));
  const juntos = { ...env };
  for (const [k, v] of Object.entries(doArquivo)) if (juntos[k] === undefined || juntos[k] === '') juntos[k] = v;
  return juntos;
}

module.exports = { carregarSegredos, lerArquivo, dentroDeRepositorio };
