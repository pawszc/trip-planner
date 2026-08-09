import { beforeEach, describe, expect, it } from 'vitest';
import { validTripRequest } from '../fixtures/trip-request.js';

process.env.CDS_TYPESCRIPT = 'true';
const { default: cds } = await import('@sap/cds');
const test = cds.test('serve', 'all', '--in-memory').in(process.cwd());
const { GET, PATCH, POST } = test;

interface CreatedTripRequest {
  ID: string;
  originCity: string;
  status: string;
}

beforeEach(test.data.reset);

describe('TripPlannerService', () => {
  it('creates and reads a valid TripRequest', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;

    expect(tripRequest.ID).toBeTruthy();
    expect(tripRequest.status).toBe('DRAFT');

    const read = await GET(`/trip-planner/TripRequests(${tripRequest.ID})`);
    expect((read.data as CreatedTripRequest).originCity).toBe('Warszawa');
  });

  it('rejects an invalid TripRequest', async () => {
    await expect(
      POST('/trip-planner/TripRequests', { ...validTripRequest, adults: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects bypassing the confirmation action through PATCH', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;
    const entityUrl = `/trip-planner/TripRequests(${tripRequest.ID})`;

    await expect(PATCH(entityUrl, { status: 'CONSTRAINTS_CONFIRMED' })).rejects.toMatchObject({
      status: 400,
    });

    const read = await GET(entityUrl);
    expect((read.data as CreatedTripRequest).status).toBe('DRAFT');
  });

  it('confirms constraints and rejects repeated confirmation', async () => {
    const created = await POST('/trip-planner/TripRequests', validTripRequest);
    const tripRequest = created.data as CreatedTripRequest;
    const actionUrl = `/trip-planner/TripRequests(${tripRequest.ID})/TripPlannerService.confirmConstraints`;

    const confirmed = await POST(actionUrl, {});
    expect((confirmed.data as CreatedTripRequest).status).toBe('CONSTRAINTS_CONFIRMED');

    const read = await GET(`/trip-planner/TripRequests(${tripRequest.ID})`);
    expect((read.data as CreatedTripRequest).status).toBe('CONSTRAINTS_CONFIRMED');

    await expect(POST(actionUrl, {})).rejects.toMatchObject({ status: 409 });
  });
});
