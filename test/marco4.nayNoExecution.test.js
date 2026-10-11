'use strict';

// FIN-TS-014 (Caderno §20: "NAY paga | Tool call direta | Negada") — confirmação explícita,
// nunca tinha teste dedicado. O mesmo argumento contratual já documentado para o Marco 3 (NAY
// Comercial) vale aqui: não existe NENHUMA integração de IA/LLM no projeto (zero menção a
// OpenAI/Anthropic em toda a árvore `src/`, ver personDataQuality.service.js) — a infraestrutura
// real do NAY é entrega do Marco 9 (cláusula 4.10 do contrato). Por isso FIN-TS-014 é verdade
// por AUSÊNCIA: não há nenhum caminho de código por onde "NAY" chamaria `executePaymentIntent`,
// `settleFinancialEntry` ou qualquer outra ação que mova dinheiro — todas exigem
// authMiddleware + requirePermission + (quando move dinheiro de verdade) requireRecentMfa, que
// um agente de IA sem sessão de usuário humano nunca teria. Este teste trava essa garantia como
// regressão: se algum dia alguém adicionar um caminho de execução financeira sem passar pelas
// rotas protegidas normais (ex.: um service "nay*.service.js" chamando settle/execute direto),
// o teste falha.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('FIN-TS-014: não existe nenhum módulo de execução financeira acessível por "NAY" fora das rotas HTTP protegidas', () => {
  const financeDir = path.join(__dirname, '..', 'src', 'features', 'finance');
  const files = fs.readdirSync(financeDir).filter((f) => f.endsWith('.js'));

  // 1. Nenhum arquivo do módulo financeiro menciona NAY, IA ou LLM na superfície de execução.
  for (const file of files) {
    const content = fs.readFileSync(path.join(financeDir, file), 'utf8');
    assert.ok(
      !/\bNAY\b/i.test(content.replace(/\/\/.*$/gm, '')), // ignora comentários (podem citar NAY só como documentação)
      `${file} não deveria referenciar NAY fora de comentário — nenhum agente de IA tem caminho de execução no financeiro.`
    );
  }

  // 2. As duas únicas rotas que efetivamente movimentam dinheiro (liquidar lançamento, executar
  // payment intent) exigem auth + permissão + MFA recente — nenhuma rota pública/sem MFA.
  const routesContent = fs.readFileSync(path.join(financeDir, 'finance.routes.js'), 'utf8');
  const settleLine = routesContent.split('\n').find((l) => l.includes('/finance/entries/:id/settle'));
  const executeLine = routesContent.split('\n').find((l) => l.includes('/finance/payment-intents/:id/execute'));
  assert.ok(settleLine && settleLine.includes('requireRecentMfa'), 'settle de lançamento deve exigir MFA recente.');
  assert.ok(executeLine && executeLine.includes('requireRecentMfa'), 'execução de payment intent deve exigir MFA recente.');

  // 3. Não existe nenhuma integração de IA/LLM real em todo o projeto (mesma confirmação já
  // feita para o Marco 3) — enquanto isso for verdade, NAY Financeira não tem como "tentar"
  // nada, só pode ser lida/consultada manualmente, nunca executar.
  const srcDir = path.join(__dirname, '..', 'src');
  let hasAiIntegration = false;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        if (/openai|anthropic|@anthropic-ai/i.test(content)) hasAiIntegration = true;
      }
    }
  };
  walk(srcDir);
  assert.equal(hasAiIntegration, false, 'não deveria existir integração de IA real no backend ainda (infraestrutura é Marco 9).');
});
