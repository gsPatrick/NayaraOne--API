'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const VERSION_FILE = path.join(REPO_ROOT, 'VERSION');
const clean = (text) => String(text == null ? '' : text).trim().slice(0, 64);
const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

/**
 * Commit em execução e de onde veio, na ordem: GIT_COMMIT do ambiente; arquivo VERSION da raiz da API (a imagem Docker grava ali o SHA do build, o contêiner não tem .git);
 * `git rev-parse HEAD` (desenvolvimento e laboratório); sem nenhum deles, "unknown". VERSION vazio ou "unknown" (build sem GIT_SHA) não conta.
 */
function resolveCommit({ versionFile = VERSION_FILE } = {}) {
  if (clean(process.env.GIT_COMMIT)) return { commit: clean(process.env.GIT_COMMIT), source: 'env' };
  try { const fromImage = clean(fs.readFileSync(versionFile, 'utf8')); if (fromImage && fromImage !== 'unknown') return { commit: fromImage, source: 'image' }; } catch (err) { /* sem VERSION fora da imagem: segue para o git */ }
  try { const head = clean(git(['rev-parse', 'HEAD'])); if (head) return { commit: head, source: 'git' }; } catch (err) { /* sem git */ }
  return { commit: 'unknown', source: 'unknown' };
}

/** Forma comparável do commit: minúsculas, hexadecimal de 7 a 64 caracteres; qualquer outra coisa ("unknown", vazio) é null. */
function normalizeCommit(value) {
  const text = clean(value).toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(text) ? text : null;
}

/** Mesmo commit: iguais depois de normalizar, ou um é prefixo (SHA abreviado de 7+ caracteres) do outro. Desconhecido nunca confere. */
function sameCommit(a, b) {
  const x = normalizeCommit(a);
  const y = normalizeCommit(b);
  return Boolean(x && y && (x.startsWith(y) || y.startsWith(x)));
}

/**
 * Árvore de trabalho com alteração não commitada (arquivos rastreados) quando o commit vem do git: o SHA não descreve o código que rodou o ensaio. Com GIT_COMMIT ou VERSION (imagem) o
 * código é o do build e a árvore conta como limpa; sem git, não há como saber (false).
 */
function treeDirty({ source } = resolveCommit()) {
  if (source !== 'git') return false;
  try { return clean(git(['status', '--porcelain', '--untracked-files=no', '--', '.'])).length > 0; } catch (err) { return false; }
}

module.exports = { resolveCommit, normalizeCommit, sameCommit, treeDirty, REPO_ROOT };
