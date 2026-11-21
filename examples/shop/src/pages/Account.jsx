import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { NotFound, day, gate, money, t, useData } from '../lib.jsx';

function tabClass({ isActive }) {
  return clsx('tab', isActive && 'tab-active');
}

// Mounted at "account/*". The tab links are relative to this splat route.
export default function Account() {
  return (
    <section>
      <h1>{t('account.title')}</h1>
      <nav className="tabs" aria-label={t('account.title')}>
        <NavLink to="." end className={tabClass}>{t('account.overview')}</NavLink>
        <NavLink to="orders" className={tabClass}>{t('account.orders')}</NavLink>
      </nav>
      <Routes>
        <Route index element={<p className="lead">{t('account.welcome')}</p>} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:orderId" element={<Order />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </section>
  );
}

function orderTotal(order, catalog) {
  return order.lines.reduce((sum, l) => {
    const p = catalog.products.find((x) => x.id === l.productId);
    return sum + (p ? p.price * l.qty : 0);
  }, 0);
}

function Orders() {
  const shop = useData('shop');
  const catalog = useData('catalog');
  const orders = useData('orders');
  const wait = gate(shop, catalog, orders);
  if (wait) return wait;
  return (
    <>
      <h2>{t('orders.title')}</h2>
      <ul className="list">
        {orders.data.orders.map((o) => (
          <li key={o.id}>
            <Link to={o.id} className="row">
              <span>#{o.id} · {t('orders.placed')} {day(o.placedAt, shop.data)}</span>
              <span className="price">{money(orderTotal(o, catalog.data), shop.data)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function Order() {
  const { orderId } = useParams();
  const shop = useData('shop');
  const catalog = useData('catalog');
  const orders = useData('orders');
  const wait = gate(shop, catalog, orders);
  if (wait) return wait;
  const order = orders.data.orders.find((o) => o.id === orderId);
  if (!order) return <NotFound />;
  return (
    <>
      <h2>{t('order.title', { id: order.id })}</h2>
      <p className="lead">{order.status} · {day(order.placedAt, shop.data)}</p>
      <ul className="list">
        {order.lines.map((l) => {
          const p = catalog.data.products.find((x) => x.id === l.productId);
          return (
            <li key={l.productId} className="row">
              <span>{p ? p.name : l.productId} × {l.qty}</span>
              <span className="price">{p ? money(p.price * l.qty, shop.data) : ''}</span>
            </li>
          );
        })}
      </ul>
      <p className="price price-big">{money(orderTotal(order, catalog.data), shop.data)}</p>
      <Link to=".." className="back">{t('order.back')}</Link>
    </>
  );
}
