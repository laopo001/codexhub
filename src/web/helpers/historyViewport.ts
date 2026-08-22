/**
 * Counts views inserted before the previous viewport content. Bottom appends do
 * not move the first surviving view, so they correctly produce zero.
 */
export const renderedPrependCount = (
  previousViewIds: readonly string[],
  currentViewIds: readonly string[]
): number | null => {
  if (!previousViewIds.length || !currentViewIds.length) return 0;
  const currentIndexById = new Map(currentViewIds.map((id, index) => [id, index]));
  for (let previousIndex = 0; previousIndex < previousViewIds.length; previousIndex += 1) {
    const currentIndex = currentIndexById.get(previousViewIds[previousIndex]);
    if (currentIndex !== undefined) return Math.max(0, currentIndex - previousIndex);
  }
  return null;
};
