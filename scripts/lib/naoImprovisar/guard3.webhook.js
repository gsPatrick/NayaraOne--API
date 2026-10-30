'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { API_ROOT, violation, listJs, codeLines, norm } = require('./common');

const ROTA = /\b(?:router|Router|\w+Router)\s*\.\s*(?:post|put|patch|get|all)\s*\(\s*(['"`])([^'"`]*webhook[^'"`]*)\1/i;
// Passa por verificação de assinatura (preflight e corpo bruto do framework, ou o alias legado sobre o framework) ou exige login com permissão (rota interna do sistema, não é a pública do fornecedor).
const AUTENTICADA = /webhookPreflight|rawBodyMiddleware|legacyAlias\s*\(|integrationWebhooks\.|requirePermission\s*\(|authMiddleware/;

/** O trecho da declaração da rota: da linha em que começa até o ponto e vírgula (no máximo 6 linhas). */
function declaracao(linhas, inicio) {
  const partes = [];
  for (let i = inicio; i < Math.min(linhas.length, inicio + 6); i += 1) {
    partes.push(linhas[i]);
    if (/;\s*$/.test(linhas[i])) break;
  }
  return partes.join(' ');
}

/** Regra 3: "Não confiar em webhook sem autenticação". Toda rota de webhook (caminho com `webhook`) passa pelo framework que verifica a assinatura (ou exige login) e o tratador único chama o verificador; rota nova sem isso reprova. */
function scan({ root = API_ROOT } = {}) {
  const achados = [];
  for (const rel of listJs(root, 'src')) {
    const linhas = codeLines(root, rel);
    linhas.forEach((linha, i) => {
      const m = ROTA.exec(linha);
      if (m && !AUTENTICADA.test(declaracao(linhas, i))) achados.push(violation(3, rel, i + 1, `Rota de webhook "${m[2]}" sem verificação de assinatura: use o framework de webhooks (webhookPreflight ou integrationWebhooks.legacyAlias).`, linha));
    });
  }
  const handler = path.join(root, 'src/features/integrations/webhooks/webhooks.handler.js');
  if (fs.existsSync(handler) && !/verif/i.test(fs.readFileSync(handler, 'utf8'))) {
    achados.push(violation(3, norm(path.relative(root, handler)), 1, 'O tratador único de webhooks não chama o verificador de assinatura.'));
  }
  return achados;
}

module.exports = { rule: 3, name: 'webhook_sem_autenticacao', scan };
