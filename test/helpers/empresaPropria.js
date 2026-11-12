'use strict';

// Empresa NOVA, só do teste, num grupo já existente (banco descartável, superusuário): o teste de isolamento confere "a outra empresa não vê nada" numa empresa em que
// nenhum outro arquivo grava, em vez de depender de a empresa B do seed estar vazia. `remover()` apaga a empresa no fim (ela não recebe dado commitado do teste).
const crypto = require('node:crypto');
const { Sequelize } = require('sequelize');

async function empresaPropria({ groupId }, rotulo = 'isolamento') {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url || new URL(url).hostname !== '127.0.0.1') throw new Error('empresaPropria: só no banco descartável (DATABASE_ADMIN_URL em 127.0.0.1).');
  const admin = new Sequelize(url, { logging: false, dialect: 'postgres' });
  const companyId = crypto.randomUUID();
  await admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id: companyId, g: groupId, n: `QA ${rotulo} ${companyId.slice(0, 8)}` } });
  return {
    groupId, companyId,
    async remover() {
      await admin.query('DELETE FROM core.companies WHERE id = :id', { replacements: { id: companyId } });
      await admin.close();
    },
  };
}

module.exports = { empresaPropria };
