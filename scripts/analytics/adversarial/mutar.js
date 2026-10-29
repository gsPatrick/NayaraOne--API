'use strict';

/**
 * M9-D704 — aplica UMA mutação do catálogo numa CÓPIA da árvore da API (nunca no código real, onde outros agentes trabalham) e roda o teste
 * adversarial correspondente; a proteção removida precisa derrubá-lo. A cópia não leva o `.env`: o banco vem do ambiente do processo (descartável).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ADVERSARIAIS } = require('../../../test/marco9/_helpers/m9d704Mapa');
const { executarTeste } = require('../../../test/marco9/_helpers/m9d704Executa');

const ROOT = path.join(__dirname, '..', '..', '..');
const COPIAR = ['src', 'test', 'scripts', 'app.js', 'package.json', '.sequelizerc', 'docs'];
const SEM_COPIA = /(^|\/)(node_modules|\.git|evidencias|uploads|backups)(\/|$)/;

function copiarArvore(destino) {
  for (const item of COPIAR) {
    const origem = path.join(ROOT, item);
    if (fs.existsSync(origem)) fs.cpSync(origem, path.join(destino, item), { recursive: true, filter: (f) => !SEM_COPIA.test(path.relative(ROOT, f)) });
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(destino, 'node_modules'), 'dir');
}

/** @returns {{ adv, falhou, output, originalIntacto }} `falhou` = algum teste da dona caiu com a proteção removida. */
function aplicarMutacao(mutacao) {
  const adv = ADVERSARIAIS.find((a) => a.n === mutacao.adv);
  const original = fs.readFileSync(path.join(ROOT, mutacao.arquivo), 'utf8');
  if (original.split(mutacao.de).length - 1 !== 1) throw new Error(`adv${mutacao.adv}: o trecho a mutar não existe uma vez em ${mutacao.arquivo}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `m9d704-mut${mutacao.adv}-`));
  try {
    copiarArvore(dir);
    fs.writeFileSync(path.join(dir, mutacao.arquivo), original.replace(mutacao.de, () => mutacao.para));
    let output = '';
    let falhou = false;
    for (const arquivo of [...new Set(adv.testes.map((t) => t.arquivo))]) {
      const r = executarTeste(adv.testes.find((t) => t.arquivo === arquivo), { raiz: dir });
      output += r.output;
      if (!adv.testes.filter((t) => t.arquivo === arquivo).every((t) => r.aprovou(t.nome))) falhou = true; // algum teste nomeado deixou de passar
    }
    return { adv: mutacao.adv, falhou, output, originalIntacto: fs.readFileSync(path.join(ROOT, mutacao.arquivo), 'utf8') === original };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { aplicarMutacao };
