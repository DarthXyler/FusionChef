export function toTitleCase(text: string) {
  return text.replace(/\b([a-z])([a-z']*)/gi, (_, first: string, rest: string) => {
    return `${first.toUpperCase()}${rest.toLowerCase()}`;
  });
}

export function buildShoppingItemKey(
  item: { item: string; quantity: string; category: string },
  index: number,
) {
  return `${index}:${item.item}|${item.quantity}|${item.category}`;
}
