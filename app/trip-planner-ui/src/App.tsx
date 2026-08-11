import { useState, type FormEvent } from 'react';
import {
  confirmConstraints,
  createTripRequest,
  readPlanningView,
  startPlanning,
  type BudgetItem,
  type HardConstraints,
  type OptionNote,
  type Pace,
  type PlanningView,
  type RankedOption,
  type SoftPreferences,
  type SourceSnapshot,
  type TripRequest,
  type TripRequestDraft,
} from './api.js';

const initialDraft: TripRequestDraft = {
  originCity: '',
  startDate: '',
  endDate: '',
  adults: 2,
  totalBudget: 4500,
  currency: 'PLN',
  pace: 'RELAXED',
  hardConstraints: {
    hardBudgetLimit: true,
    earliestDepartureTime: '07:00',
    latestReturnTime: '22:00',
    maxConnections: 1,
    maxTravelMinutes: 480,
    allowFlight: false,
    allowTrain: true,
    allowBus: true,
  },
  softPreferences: {
    food: 5,
    nature: 5,
    history: 3,
    museums: 2,
    nightlife: 1,
    centralAccommodation: 4,
    travelComfort: 4,
    priceSensitivity: 4,
  },
};

const paceLabels: Record<Pace, string> = {
  RELAXED: 'Spokojne',
  BALANCED: 'Zrównoważone',
  INTENSIVE: 'Intensywne',
};

const roleLabels: Record<RankedOption['role'], string> = {
  BEST_OVERALL: 'Najlepszy ogólnie',
  MOST_CONVENIENT: 'Najwygodniejszy',
  BEST_VALUE: 'Najlepsza wartość',
};

const transportLabels: Record<RankedOption['transportMode'], string> = {
  FLIGHT: 'Samolot',
  TRAIN: 'Pociąg',
  BUS: 'Autobus',
};

const preferenceFields = [
  { key: 'food', label: 'Jedzenie', help: 'lokalna kuchnia i targi' },
  { key: 'nature', label: 'Natura', help: 'parki i tereny zielone' },
  { key: 'history', label: 'Historia', help: 'zabytki i dziedzictwo' },
  { key: 'museums', label: 'Muzea', help: 'kolekcje i wystawy' },
  { key: 'nightlife', label: 'Życie nocne', help: 'wieczorne atrakcje' },
  {
    key: 'centralAccommodation',
    label: 'Centralny nocleg',
    help: 'bliskość centrum',
  },
  { key: 'travelComfort', label: 'Komfort podróży', help: 'wygoda przejazdu' },
  { key: 'priceSensitivity', label: 'Wrażliwość cenowa', help: 'znaczenie oszczędności' },
] as const satisfies readonly {
  key: keyof SoftPreferences;
  label: string;
  help: string;
}[];

const budgetCategoryLabels: Record<string, string> = {
  TRANSPORT: 'Transport',
  ACCOMMODATION: 'Nocleg',
  LOCAL_TRANSPORT: 'Transport lokalny',
  FOOD: 'Wyżywienie',
  ATTRACTIONS: 'Atrakcje',
  ADDITIONAL_FEES: 'Opłaty dodatkowe',
  BUFFER: 'Bufor',
};

const scoreComponents: readonly {
  key: keyof Pick<
    RankedOption,
    | 'budgetFitScore'
    | 'travelTimeScore'
    | 'effectiveTimeScore'
    | 'accommodationLocationScore'
    | 'dataCompletenessScore'
    | 'priceConfidenceScore'
    | 'preferenceFitScore'
  >;
  label: string;
}[] = [
  { key: 'budgetFitScore', label: 'Budżet' },
  { key: 'travelTimeScore', label: 'Czas podróży' },
  { key: 'effectiveTimeScore', label: 'Czas na miejscu' },
  { key: 'accommodationLocationScore', label: 'Lokalizacja noclegu' },
  { key: 'dataCompletenessScore', label: 'Kompletność danych' },
  { key: 'priceConfidenceScore', label: 'Pewność ceny' },
  { key: 'preferenceFitScore', label: 'Preferencje' },
];

type FormErrors = Partial<Record<string, string>>;
type Operation = 'saving' | 'confirming' | 'planning' | null;

function validateDraft(draft: TripRequestDraft): FormErrors {
  const errors: FormErrors = {};
  if (!draft.originCity.trim()) errors.originCity = 'Podaj miasto rozpoczęcia.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate)) {
    errors.startDate = 'Podaj datę rozpoczęcia.';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.endDate)) {
    errors.endDate = 'Podaj datę zakończenia.';
  } else if (draft.startDate && draft.endDate <= draft.startDate) {
    errors.endDate = 'Data zakończenia musi być późniejsza.';
  }
  if (!Number.isInteger(draft.adults) || draft.adults < 1) {
    errors.adults = 'Liczba dorosłych musi być dodatnią liczbą całkowitą.';
  }
  if (!Number.isFinite(draft.totalBudget) || draft.totalBudget <= 0) {
    errors.totalBudget = 'Budżet musi być większy od zera.';
  }
  if (!/^[A-Z]{3}$/.test(draft.currency)) {
    errors.currency = 'Użyj trzyliterowego kodu, np. PLN.';
  }
  if (
    !Number.isInteger(draft.hardConstraints.maxConnections) ||
    draft.hardConstraints.maxConnections < 0
  ) {
    errors.maxConnections = 'Limit przesiadek musi być liczbą całkowitą od zera.';
  }
  if (
    !Number.isInteger(draft.hardConstraints.maxTravelMinutes) ||
    draft.hardConstraints.maxTravelMinutes <= 0
  ) {
    errors.maxTravelMinutes = 'Limit podróży musi być dodatnią liczbą minut.';
  }
  if (
    !draft.hardConstraints.allowFlight &&
    !draft.hardConstraints.allowTrain &&
    !draft.hardConstraints.allowBus
  ) {
    errors.transportModes = 'Wybierz co najmniej jeden środek transportu.';
  }
  for (const { key } of preferenceFields) {
    const value = draft.softPreferences[key];
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      errors[key] = 'Waga musi mieścić się w zakresie 1–5.';
    }
  }
  return errors;
}

function formatMoney(value: number | string | null, currency: string): string {
  if (value === null) return 'nieznany';
  const minor = Number(value);
  if (!Number.isSafeInteger(minor)) return 'nieznany';
  return new Intl.NumberFormat('pl-PL', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(minor / 100);
}

function formatInstant(value: string): string {
  return `${value.slice(0, 10)} · ${value.slice(11, 16)}`;
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours} godz. ${remainder} min`;
}

function preferenceWeightLabel(value: number): string {
  return (
    ['nieistotne', 'mało ważne', 'neutralne', 'ważne', 'bardzo ważne'][value - 1] ?? `${value}`
  );
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <span id={id} className="field-error" role="alert">
      {message}
    </span>
  ) : null;
}

function HardConstraintsSummary({ tripRequest }: { tripRequest: TripRequest }) {
  const constraints = tripRequest.hardConstraints;
  const modes = [
    constraints.allowFlight ? 'samolot' : null,
    constraints.allowTrain ? 'pociąg' : null,
    constraints.allowBus ? 'autobus' : null,
  ].filter((value): value is string => value !== null);
  return (
    <section className="summary-panel" aria-labelledby="hard-summary-title">
      <h3 id="hard-summary-title">Twarde ograniczenia</h3>
      <dl className="compact-list" data-testid="hard-constraints-summary">
        <div>
          <dt>Okno wyjazdu</dt>
          <dd>od {constraints.earliestDepartureTime || 'bez limitu'}</dd>
        </div>
        <div>
          <dt>Powrót</dt>
          <dd>do {constraints.latestReturnTime || 'bez limitu'}</dd>
        </div>
        <div>
          <dt>Przesiadki</dt>
          <dd>maks. {constraints.maxConnections}</dd>
        </div>
        <div>
          <dt>Czas jednego odcinka</dt>
          <dd>maks. {constraints.maxTravelMinutes} min</dd>
        </div>
        <div>
          <dt>Transport</dt>
          <dd>{modes.join(', ')}</dd>
        </div>
        <div>
          <dt>Budżet</dt>
          <dd>{constraints.hardBudgetLimit ? 'twardy limit' : 'miękka preferencja'}</dd>
        </div>
      </dl>
    </section>
  );
}

function SoftPreferencesSummary({ preferences }: { preferences: SoftPreferences }) {
  return (
    <section className="summary-panel" aria-labelledby="soft-summary-title">
      <h3 id="soft-summary-title">Miękkie preferencje</h3>
      <ul className="preference-summary" data-testid="soft-preferences-summary">
        {preferenceFields.map(({ key, label }) => (
          <li key={key}>
            <span>{label}</span>
            <strong>
              {preferences[key]}/5 · {preferenceWeightLabel(preferences[key])}
            </strong>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NotesList({
  title,
  notes,
  className,
}: {
  title: string;
  notes: OptionNote[];
  className: string;
}) {
  return (
    <section className={`note-group ${className}`}>
      <h4>{title}</h4>
      <ul>
        {notes.map((note) => (
          <li key={note.ID}>{note.text}</li>
        ))}
      </ul>
    </section>
  );
}

function OptionCard({ option, planning }: { option: RankedOption; planning: PlanningView }) {
  const budgetItems = planning.budgetItems.filter((item) => item.rankedOption_ID === option.ID);
  const sources = planning.sourceSnapshots.filter((source) => source.rankedOption_ID === option.ID);
  const notes = planning.optionNotes.filter((note) => note.rankedOption_ID === option.ID);
  const fetchedFixture = sources.find(
    (source) =>
      source.fixtureVersion === option.providerFixtureVersion && source.provider.startsWith('Mock'),
  );
  const cardTitle = `option-${option.rank}-title`;

  return (
    <article className="option-card" data-testid="option-card" aria-labelledby={cardTitle}>
      <header className="option-header">
        <div>
          <span className="role-badge" data-testid="option-role">
            {option.role} · {roleLabels[option.role]}
          </span>
          <h3 id={cardTitle}>{option.destinationCity}</h3>
          <p>
            {option.destinationCountryCode} · {option.destinationCode}
          </p>
        </div>
        <div
          className="score-dial"
          aria-label={`Końcowy score ${Number(option.totalScore).toFixed(2)} na 100`}
        >
          <strong>{Number(option.totalScore).toFixed(2)}</strong>
          <span>/100</span>
        </div>
      </header>

      <div className="cost-highlight" data-testid="option-cost">
        <span>Łącznie</span>
        <strong>{formatMoney(option.totalAmountMinor, option.currency)}</strong>
        <small>{formatMoney(option.costPerPersonMinor, option.currency)} na osobę</small>
      </div>

      <dl className="option-facts">
        <div>
          <dt>Potwierdzone</dt>
          <dd>{formatMoney(option.confirmedAmountMinor, option.currency)}</dd>
        </div>
        <div>
          <dt>Estymowane</dt>
          <dd>{formatMoney(option.estimatedAmountMinor, option.currency)}</dd>
        </div>
        <div>
          <dt>Nieznane</dt>
          <dd>{option.unknownCategoryCount} kategorii</dd>
        </div>
        <div data-testid="option-transport">
          <dt>Transport</dt>
          <dd>{transportLabels[option.transportMode]}</dd>
        </div>
        <div>
          <dt>Wyjazd</dt>
          <dd>{formatInstant(option.outboundDepartureAt)}</dd>
        </div>
        <div>
          <dt>Powrót</dt>
          <dd>{formatInstant(option.returnArrivalAt)}</dd>
        </div>
        <div>
          <dt>Przesiadki</dt>
          <dd>maks. {option.maximumConnections}</dd>
        </div>
        <div>
          <dt>Czas podróży</dt>
          <dd>
            {formatDuration(option.outboundTravelMinutes)} /{' '}
            {formatDuration(option.returnTravelMinutes)}
          </dd>
        </div>
        <div>
          <dt>Czas na miejscu</dt>
          <dd>{formatDuration(option.effectiveTimeAtDestinationMinutes)}</dd>
        </div>
        <div>
          <dt>Nocleg</dt>
          <dd>
            {option.stayName} · {option.nights} noce
          </dd>
        </div>
      </dl>

      <section className="score-section" aria-labelledby={`score-${option.rank}`}>
        <h4 id={`score-${option.rank}`}>Komponenty score</h4>
        <div className="score-list">
          {scoreComponents.map(({ key, label }) => {
            const value = Number(option[key]);
            return (
              <div className="score-row" key={key}>
                <span>{label}</span>
                <progress max="100" value={value}>
                  {value}
                </progress>
                <strong>{value.toFixed(2)}</strong>
              </div>
            );
          })}
        </div>
      </section>

      <div className="notes-grid">
        <NotesList
          title="Zalety"
          notes={notes.filter((note) => note.kind === 'ADVANTAGE')}
          className="advantages"
        />
        <NotesList
          title="Kompromisy"
          notes={notes.filter((note) => note.kind === 'TRADEOFF')}
          className="tradeoffs"
        />
        <NotesList
          title="Ryzyka"
          notes={notes.filter((note) => note.kind === 'RISK')}
          className="risks"
        />
      </div>

      <p className="fixture-date">
        Fixture pobrano: <strong>{fetchedFixture?.fetchedAt.slice(0, 10) ?? 'brak daty'}</strong>
      </p>

      <div className="option-details-grid">
        <details data-testid="option-budget">
          <summary>Budżet szczegółowy</summary>
          <ul className="budget-list">
            {budgetItems.map((item: BudgetItem) => (
              <li key={item.ID}>
                <span>{budgetCategoryLabels[item.category] ?? item.category}</span>
                <strong>{formatMoney(item.amountMinor, item.currency)}</strong>
                <small>
                  {item.classification} · {item.priceType}
                </small>
              </li>
            ))}
          </ul>
        </details>

        <details data-testid="option-sources">
          <summary>Źródła ({sources.length})</summary>
          <ul className="source-list">
            {sources.map((source: SourceSnapshot) => (
              <li key={source.ID}>
                <strong>{source.provider}</strong>
                <span>{source.contexts}</span>
                <small>
                  {source.fixtureVersion} · {source.fetchedAt.slice(0, 10)}
                </small>
                {source.demonstrationData && (
                  <em data-testid="fixture-label">Dane demonstracyjne · INTERNAL_FIXTURE</em>
                )}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </article>
  );
}

function RejectionDiagnostics({ planning }: { planning: PlanningView }) {
  return (
    <details className="diagnostics" data-testid="rejection-diagnostics">
      <summary>
        Diagnostyka odrzuceń · {planning.planningRun.rejectedCandidateCount} kandydatów
      </summary>
      <p>
        Kandydaci zostali odrzuceni przez twarde, deterministyczne reguły. Ograniczenia nie były
        luzowane.
      </p>
      <div className="rejection-groups">
        {planning.rejectionSummaries.map((summary) => {
          const details = planning.rejectionReasons.filter(
            (reason) => reason.code === summary.code,
          );
          return (
            <details key={summary.ID} data-testid="rejection-group">
              <summary>
                {summary.code} · {summary.candidateCount} kandydatów · {summary.occurrenceCount}{' '}
                powodów
              </summary>
              <ul>
                {details.map((reason) => (
                  <li key={reason.ID}>
                    <strong>{reason.candidateId}</strong>
                    <span>{reason.message}</span>
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </details>
  );
}

export default function App() {
  const [draft, setDraft] = useState(initialDraft);
  const [saved, setSaved] = useState<TripRequest | null>(null);
  const [planning, setPlanning] = useState<PlanningView | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const [error, setError] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<FormErrors>({});

  const update = <K extends keyof TripRequestDraft>(key: K, value: TripRequestDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setFormErrors((current) => ({ ...current, [key]: undefined }));
  };

  const updateHardConstraint = <K extends keyof HardConstraints>(
    key: K,
    value: HardConstraints[K],
  ) => {
    setDraft((current) => ({
      ...current,
      hardConstraints: { ...current.hardConstraints, [key]: value },
    }));
    setFormErrors((current) => ({ ...current, [key]: undefined, transportModes: undefined }));
  };

  const updatePreference = <K extends keyof SoftPreferences>(key: K, value: number) => {
    setDraft((current) => ({
      ...current,
      softPreferences: { ...current.softPreferences, [key]: value },
    }));
    setFormErrors((current) => ({ ...current, [key]: undefined }));
  };

  const saveBrief = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationErrors = validateDraft(draft);
    setFormErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) {
      setError('Popraw oznaczone pola przed zapisaniem briefu.');
      return;
    }
    setOperation('saving');
    setError(null);
    try {
      setSaved(await createTripRequest(draft));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nie udało się zapisać briefu.');
    } finally {
      setOperation(null);
    }
  };

  const confirmBrief = async () => {
    if (!saved) return;
    setOperation('confirming');
    setError(null);
    try {
      setSaved(await confirmConstraints(saved.ID));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nie udało się potwierdzić ograniczeń.');
    } finally {
      setOperation(null);
    }
  };

  const findOptions = async () => {
    if (!saved) return;
    setOperation('planning');
    setError(null);
    try {
      const planningRun = await startPlanning(saved.ID);
      const view = await readPlanningView(saved.ID, planningRun);
      setPlanning(view);
      if (planningRun.status !== 'SUCCEEDED') {
        setError(planningRun.errorMessage ?? 'Nie znaleziono trzech poprawnych wariantów.');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Nie udało się znaleźć wariantów.');
    } finally {
      setOperation(null);
    }
  };

  const busy = operation !== null;

  return (
    <main className="page-shell">
      <header className="hero">
        <p className="eyebrow">TRIP PLANNER · DETERMINISTIC FIRST</p>
        <h1>Trzy wykonalne warianty, bez zgadywania</h1>
        <p className="hero-copy">
          Potwierdź twarde ograniczenia i priorytety. Kod odrzuci niewykonalne kandydatury, policzy
          budżet oraz pokaże źródła każdej demonstracyjnej oferty.
        </p>
      </header>

      <section className="content-card" aria-labelledby="brief-title" aria-busy={busy}>
        <div className="section-heading">
          <div>
            <p className="step-label">Krok 1</p>
            <h2 id="brief-title">Brief i ograniczenia</h2>
          </div>
          {saved && (
            <span className={`status status-${saved.status.toLowerCase()}`} data-testid="status">
              {saved.status}
            </span>
          )}
        </div>

        {error && (
          <div className="alert" role="alert" data-testid="backend-error">
            {error}
          </div>
        )}
        {operation && (
          <p className="loading-status" role="status" data-testid="loading-state">
            {operation === 'saving' && 'Zapisywanie briefu…'}
            {operation === 'confirming' && 'Potwierdzanie ograniczeń…'}
            {operation === 'planning' && 'Budujemy i filtrujemy warianty…'}
          </p>
        )}

        {!saved ? (
          <form className="brief-form" onSubmit={saveBrief} noValidate>
            <fieldset className="form-section form-grid">
              <legend>Podstawowy brief</legend>
              <div className="field field-wide">
                <label htmlFor="origin-city">Miasto rozpoczęcia</label>
                <input
                  id="origin-city"
                  data-testid="origin-city"
                  value={draft.originCity}
                  onChange={(event) => update('originCity', event.target.value)}
                  aria-invalid={Boolean(formErrors.originCity)}
                  aria-describedby={formErrors.originCity ? 'origin-city-error' : undefined}
                  required
                  placeholder="np. Wrocław"
                />
                <FieldError id="origin-city-error" message={formErrors.originCity} />
              </div>
              <div className="field">
                <label htmlFor="start-date">Data rozpoczęcia</label>
                <input
                  id="start-date"
                  data-testid="start-date"
                  type="date"
                  value={draft.startDate}
                  onChange={(event) => update('startDate', event.target.value)}
                  aria-invalid={Boolean(formErrors.startDate)}
                  aria-describedby={formErrors.startDate ? 'start-date-error' : undefined}
                  required
                />
                <FieldError id="start-date-error" message={formErrors.startDate} />
              </div>
              <div className="field">
                <label htmlFor="end-date">Data zakończenia</label>
                <input
                  id="end-date"
                  data-testid="end-date"
                  type="date"
                  value={draft.endDate}
                  onChange={(event) => update('endDate', event.target.value)}
                  aria-invalid={Boolean(formErrors.endDate)}
                  aria-describedby={formErrors.endDate ? 'end-date-error' : undefined}
                  required
                />
                <FieldError id="end-date-error" message={formErrors.endDate} />
              </div>
              <div className="field">
                <label htmlFor="adults">Liczba dorosłych</label>
                <input
                  id="adults"
                  data-testid="adults"
                  type="number"
                  min="1"
                  step="1"
                  value={draft.adults}
                  onChange={(event) => update('adults', Number(event.target.value))}
                  aria-invalid={Boolean(formErrors.adults)}
                  aria-describedby={formErrors.adults ? 'adults-error' : undefined}
                  required
                />
                <FieldError id="adults-error" message={formErrors.adults} />
              </div>
              <div className="field">
                <label htmlFor="total-budget">Całkowity budżet</label>
                <input
                  id="total-budget"
                  data-testid="total-budget"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={draft.totalBudget}
                  onChange={(event) => update('totalBudget', Number(event.target.value))}
                  aria-invalid={Boolean(formErrors.totalBudget)}
                  aria-describedby={formErrors.totalBudget ? 'total-budget-error' : undefined}
                  required
                />
                <FieldError id="total-budget-error" message={formErrors.totalBudget} />
              </div>
              <div className="field">
                <label htmlFor="currency">Waluta</label>
                <input
                  id="currency"
                  data-testid="currency"
                  value={draft.currency}
                  maxLength={3}
                  onChange={(event) => update('currency', event.target.value.toUpperCase())}
                  aria-invalid={Boolean(formErrors.currency)}
                  aria-describedby={formErrors.currency ? 'currency-error' : undefined}
                  required
                />
                <FieldError id="currency-error" message={formErrors.currency} />
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
            </fieldset>

            <fieldset className="form-section form-grid">
              <legend>Twarde ograniczenia</legend>
              <div className="field">
                <label htmlFor="earliest-departure">Najwcześniejszy wyjazd</label>
                <input
                  id="earliest-departure"
                  data-testid="earliest-departure"
                  type="time"
                  value={draft.hardConstraints.earliestDepartureTime}
                  onChange={(event) =>
                    updateHardConstraint('earliestDepartureTime', event.target.value)
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="latest-return">Najpóźniejszy powrót</label>
                <input
                  id="latest-return"
                  data-testid="latest-return"
                  type="time"
                  value={draft.hardConstraints.latestReturnTime}
                  onChange={(event) => updateHardConstraint('latestReturnTime', event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="max-connections">Maks. liczba przesiadek</label>
                <input
                  id="max-connections"
                  data-testid="max-connections"
                  type="number"
                  min="0"
                  step="1"
                  value={draft.hardConstraints.maxConnections}
                  onChange={(event) =>
                    updateHardConstraint('maxConnections', Number(event.target.value))
                  }
                  aria-invalid={Boolean(formErrors.maxConnections)}
                  aria-describedby={formErrors.maxConnections ? 'max-connections-error' : undefined}
                />
                <FieldError id="max-connections-error" message={formErrors.maxConnections} />
              </div>
              <div className="field">
                <label htmlFor="max-travel-minutes">Maks. czas jednego odcinka (min)</label>
                <input
                  id="max-travel-minutes"
                  data-testid="max-travel-minutes"
                  type="number"
                  min="1"
                  step="1"
                  value={draft.hardConstraints.maxTravelMinutes}
                  onChange={(event) =>
                    updateHardConstraint('maxTravelMinutes', Number(event.target.value))
                  }
                  aria-invalid={Boolean(formErrors.maxTravelMinutes)}
                  aria-describedby={
                    formErrors.maxTravelMinutes ? 'max-travel-minutes-error' : undefined
                  }
                />
                <FieldError id="max-travel-minutes-error" message={formErrors.maxTravelMinutes} />
              </div>
              <div className="field field-wide checkbox-field">
                <input
                  id="hard-budget-limit"
                  data-testid="hard-budget-limit"
                  type="checkbox"
                  checked={draft.hardConstraints.hardBudgetLimit}
                  onChange={(event) =>
                    updateHardConstraint('hardBudgetLimit', event.target.checked)
                  }
                />
                <label htmlFor="hard-budget-limit">Budżet jest twardym limitem</label>
              </div>
              <div className="field field-wide">
                <span className="group-label" id="transport-mode-label">
                  Dozwolone środki transportu
                </span>
                <div
                  className="checkbox-group"
                  role="group"
                  aria-labelledby="transport-mode-label"
                  aria-describedby={formErrors.transportModes ? 'transport-modes-error' : undefined}
                >
                  <label>
                    <input
                      data-testid="allow-flight"
                      type="checkbox"
                      checked={draft.hardConstraints.allowFlight}
                      onChange={(event) =>
                        updateHardConstraint('allowFlight', event.target.checked)
                      }
                    />{' '}
                    Samolot
                  </label>
                  <label>
                    <input
                      data-testid="allow-train"
                      type="checkbox"
                      checked={draft.hardConstraints.allowTrain}
                      onChange={(event) => updateHardConstraint('allowTrain', event.target.checked)}
                    />{' '}
                    Pociąg
                  </label>
                  <label>
                    <input
                      data-testid="allow-bus"
                      type="checkbox"
                      checked={draft.hardConstraints.allowBus}
                      onChange={(event) => updateHardConstraint('allowBus', event.target.checked)}
                    />{' '}
                    Autobus
                  </label>
                </div>
                <FieldError id="transport-modes-error" message={formErrors.transportModes} />
              </div>
            </fieldset>

            <fieldset className="form-section preference-grid">
              <legend>Miękkie preferencje</legend>
              <p className="fieldset-help">
                1 oznacza niski priorytet, 5 — bardzo wysoki. Każdy suwak działa z klawiatury.
              </p>
              {preferenceFields.map(({ key, label, help }) => (
                <div className="preference-field" key={key}>
                  <div>
                    <label htmlFor={`preference-${key}`}>{label}</label>
                    <small>{help}</small>
                  </div>
                  <input
                    id={`preference-${key}`}
                    data-testid={`preference-${key}`}
                    type="range"
                    min="1"
                    max="5"
                    step="1"
                    value={draft.softPreferences[key]}
                    onChange={(event) => updatePreference(key, Number(event.target.value))}
                    aria-describedby={`preference-${key}-value`}
                  />
                  <output id={`preference-${key}-value`} htmlFor={`preference-${key}`}>
                    <strong>{draft.softPreferences[key]}/5</strong> ·{' '}
                    {preferenceWeightLabel(draft.softPreferences[key])}
                  </output>
                  <FieldError id={`preference-${key}-error`} message={formErrors[key]} />
                </div>
              ))}
            </fieldset>

            <div className="actions">
              <button
                className="primary-button"
                type="submit"
                disabled={busy}
                data-testid="save-brief"
              >
                {operation === 'saving' ? 'Zapisywanie…' : 'Zapisz brief'}
              </button>
            </div>
          </form>
        ) : (
          <article className="summary" data-testid="brief-summary" aria-live="polite">
            <div className="trip-overview">
              <div>
                <span>Start</span>
                <strong>{saved.originCity}</strong>
              </div>
              <div>
                <span>Termin</span>
                <strong>
                  {saved.startDate} – {saved.endDate}
                </strong>
              </div>
              <div>
                <span>Podróżni</span>
                <strong>{saved.adults} dorosłych</strong>
              </div>
              <div>
                <span>Budżet</span>
                <strong>
                  {saved.totalBudget} {saved.currency}
                </strong>
              </div>
              <div>
                <span>Tempo</span>
                <strong>{paceLabels[saved.pace]}</strong>
              </div>
            </div>
            <div className="summary-columns">
              <HardConstraintsSummary tripRequest={saved} />
              <SoftPreferencesSummary preferences={saved.softPreferences} />
            </div>
            <div className="actions">
              {saved.status === 'DRAFT' ? (
                <button
                  className="primary-button"
                  onClick={confirmBrief}
                  disabled={busy}
                  data-testid="confirm-constraints"
                >
                  {operation === 'confirming' ? 'Potwierdzanie…' : 'Potwierdź ograniczenia'}
                </button>
              ) : !planning ? (
                <button
                  className="primary-button"
                  onClick={findOptions}
                  disabled={busy}
                  data-testid="start-planning"
                >
                  {operation === 'planning' ? 'Szukamy wariantów…' : 'Znajdź warianty'}
                </button>
              ) : (
                <span className="ready-message" data-testid="workflow-status">
                  Workflow: {planning.workflowRun.state}
                </span>
              )}
            </div>
          </article>
        )}
      </section>

      {planning?.planningRun.status === 'SUCCEEDED' && (
        <section className="results-section" aria-labelledby="results-title">
          <div className="results-heading">
            <div>
              <p className="step-label">Krok 2</p>
              <h2 id="results-title">Trzy zróżnicowane warianty</h2>
            </div>
            <p>
              Fixture: <strong>{planning.planningRun.providerFixtureVersion}</strong>
              <br />
              Scoring: <strong>{planning.planningRun.scoringVersion}</strong>
            </p>
          </div>
          <div className="options-grid" data-testid="options-grid">
            {planning.rankedOptions.map((option) => (
              <OptionCard key={option.ID} option={option} planning={planning} />
            ))}
          </div>
          <RejectionDiagnostics planning={planning} />
        </section>
      )}

      {planning?.planningRun.status === 'INSUFFICIENT_OPTIONS' && (
        <section className="results-section" aria-labelledby="shortage-title">
          <h2 id="shortage-title">Brak trzech poprawnych wariantów</h2>
          <p>Constraints nie zostały poluzowane, a częściowe karty nie zostały zapisane.</p>
          <RejectionDiagnostics planning={planning} />
        </section>
      )}
    </main>
  );
}
