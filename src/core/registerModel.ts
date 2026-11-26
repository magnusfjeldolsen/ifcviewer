/**
 * A model counts as loaded once its record is stored. Panels that list the
 * loaded models (the Parameters picker, #113) are told at that moment, with
 * the record already readable, so they cannot refresh too early.
 */
export function registerModel<R>(
  records: Map<string, R>,
  id: string,
  record: R,
  onRegistered: () => void,
): void {
  records.set(id, record);
  onRegistered();
}
