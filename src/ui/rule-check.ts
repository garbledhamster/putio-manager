export function canCheckRules(hasToken: boolean, ruleCount: number, paused: boolean): boolean {
  return hasToken && ruleCount > 0 && !paused;
}
export function requestRuleCheck(paused: boolean, request: () => void): void {
  if (!paused) request();
}
