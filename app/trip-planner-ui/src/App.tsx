import { Button } from '@ui5/webcomponents-react/Button';
import { DatePicker } from '@ui5/webcomponents-react/DatePicker';
import { Input } from '@ui5/webcomponents-react/Input';
import { Label } from '@ui5/webcomponents-react/Label';
import { MessageStrip } from '@ui5/webcomponents-react/MessageStrip';
import { Title } from '@ui5/webcomponents-react/Title';
import { useState, type FormEvent } from 'react';
import {
  confirmConstraints,
  createTripRequest,
  type Pace,
  type TripRequest,
  type TripRequestDraft,
} from './api.js';

const initialDraft: TripRequestDraft = {
  originCity: '',
  startDate: '',
  endDate: '',
  adults: 2,
  totalBudget: 3000,
  currency: 'PLN',
  pace: 'BALANCED',
};

const paceLabels: Record<Pace, string> = {
  RELAXED: 'Spokojne',
  BALANCED: 'Zrównoważone',
  INTENSIVE: 'Intensywne',
};

export default function App() {
  const [draft, setDraft] = useState(initialDraft);
  const [saved, setSaved] = useState<TripRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof TripRequestDraft>(key: K, value: TripRequestDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const saveBrief = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      setSaved(await createTripRequest(draft));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nie udało się zapisać briefu.');
    } finally {
      setLoading(false);
    }
  };

  const confirmBrief = async () => {
    if (!saved) return;
    setLoading(true);
    setError(null);
    try {
      setSaved(await confirmConstraints(saved.ID));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nie udało się potwierdzić ograniczeń.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="page-shell">
      <header className="hero">
        <p className="eyebrow">AI TRIP PLANNER · PROJECT FOUNDATION</p>
        <Title level="H1">Zacznijmy od realnych ograniczeń</Title>
        <p className="hero-copy">
          Zapisz krótki brief. Budżet i wykonalność będą zawsze sprawdzane przez kod, zanim przyszła
          warstwa AI zaproponuje warianty.
        </p>
      </header>

      <section className="content-card" aria-labelledby="brief-title">
        <Title id="brief-title" level="H2">
          Brief podróży
        </Title>

        {error && (
          <MessageStrip className="message" hideCloseButton data-testid="backend-error">
            {error}
          </MessageStrip>
        )}

        {!saved ? (
          <form className="brief-form" onSubmit={saveBrief} aria-busy={loading}>
            <div className="field field-wide">
              <Label for="origin-city" required>
                Miasto rozpoczęcia
              </Label>
              <Input
                id="origin-city"
                data-testid="origin-city"
                value={draft.originCity}
                onInput={(event) => update('originCity', event.target.value)}
                required
                accessibleName="Miasto rozpoczęcia"
                placeholder="np. Warszawa"
              />
            </div>

            <div className="field">
              <Label for="start-date" required>
                Data rozpoczęcia
              </Label>
              <DatePicker
                id="start-date"
                data-testid="start-date"
                value={draft.startDate}
                valueFormat="yyyy-MM-dd"
                displayFormat="yyyy-MM-dd"
                onChange={(event) => update('startDate', event.target.value)}
                required
                accessibleName="Data rozpoczęcia"
              />
            </div>

            <div className="field">
              <Label for="end-date" required>
                Data zakończenia
              </Label>
              <DatePicker
                id="end-date"
                data-testid="end-date"
                value={draft.endDate}
                valueFormat="yyyy-MM-dd"
                displayFormat="yyyy-MM-dd"
                onChange={(event) => update('endDate', event.target.value)}
                required
                accessibleName="Data zakończenia"
              />
            </div>

            <div className="field">
              <label htmlFor="adults">Liczba dorosłych</label>
              <input
                id="adults"
                data-testid="adults"
                type="number"
                min="1"
                step="1"
                required
                value={draft.adults}
                onChange={(event) => update('adults', Number(event.target.value))}
              />
            </div>

            <div className="field">
              <label htmlFor="total-budget">Całkowity budżet</label>
              <input
                id="total-budget"
                data-testid="total-budget"
                type="number"
                min="0.01"
                step="0.01"
                required
                value={draft.totalBudget}
                onChange={(event) => update('totalBudget', Number(event.target.value))}
              />
            </div>

            <div className="field">
              <Label for="currency" required>
                Waluta
              </Label>
              <Input
                id="currency"
                data-testid="currency"
                value={draft.currency}
                maxlength={3}
                onInput={(event) => update('currency', event.target.value.toUpperCase())}
                required
                accessibleName="Waluta"
              />
            </div>

            <div className="field">
              <label htmlFor="pace">Tempo podróży</label>
              <select
                id="pace"
                data-testid="pace"
                value={draft.pace}
                onChange={(event) => update('pace', event.target.value as Pace)}
              >
                {Object.entries(paceLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div className="actions field-wide">
              <Button
                type="Submit"
                disabled={loading}
                data-testid="save-brief"
                accessibleName="Zapisz brief"
              >
                {loading ? 'Zapisywanie…' : 'Zapisz brief'}
              </Button>
            </div>
          </form>
        ) : (
          <article className="summary" data-testid="brief-summary" aria-live="polite">
            <div className="summary-heading">
              <div>
                <p className="eyebrow">ZAPISANY BRIEF</p>
                <Title level="H3">{saved.originCity}</Title>
              </div>
              <span className={`status status-${saved.status.toLowerCase()}`} data-testid="status">
                {saved.status}
              </span>
            </div>

            <dl className="summary-grid">
              <div>
                <dt>Termin</dt>
                <dd>
                  {saved.startDate} – {saved.endDate}
                </dd>
              </div>
              <div>
                <dt>Podróżni</dt>
                <dd>{saved.adults} dorosłych</dd>
              </div>
              <div>
                <dt>Budżet</dt>
                <dd>
                  {saved.totalBudget} {saved.currency}
                </dd>
              </div>
              <div>
                <dt>Tempo</dt>
                <dd>{paceLabels[saved.pace]}</dd>
              </div>
            </dl>

            {saved.status === 'DRAFT' ? (
              <Button
                onClick={confirmBrief}
                disabled={loading}
                data-testid="confirm-constraints"
                accessibleName="Potwierdź ograniczenia"
              >
                {loading ? 'Potwierdzanie…' : 'Potwierdź ograniczenia'}
              </Button>
            ) : (
              <MessageStrip className="message" hideCloseButton data-testid="next-stage-message">
                Ograniczenia potwierdzone. Wyszukiwanie wariantów zostanie dodane w kolejnym etapie.
              </MessageStrip>
            )}
          </article>
        )}
      </section>
    </main>
  );
}
