'use strict';

// Apoio dos testes HTTP de Pessoas do fechamento do Marco 3 (não é teste): sobe a API real com os perfis de CI e, quando
// M3PE_EVIDENCIA_DIR está no ambiente, grava cada chamada (método, rota, status, código e um resumo do corpo, SEM token, senha ou cabeçalho)
// em <dir>/<arquivo>.json, para a evidência da matriz. Só roda em banco descartável (o startHttp recusa o resto).
const fs = require('node:fs');
const path = require('node:path');
const { startHttp, stopHttp } = require('../marco9/_helpers/m9d806Http');
const { adminQuery } = require('../m9d801.helpers');

const RESUMO = 1200;
const resumo = (body) => { const txt = JSON.stringify(body); return txt && txt.length > RESUMO ? `${txt.slice(0, RESUMO)}…` : body; };

async function iniciar({ port, logins, arquivo }) {
  const http = await startHttp({ port, grants: {}, logins });
  const registro = [];
  if (http.skip) return { http, registro, gravar: () => {} };
  const original = http.call;
  http.call = async (quem, method, rota, body, headers) => {
    const res = await original(quem, method, rota, body, headers);
    registro.push({ em: new Date().toISOString(), perfil: quem, requisicao: `${method} /api/v1${rota}`, corpoEnviado: body || null, status: res.status,
      codigo: res.body && res.body.error ? res.body.error.code : null, resposta: resumo(res.body) });
    return res;
  };
  const gravar = (extra = {}) => {
    const dir = process.env.M3PE_EVIDENCIA_DIR;
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${arquivo}.json`), `${JSON.stringify({ geradoEm: new Date().toISOString(), arquivoDeTeste: `test/${arquivo}.test.js`, ...extra, chamadas: registro }, null, 2)}\n`);
  };
  return { http, registro, gravar };
}

/** Concede (ou retira) uma permissão ao papel de CI nas duas empresas do seed. */
async function permissao(roleName, code, conceder) {
  await adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = $2', [roleName, code]);
  if (conceder) {
    await adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
      SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = $2`, [roleName, code]);
  }
}

module.exports = { iniciar, permissao, stopHttp, adminQuery };
