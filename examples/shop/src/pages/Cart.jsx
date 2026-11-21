import { Link } from 'react-router-dom';
import { totals, useCart } from '../cart.jsx';
import { gate, money, t, useData } from '../lib.jsx';
import Summary from './Summary.jsx';

export default function Cart() {
  const { lines, dispatch } = useCart();
  const shop = useData('shop');
  const catalog = useData('catalog');
  const wait = gate(shop, catalog);
  if (wait) return wait;
  const sum = totals(lines, catalog.data, shop.data);
  if (sum.rows.length === 0) {
    return (
      <section>
        <h1>{t('cart.title')}</h1>
        <p className="lead">{t('cart.empty')}</p>
      </section>
    );
  }
  return (
    <section>
      <h1>{t('cart.title')}</h1>
      <ul className="list">
        {sum.rows.map((r) => (
          <li key={r.productId} className="row">
            <span>{r.product.name} × {r.qty}</span>
            <span className="row-end">
              <span className="price">{money(r.product.price * r.qty, shop.data)}</span>
              <button type="button" className="link-button" onClick={() => dispatch({ type: 'remove', productId: r.productId })}>
                {t('cart.remove')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      <Summary sum={sum} shop={shop.data} />
      <Link to="/checkout" className="button">{t('cart.checkout')}</Link>
    </section>
  );
}
