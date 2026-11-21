import { Link, NavLink, Route, Routes } from 'react-router-dom';
import clsx from 'clsx';
import { useCart } from './cart.jsx';
import { NotFound, t } from './lib.jsx';
import Home from './pages/Home.jsx';
import Category from './pages/Category.jsx';
import Product from './pages/Product.jsx';
import Cart from './pages/Cart.jsx';
import Checkout from './pages/Checkout.jsx';
import Confirm from './pages/Confirm.jsx';
import Account from './pages/Account.jsx';

function navClass({ isActive }) {
  return clsx('nav-link', isActive && 'nav-link-active');
}

export default function App() {
  const { lines } = useCart();
  const count = lines.reduce((n, l) => n + l.qty, 0);
  return (
    <div className="page">
      <header className="top">
        <Link to="/" className="brand">Fern &amp; Fig</Link>
        <nav className="nav" aria-label="Main">
          <NavLink to="/shop" className={navClass}>{t('nav.shop')}</NavLink>
          <NavLink to="/account" className={navClass}>{t('nav.account')}</NavLink>
          <NavLink to="/cart" className={navClass}>{t('nav.cart', { count })}</NavLink>
        </nav>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="shop" element={<Home />} />
          <Route path="shop/:categoryId" element={<Category />} />
          <Route path="shop/:categoryId/:productId" element={<Product />} />
          <Route path="cart" element={<Cart />} />
          <Route path="checkout" element={<Checkout />} />
          <Route path="checkout/done" element={<Confirm />} />
          <Route path="account/*" element={<Account />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}
