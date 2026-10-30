'use strict';

/**
 * Mutation check do Marketing (M9-D436/M9-D440): cópia descartável da API com UMA violação injetada. A cópia nunca leva o .env (o banco vem do ambiente do banco descartável);
 * node_modules é link simbólico. Só texto exato: `de` precisa aparecer UMA vez no arquivo, senão a mutação é recusada (a mutação não pode "passar" por não ter aplicado).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..', '..', '..');
const COPIAR = ['src', 'test', 'scripts', 'docs', 'openapi', 'security', 'app.js', 'package.json', 'eslint.config.js'];

function criarCopia() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-mutacao-'));
  for (const nome of COPIAR) fs.cpSync(path.join(RAIZ, nome), path.join(dir, nome), { recursive: true });
  fs.symlinkSync(path.join(RAIZ, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Aplica as edições { arquivo, de, para } (arquivo relativo à raiz da API) na cópia; `{ arquivo, criar }` cria um arquivo novo com esse texto. Devolve a lista de arquivos mexidos. */
function aplicar(dir, edicoes) {
  return edicoes.map((e) => {
    const alvo = path.join(dir, e.arquivo);
    if (e.criar !== undefined) {
      fs.mkdirSync(path.dirname(alvo), { recursive: true });
      fs.writeFileSync(alvo, e.criar);
      return e.arquivo;
    }
    const texto = fs.readFileSync(alvo, 'utf8');
    const vezes = texto.split(e.de).length - 1;
    if (vezes !== 1) throw new Error(`mutação inválida em ${e.arquivo}: o trecho aparece ${vezes} vezes (esperado 1): ${e.de.slice(0, 80)}`);
    fs.writeFileSync(alvo, texto.replace(e.de, () => e.para));
    return e.arquivo;
  });
}

const remover = (dir) => fs.rmSync(dir, { recursive: true, force: true });

module.exports = { RAIZ, criarCopia, aplicar, remover };
