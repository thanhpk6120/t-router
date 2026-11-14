/**
 * Sort combos according to a persisted ID/name order list.
 * Combos absent from `order` retain their relative order after ordered ones.
 */
export function sortCombosByOrder(combos, order) {
  if (!Array.isArray(combos) || combos.length === 0) return Array.isArray(combos) ? combos : [];
  if (!Array.isArray(order) || order.length === 0) return combos;

  const indexByKey = new Map();
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    if (typeof key === "string" && key && !indexByKey.has(key)) {
      indexByKey.set(key, i);
    }
  }
  if (indexByKey.size === 0) return combos;

  return combos
    .map((combo, originalIdx) => {
      const rank = indexByKey.has(combo?.id)
        ? indexByKey.get(combo.id)
        : indexByKey.has(combo?.name)
          ? indexByKey.get(combo.name)
          : Number.MAX_SAFE_INTEGER;
      return { combo, rank, originalIdx };
    })
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.originalIdx - b.originalIdx))
    .map((entry) => entry.combo);
}
