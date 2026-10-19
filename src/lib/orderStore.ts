'use client';

// The hidden Order Book's store (the screen is closed to every role in M1, C15; it is built for real in M2, on the API like the other books). It used to keep its orders in the browser's local
// storage under `jaishri.orders.v1`. No screen of this application keeps business data in browser storage (spec C8, U8; test T-E05), so the orders now live in memory, for the life of the
// page, and the old key is neither read nor written nor wiped. The screen is not drawn for any role, so nothing can put an order here that would outlive a logout; whoever opens the Order
// Book in M2 reads the API's orders instead of this list.

export type OrderStatus = 'Pending' | 'In Progress' | 'Ready' | 'Delivered' | 'Cancelled';

export interface OrderBookEntry {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerMobile: string;
  itemDetails: string;
  category: string;
  material: string;
  purity: string;
  size: string;
  imageUrl: string;
  estimatedTotal: number;
  advanceAmount: number;
  balanceAmount: number;
  approxDeliveryDate: string;
  status: OrderStatus;
  notes: string;
  createdAt: string;
}

let orders: OrderBookEntry[] = [];
/** Two orders made in the same millisecond must not share an id (removing one would remove both). */
let serial = 0;

export function getOrders(): OrderBookEntry[] {
  return orders;
}

export function getNextOrderNumber() {
  const year = new Date().getFullYear();
  const next = orders.length + 1;
  return `ORD-${year}-${String(next).padStart(4, '0')}`;
}

export function addOrder(
  data: Omit<OrderBookEntry, 'id' | 'orderNumber' | 'balanceAmount' | 'createdAt'>
): OrderBookEntry {
  const order: OrderBookEntry = {
    ...data,
    id: `order-${Date.now()}-${(serial += 1)}`,
    orderNumber: getNextOrderNumber(),
    balanceAmount: Math.max(0, data.estimatedTotal - data.advanceAmount),
    createdAt: new Date().toISOString(),
  };
  orders = [order, ...orders];
  return order;
}

export function updateOrder(id: string, updates: Partial<OrderBookEntry>) {
  orders = orders.map((order) => {
    if (order.id !== id) return order;
    const next = { ...order, ...updates };
    return { ...next, balanceAmount: Math.max(0, next.estimatedTotal - next.advanceAmount) };
  });
}

export function removeOrder(id: string) {
  orders = orders.filter((order) => order.id !== id);
}
