'use client';

const ORDER_KEY = 'jaishri.orders.v1';

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

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readOrders(): OrderBookEntry[] {
  if (!canUseStorage()) return [];
  const saved = window.localStorage.getItem(ORDER_KEY);
  if (!saved) return [];
  try {
    const parsed = JSON.parse(saved) as OrderBookEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let orders = readOrders();

function persistOrders() {
  if (canUseStorage()) window.localStorage.setItem(ORDER_KEY, JSON.stringify(orders));
}

export function getOrders(): OrderBookEntry[] {
  orders = readOrders();
  return orders;
}

export function getNextOrderNumber() {
  const year = new Date().getFullYear();
  const next = orders.length + 1;
  return `ORD-${year}-${String(next).padStart(4, '0')}`;
}

export function addOrder(data: Omit<OrderBookEntry, 'id' | 'orderNumber' | 'balanceAmount' | 'createdAt'>): OrderBookEntry {
  const order: OrderBookEntry = {
    ...data,
    id: `order-${Date.now()}`,
    orderNumber: getNextOrderNumber(),
    balanceAmount: Math.max(0, data.estimatedTotal - data.advanceAmount),
    createdAt: new Date().toISOString(),
  };
  orders = [order, ...orders];
  persistOrders();
  return order;
}

export function updateOrder(id: string, updates: Partial<OrderBookEntry>) {
  orders = orders.map((order) => {
    if (order.id !== id) return order;
    const next = { ...order, ...updates };
    return { ...next, balanceAmount: Math.max(0, next.estimatedTotal - next.advanceAmount) };
  });
  persistOrders();
}

export function removeOrder(id: string) {
  orders = orders.filter((order) => order.id !== id);
  persistOrders();
}
