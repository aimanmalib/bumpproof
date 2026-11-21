import { Link } from 'react-router-dom';
import { gate, t, useData } from '../lib.jsx';

export default function Home() {
  const catalog = useData('catalog');
  const wait = gate(catalog);
  if (wait) return wait;
  return (
    <section>
      <h1>{t('home.title')}</h1>
      <p className="lead">{t('home.lead')}</p>
      <ul className="tiles">
        {catalog.data.categories.map((c) => (
          <li key={c.id}>
            <Link to={`/shop/${c.id}`} className="tile">
              <span className="tile-name">{c.name}</span>
              <span className="tile-blurb">{c.blurb}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
