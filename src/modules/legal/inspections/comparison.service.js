'use strict';

const { InspectionMedia } = require('../../../models');
const { pairKey } = require('./inspectionItemCodes');

/**
 * Fechamento M5 (Guia §10 "Comparação entrada x saída"): para cada item pareado, o resultado traz
 * `before` (condição na entrada), `after` (condição na saída), `changed` e `mediaRefs` (fotos/vídeos
 * dos dois lados) — a NAY/tela só resume; responsabilidade e cobrança continuam com validação humana
 * (`requiresHumanValidation`). O pareamento é por ambiente + código do item (roomCode/itemCode, Guia §10).
 */
async function mediaByItem(itemIds, transaction) {
  const map = new Map();
  if (itemIds.length === 0) return map;
  const medias = await InspectionMedia.findAll({ where: { itemId: itemIds }, order: [['captured_at', 'ASC']], transaction });
  for (const m of medias) {
    const list = map.get(m.itemId) || [];
    list.push(m.fileId);
    map.set(m.itemId, list);
  }
  return map;
}

async function buildComparedItems(entryItems, exitItems, transaction) {
  const media = await mediaByItem([...entryItems, ...exitItems].map((i) => i.id), transaction);
  const entryByKey = new Map(entryItems.map((i) => [pairKey(i), i]));
  const exitByKey = new Map(exitItems.map((i) => [pairKey(i), i]));
  const keys = [...new Set([...entryByKey.keys(), ...exitByKey.keys()])];
  return keys.map((key) => {
    const entry = entryByKey.get(key) || null;
    const exit = exitByKey.get(key) || null;
    const ref = entry || exit;
    const before = entry ? entry.condition : null;
    const after = exit ? exit.condition : null;
    return {
      roomCode: ref.roomCode || null,
      itemCode: ref.itemCode || null,
      itemName: ref.itemName,
      entryItemId: entry ? entry.id : null,
      exitItemId: exit ? exit.id : null,
      before,
      after,
      changed: !entry || !exit || before !== after,
      mediaRefs: [...(entry ? media.get(entry.id) || [] : []), ...(exit ? media.get(exit.id) || [] : [])],
      requiresHumanValidation: true,
    };
  });
}

module.exports = { buildComparedItems };
