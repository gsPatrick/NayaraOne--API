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

function walk(stack, prefix, out) {
  for (const layer of stack) {
    if (layer.route) {
      const handlers = layer.route.stack.map((l) => l.handle);
      const permissions = [...new Set(handlers.map((h) => h.requiredPermission).filter(Boolean))];
      const mfa = handlers.some((h) => h.name === 'requireRecentMfa');
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path, permissions, mfaRecente: mfa });
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix + prefixFrom(layer), out);
    }
  }
}

function gerar() {
  const router = require('../src/routes');
  const out = [];
  walk(router.stack, '/api', out);
  return out.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}

module.exports = { gerar };

if (require.main === module) {
  const rotas = gerar();
  if (process.argv.includes('--md')) {
    const publicas = rotas.filter((r) => r.permissions.length === 0);
    const protegidas = rotas.filter((r) => r.permissions.length > 0);
    const categoria = (r) => {
      if (/\/webhooks\//.test(r.path)) return 'público; autenticidade pela assinatura do provider';
      if (/\/carts\/public\//.test(r.path)) return 'público; acesso pelo token do link';
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
