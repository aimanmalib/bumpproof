import { money, t } from '../lib.jsx';

export default function Summary({ sum, shop }) {
  return (
    <dl className="summary">
      <dt>{t('cart.subtotal')}</dt>
      <dd>{money(sum.subtotal, shop)}</dd>
      <dt>{t('cart.shipping')}</dt>
      <dd>{sum.shipping === 0 ? t('cart.free') : money(sum.shipping, shop)}</dd>
      <dt className="summary-total">{t('cart.total')}</dt>
      <dd className="summary-total" data-testid="cart-total">{money(sum.total, shop)}</dd>
    </dl>
  );
}
