import { Link, useParams } from 'react-router-dom';
import { NotFound, gate, money, t, useData } from '../lib.jsx';

export default function Category() {
  const { categoryId } = useParams();
  const shop = useData('shop');
  const catalog = useData('catalog');
  const wait = gate(shop, catalog);
  if (wait) return wait;
  const category = catalog.data.categories.find((c) => c.id === categoryId);
  if (!category) return <NotFound />;
  const products = catalog.data.products.filter((p) => p.category === categoryId);
  return (
    <section>
      <Link to="/shop" className="back">{t('category.back')}</Link>
      <h1>{category.name}</h1>
      <p className="lead">{category.blurb}</p>
      <ul className="list">
        {products.map((p) => (
          <li key={p.id}>
            <Link to={p.id} className="row">
              <span>{p.name}</span>
              <span className="price">{money(p.price, shop.data)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
