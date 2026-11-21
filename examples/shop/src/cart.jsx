import { createContext, useContext, useEffect, useMemo, useReducer } from 'react';

const KEY = 'fern-fig-cart';
const CartContext = createContext(null);

function reducer(lines, action) {
  switch (action.type) {
    case 'add': {
      const found = lines.find((l) => l.productId === action.productId);
      if (found) return lines.map((l) => (l === found ? { ...l, qty: l.qty + 1 } : l));
      return [...lines, { productId: action.productId, qty: 1 }];
    }
    case 'remove':
      return lines.filter((l) => l.productId !== action.productId);
    case 'clear':
      return [];
    default:
      return lines;
  }
}

function initial() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }) {
  const [lines, dispatch] = useReducer(reducer, undefined, initial);
  useEffect(() => localStorage.setItem(KEY, JSON.stringify(lines)), [lines]);
  const value = useMemo(() => ({ lines, dispatch }), [lines]);
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  return useContext(CartContext);
}

// Prices always come from the catalog, never from the cart, so totals cannot drift.
export function totals(lines, catalog, shop) {
  const rows = lines
    .map((l) => ({ ...l, product: catalog.products.find((p) => p.id === l.productId) }))
    .filter((r) => r.product);
  const subtotal = rows.reduce((sum, r) => sum + r.product.price * r.qty, 0);
  const shipping = rows.length === 0 || subtotal >= shop.freeShippingFrom ? 0 : shop.shippingFee;
  return { rows, subtotal, shipping, total: subtotal + shipping };
}
