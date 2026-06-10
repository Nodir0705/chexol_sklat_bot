const BASE = '';

export async function fetchInventory(userId: number) {
  const res = await fetch(`${BASE}/api/inventory?user_id=${userId}`);
  if (!res.ok) throw new Error('Failed to fetch inventory');
  return res.json();
}

export async function addItem(userId: number, itemName: string, quantity: number, unit: string, category: string) {
  const res = await fetch(`${BASE}/api/inventory/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, item_name: itemName, quantity, unit, category }),
  });
  if (!res.ok) throw new Error('Failed to add item');
  return res.json();
}

export async function updateQuantity(userId: number, itemName: string, change: number) {
  const res = await fetch(`${BASE}/api/inventory/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, item_name: itemName, change }),
  });
  if (!res.ok) throw new Error('Failed to update');
  return res.json();
}

export async function deleteItem(userId: number, itemName: string) {
  const res = await fetch(`${BASE}/api/inventory/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, item_name: itemName }),
  });
  if (!res.ok) throw new Error('Failed to delete');
  return res.json();
}

export async function fetchShopping(userId: number) {
  const res = await fetch(`${BASE}/api/shopping?user_id=${userId}`);
  if (!res.ok) throw new Error('Failed to fetch shopping');
  return res.json();
}

export async function shareShopping(userId: number) {
  const res = await fetch(`${BASE}/api/shopping/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) throw new Error('Failed to share');
  return res.json();
}

export async function fetchItems() {
  const res = await fetch(`${BASE}/api/items`);
  if (!res.ok) throw new Error('Failed to fetch items');
  return res.json();
}

export async function fetchRecipes() {
  const res = await fetch(`${BASE}/api/recipes`);
  if (!res.ok) throw new Error('Failed to fetch recipes');
  return res.json();
}

export async function fetchAvailableRecipes(userId: number) {
  const res = await fetch(`${BASE}/api/recipes/available?user_id=${userId}`);
  if (!res.ok) throw new Error('Failed to fetch available recipes');
  return res.json();
}

export async function cookRecipe(userId: number, recipeId: string, portions: number) {
  const res = await fetch(`${BASE}/api/recipes/cook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, recipe_id: recipeId, portions }),
  });
  if (!res.ok) throw new Error('Failed to cook recipe');
  return res.json();
}
