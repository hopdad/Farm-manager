/** What every admin server action returns (for useActionState; actions never throw to the client). */
export interface ActionResult {
  ok: boolean;
  message: string;
  /** Distinguishes two identical results (so the UI re-announces them). */
  at: number;
}

export const actionResult = (ok: boolean, message: string): ActionResult => ({
  ok,
  message,
  at: Date.now(),
});
