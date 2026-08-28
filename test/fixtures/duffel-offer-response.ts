export const validDuffelOfferRequestResponse = Object.freeze({
  meta_debug_value: 'must be stripped',
  data: {
    id: 'orq_000000validrequest',
    live_mode: false,
    ignored_provider_field: 'must be stripped',
    offers: [
      {
        id: 'off_000000validoffer',
        expires_at: '2026-10-01T13:00:00.000Z',
        live_mode: false,
        base_amount: '100.00',
        base_currency: 'PLN',
        tax_amount: '20.00',
        tax_currency: 'PLN',
        total_amount: '120.00',
        total_currency: 'PLN',
        ignored_offer_field: 'must be stripped',
        available_services: [
          {
            id: 'ase_000000baggage',
            type: 'baggage',
            total_amount: '25.00',
            total_currency: 'PLN',
            ignored_service_field: 'must be stripped',
          },
        ],
        slices: [
          {
            id: 'sli_000000outbound',
            duration: 'PT1H',
            origin: { iata_code: 'WRO', time_zone: 'Europe/Warsaw' },
            destination: { iata_code: 'PRG', time_zone: 'Europe/Prague' },
            segments: [
              {
                id: 'seg_000000outbound',
                departing_at: '2026-10-10T08:00:00',
                arriving_at: '2026-10-10T09:00:00',
                duration: 'PT1H',
                origin: { iata_code: 'WRO', time_zone: 'Europe/Warsaw' },
                destination: { iata_code: 'PRG', time_zone: 'Europe/Prague' },
                operating_carrier: {
                  id: 'arl_000000lotcarrier',
                  name: 'LOT Polish Airlines',
                  iata_code: 'LO',
                },
                operating_carrier_flight_number: 'LO101',
              },
            ],
          },
          {
            id: 'sli_000000returnleg',
            duration: 'PT1H',
            origin: { iata_code: 'PRG', time_zone: 'Europe/Prague' },
            destination: { iata_code: 'WRO', time_zone: 'Europe/Warsaw' },
            segments: [
              {
                id: 'seg_000000returnleg',
                departing_at: '2026-10-13T18:00:00',
                arriving_at: '2026-10-13T19:00:00',
                duration: 'PT1H',
                origin: { iata_code: 'PRG', time_zone: 'Europe/Prague' },
                destination: { iata_code: 'WRO', time_zone: 'Europe/Warsaw' },
                operating_carrier: {
                  id: 'arl_000000lotcarrier',
                  name: 'LOT Polish Airlines',
                  iata_code: 'LO',
                },
                operating_carrier_flight_number: 'LO102',
              },
            ],
          },
        ],
      },
    ],
  },
});

export function duffelFixture(): typeof validDuffelOfferRequestResponse {
  return structuredClone(validDuffelOfferRequestResponse);
}
