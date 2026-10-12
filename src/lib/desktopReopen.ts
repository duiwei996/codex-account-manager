export interface ForceCloseOutcome {
  canSwitch: boolean;
  reopenToken: string | null;
}

// Account switching must finish before reopening a desktop that reads auth.json.
export async function finishForceClose(
  outcome: ForceCloseOutcome,
  switchAccount: (() => Promise<void>) | null,
  reopenDesktop: (token: string) => Promise<void>,
): Promise<void> {
  if (!outcome.canSwitch) return;
  if (switchAccount) await switchAccount();
  if (outcome.reopenToken) await reopenDesktop(outcome.reopenToken);
}
