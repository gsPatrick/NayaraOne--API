'use strict';

const { execFile } = require('node:child_process');
const { API_ROOT } = require('./depaudit.constants');

/**
 * Roda `npm audit --omit=dev --json` na raiz da API. npm sai com código 1 quando ACHA vulnerabilidade: isso não é falha da
 * execução, o que importa é o JSON. Saída que não é JSON é erro (nunca "sem vulnerabilidades" por engano).
 */
function runNpmAudit({ cwd = API_ROOT, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('npm', ['audit', '--omit=dev', '--json'], { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      try {
        const report = JSON.parse(stdout);
        if (report?.error) throw new Error(report.error.summary || report.error.code || 'npm audit falhou');
        resolve(report);
      } catch (err) {
        reject(new Error(`npm audit sem resultado utilizável: ${err.message}${stderr ? ` (${String(stderr).slice(0, 200)})` : ''}`));
      }
    });
  });
}

module.exports = { runNpmAudit };
