import { Navigate, useLocation } from 'react-router-dom';
import { day, gate, money, t, useData } from '../lib.jsx';

export default function Confirm() {
  const { state: order } = useLocation();
  const shop = useData('shop');
  const wait = gate(shop);
  if (!order) return <Navigate to="/cart" replace />;
  if (wait) return wait;
  return (
    <section>
      <h1>{t('confirm.title')}</h1>
      <dl className="summary">
        <dt>{t('confirm.number')}</dt>
        <dd>{order.number}</dd>
        <dt>{t('confirm.total')}</dt>
        <dd data-testid="order-total">{money(order.total, shop.data)}</dd>
        <dt>{t('confirm.eta')}</dt>
        <dd>{day(order.eta, shop.data)}</dd>
      </dl>
    </section>
  );
}
