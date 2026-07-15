export const findKey = (value: unknown, key: string, trail = "$"): string | null => {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findKey(value[index], key, `${trail}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const entryTrail = `${trail}.${entryKey}`;
    if (entryKey === key) return entryTrail;
    const found = findKey(entryValue, key, entryTrail);
    if (found) return found;
  }
  return null;
};

export const assertNoWorkerId = (value: unknown, label: string) => {
  const path = findKey(value, "workerId");
  if (path) throw new Error(`${label} exposed workerId at ${path}`);
};
