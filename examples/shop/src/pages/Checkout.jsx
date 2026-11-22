import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import addDays from 'date-fns/esm/addDays';
import { totals, useCart } from '../cart.jsx';
import { gate, t, useData } from '../lib.jsx';
import Summary from './Summary.jsx';

const FIELDS = [
  { name: 'name', type: 'text', autoComplete: 'name' },
  { name: 'email', type: 'email', autoComplete: 'email' },
  { name: 'address', type: 'text', autoComplete: 'street-address' },
];

export default function Checkout() {
  const { lines, dispatch } = useCart();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', address: '' });
  const [problem, setProblem] = useState(false);
  const shop = useData('shop');
  const catalog = useData('catalog');
  const wait = gate(shop, catalog);
  if (wait) return wait;
  const sum = totals(lines, catalog.data, shop.data);

  function submit(event) {
    event.preventDefault();
    if (FIELDS.some((f) => form[f.name].trim() === '') || sum.rows.length === 0) {
      setProblem(true);
      return;
    }
    const order = {
      number: String(2000 + (Date.now() % 7000)),
      total: sum.total,
      eta: addDays(new Date(), shop.data.deliveryDays).toISOString(),
    };
    dispatch({ type: 'clear' });
    navigate('/checkout/done', { state: order });
  }

  return (
    <section>
      <h1>{t('checkout.title')}</h1>
      <Summary sum={sum} shop={shop.data} />
      <form className="form" onSubmit={submit} noValidate>
        {FIELDS.map((f) => (
          <label key={f.name} className="field">
            <span>{t(`checkout.${f.name}`)}</span>
            <input
              name={f.name}
              type={f.type}
              autoComplete={f.autoComplete}
              value={form[f.name]}
              onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
            />
          </label>
        ))}
        {problem && <p className="note note-error" role="alert">{t('checkout.required')}</p>}
        <button type="submit" className="button">{t('checkout.place')}</button>
      </form>
    </section>
  );
}
