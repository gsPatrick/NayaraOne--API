'use strict';

// Guarda estática da classe de defeito "createdAt/updatedAt de model renomeado": quase todos os models declaram
// `createdAt: 'created_at'` / `updatedAt: 'updated_at'` nas OPÇÕES, o que RENOMEIA o atributo do Sequelize. Usar `updatedAt`/`createdAt`
// como chave de where/order nesses models gera "column X.updatedAt does not exist" (só aparece em execução real, não na suíte).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('nenhum where/order usa createdAt/updatedAt como chave de atributo fora dos models', () => {
  const padroes = [
    /\bwhere\.(createdAt|updatedAt)\b/,
    /(?<![\w.])(createdAt|updatedAt)\s*:\s*\{\s*\[Op\./,
    /\border\s*:\s*\[\s*\[\s*['"](createdAt|updatedAt)['"]/,
  ];
  const achados = [];
  for (const file of walk(SRC)) {
    if (file.startsWith(path.join(SRC, 'models'))) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((linha, i) => {
      if (padroes.some((re) => re.test(linha))) achados.push(`${path.relative(SRC, file)}:${i + 1}: ${linha.trim()}`);
    });
  }
  assert.deepEqual(achados, [], `use created_at/updated_at (nome do atributo renomeado):\n${achados.join('\n')}`);
});
