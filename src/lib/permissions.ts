export type AppRole = 'Owner/Admin' | 'Manager' | 'Sales Staff' | 'Inventory Staff';

const role: AppRole = 'Owner/Admin';

export function getCurrentRole(): AppRole {
  return role;
}

export function canViewOriginalNetWeight(): boolean {
  return role === 'Owner/Admin' || role === 'Manager';
}

export function customerSafeSku<T extends { originalNetWeight?: number }>(sku: T): Omit<T, 'originalNetWeight'> {
  const { originalNetWeight: _privateOriginalNetWeight, ...safeSku } = sku;
  return safeSku;
}

