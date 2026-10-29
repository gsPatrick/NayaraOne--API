'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Relatório no formato de `npm audit --json` (v2) com os avisos informados: { pkg, severity, ghsa, title }. */
function auditReport(avisos) {
  const vulnerabilities = {};
  avisos.forEach((a, i) => {
    vulnerabilities[a.pkg] = {
      name: a.pkg, severity: a.severity, isDirect: true, effects: [], range: '<9.9.9', nodes: [`node_modules/${a.pkg}`], fixAvailable: true,
      via: [{ source: 1000 + i, name: a.pkg, dependency: a.pkg, title: a.title || 'Aviso de teste', url: `https://github.com/advisories/${a.ghsa}`, severity: a.severity, cwe: [], cvss: { score: 7.5 }, range: '<9.9.9' }],
    };
  });
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { total: avisos.length } } };
}

/** Exceção válida por padrão; `over` troca campos. Datas em AAAA-MM-DD. */
const excecao = (over = {}) => ({
  id: 'GHSA-aaaa-bbbb-cccc', package: 'xml2js', reason: 'Só lê XML de fornecedor homologado.', mitigation: 'Entrada limitada a 1 MiB e sem entidades externas.',
  owner: 'Responsável de segurança (QA-M9)', grantedAt: '2026-10-20', expiresAt: '2026-11-19', ...over,
});

function tmpJson(nome, obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9-depaudit-'));
  const file = path.join(dir, nome);
  fs.writeFileSync(file, JSON.stringify(obj));
  return { file, limpar: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { auditReport, excecao, tmpJson };
