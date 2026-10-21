import BillingService from '../services/billing';
import { Money } from '@/utils/money';

export default function registerRoutes(app: { post: (p: string, h: () => unknown) => void }) {
  const svc = new BillingService();
  app.post('/charge', () => svc.charge(new Money(5, 'USD')));
}
