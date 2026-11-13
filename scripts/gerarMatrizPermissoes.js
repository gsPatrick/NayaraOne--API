#!/usr/bin/env node
'use strict';
/**
 * Gera a matriz de rotas da API lida do código real: método, caminho, permissão exigida e se exige MFA recente.
 *   node scripts/gerarMatrizPermissoes.js            -> imprime JSON
 *   node scripts/gerarMatrizPermissoes.js --md       -> grava docs/API_PERMISSOES.md
 */
process.env.PORT = process.env.PORT || '0';
const fs = require('fs');
const path = require('path');

function prefixFrom(layer) {
  const src = layer.regexp && layer.regexp.source;
  if (!src || src === '^\\/?(?=\\/|$)' || src === '^\\/?$') return '';
  const m = src.match(/^\^((?:\\\/[^\\/?()]+)+)\\\/\?\(\?=\\\/\|\$\)$/);
  return m ? m[1].replace(/\\\//g, '/') : '';
}

/** Visita cada rota (método × caminho completo) com a lista de funções da cadeia, na ordem do Express. */
function percorrerRotas(stack, prefix, visitar) {
  for (const layer of stack) {
    if (layer.route) {
      const handlers = layer.route.stack.map((l) => l.handle);
      for (const method of Object.keys(layer.route.methods)) visitar(method.toUpperCase(), prefix + layer.route.path, handlers);
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      percorrerRotas(layer.handle.stack, prefix + prefixFrom(layer), visitar);
    }
  }
}

function gerar() {
  const router = require('../src/routes');
  const out = [];
  percorrerRotas(router.stack, '/api', (method, rota, handlers) => {
    const permissions = [...new Set(handlers.map((h) => h.requiredPermission).filter(Boolean))];
    const mfa = handlers.some((h) => h.name === 'requireRecentMfa');
    const scope = handlers.map((h) => h.requiredScope).find(Boolean) || null; // rota da API externa (M9-D844): scope exigido do token de cliente
    out.push({ method, path: rota, permissions, mfaRecente: mfa, ...(scope ? { scope } : {}) });
  });
  return out.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}

/**
 * Catálogo das permissões de governança (M9-D800: 21 códigos governance:*) com as rotas que já usam cada uma. Permissões ainda sem
 * rota (as demandas do bloco as ligam depois) continuam listadas: o catálogo é fechado e vem do código, não de digitação.
 */
function gerarCatalogoGovernanca(rotas) {
  const { GOVERNANCE_PERMISSIONS } = require('../src/features/core-governance/governance.permissions');
  return GOVERNANCE_PERMISSIONS.map((p) => ({
    code: p.code,
    risk: p.risk,
    rotas: rotas.filter((r) => r.permissions.includes(p.code)).map((r) => `${r.method} ${r.path}`),
  }));
}

module.exports = { gerar, gerarCatalogoGovernanca, percorrerRotas };

if (require.main === module) {
  const rotas = gerar();
  if (process.argv.includes('--md')) {
    const publicas = rotas.filter((r) => r.permissions.length === 0);
    const protegidas = rotas.filter((r) => r.permissions.length > 0);
    const categoria = (r) => {
      if (r.scope) return `token de cliente com o scope \`${r.scope}\``;
      if (/\/api-external\/oauth\/token$/.test(r.path)) return 'público (troca client id e segredo por token de cliente)';
      if (/\/webhooks\//.test(r.path)) return 'público; autenticidade pela assinatura do provider';
      if (/\/carts\/public\//.test(r.path)) return 'público; acesso pelo token do link';
      if (/\/public\/properties\//.test(r.path)) return 'público; página do imóvel no site (M9-D427), só dado publicável';
      if (/\/marketing\/unsubscribe$/.test(r.path)) return 'público; autenticidade pelo token assinado do link de descadastro';
      if (/\/(health|ping|version)(\/|$)/.test(r.path)) return 'público (saúde do serviço)';
      if (/\/auth\/(login|refresh)$/.test(r.path)) return 'público (obtém ou renova o token)';
      if (/\/users\/me\/mfa\//.test(r.path)) return 'só login (o próprio usuário)';
      if (/^\/api\/v1\/files/.test(r.path)) return 'só login; o acesso ao arquivo é decidido pelo dono e pela permissão do módulo';
      return 'só login';
    };
    const linha = (r) => `| \`${r.method}\` | \`${r.path}\` | ${r.permissions.length ? r.permissions.map((p) => `\`${p}\``).join(', ') : categoria(r)} | ${r.mfaRecente ? 'sim' : 'não'} |`;
    const md = [
      '# Matriz de permissões da API',
      '',
      'Gerada do código por `node scripts/gerarMatrizPermissoes.js --md`. Não editar à mão.',
      '',
      `Rotas com permissão exigida: ${protegidas.length}. Rotas só com login ou públicas: ${publicas.length}.`,
      '',
      'Regras gerais: sem token a resposta é 401; com token sem a permissão indicada a resposta é 403 (código `PERMISSION_DENIED`, campo `required`).',
      '',
      '## Rotas protegidas por permissão',
      '',
      '| Método | Caminho | Permissão exigida | MFA recente |',
      '|---|---|---|---|',
      ...protegidas.map(linha),
      '',
      '## Catálogo de permissões de governança (governance:*)',
      '',
      'Catálogo fechado do Marco 9 (M9-D800). Permissão sem rota nesta tabela ainda não foi ligada por uma demanda do bloco.',
      '',
      '| Permissão | Risco | Rotas que a exigem |',
      '|---|---|---|',
      ...gerarCatalogoGovernanca(rotas).map((c) => `| \`${c.code}\` | ${c.risk} | ${c.rotas.length ? c.rotas.map((x) => `\`${x}\``).join(', ') : 'nenhuma ainda'} |`),
      '',
      '## Rotas só com login ou públicas',
      '',
      '| Método | Caminho | Permissão exigida | MFA recente |',
      '|---|---|---|---|',
      ...publicas.map(linha),
      '',
    ].join('\n');
    fs.mkdirSync(path.join(__dirname, '..', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'API_PERMISSOES.md'), md);
    console.log(`docs/API_PERMISSOES.md: ${protegidas.length} protegidas, ${publicas.length} sem permissão específica`);
  } else {
    console.log(JSON.stringify(rotas, null, 2));
  }
  process.exit(0);
}
