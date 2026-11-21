import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useCart } from '../cart.jsx';
import { NotFound, gate, money, t, useData } from '../lib.jsx';

export default function Product() {
  const { categoryId, productId } = useParams();
  const { dispatch } = useCart();
  const [added, setAdded] = useState(false);
  const shop = useData('shop');
  const catalog = useData('catalog');
  const wait = gate(shop, catalog);
  if (wait) return wait;
  const product = catalog.data.products.find((p) => p.id === productId && p.category === categoryId);
  if (!product) return <NotFound />;
  const category = catalog.data.categories.find((c) => c.id === categoryId);
  function add() {
    dispatch({ type: 'add', productId: product.id });
    setAdded(true);
  }
  return (
    <section>
      <Link to={`/shop/${categoryId}`} className="back">{category.name}</Link>
      <h1>{product.name}</h1>
      <p className="lead">{product.note}</p>
      <p className="price price-big">{money(product.price, shop.data)}</p>
      <button type="button" className="button" onClick={add}>{t('product.add')}</button>
      {added && <p className="note" role="status">{t('product.added')}</p>}
    </section>
  );
}
