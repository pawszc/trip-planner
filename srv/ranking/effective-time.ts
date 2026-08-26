const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Calculates whole effective minutes at the destination between outbound arrival and return
 * departure. Invalid or reversed timestamps preserve the candidate engine's fail-closed zero.
 */
export function calculateEffectiveTimeAtDestinationMinutes(
  outboundArrivalAt: string,
  returnDepartureAt: string,
): number {
  const arrival = Date.parse(outboundArrivalAt);
  const departure = Date.parse(returnDepartureAt);
  if (!Number.isFinite(arrival) || !Number.isFinite(departure) || departure < arrival) {
    return 0;
  }
  return Math.floor((departure - arrival) / MILLISECONDS_PER_MINUTE);
}
