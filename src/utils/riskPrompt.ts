import { askConfirm } from '../dialogs.tsx';
import { t } from '../i18n.ts';
import { findRisks, isAllowed, rememberAllowed, type Risk } from './codeSafety.ts';

export function describeRisks(risks: Risk[]): string {
  return risks.map((r) => `• ${t(`risk.${r.kind}`)} — ${t('risk.line', { line: r.line })}: ${r.text}`).join('\n');
}

/**
 * Before a manual run: code that deletes folders, edits the registry, downloads and runs things... is shown to
 * the user once more. An answer "run" is remembered for this exact code.
 */
export async function confirmRiskyRun(code: string, name: string): Promise<boolean> {
  const risks = findRisks(code);
  if (!risks.length || (await isAllowed(code))) return true;
  const ok = await askConfirm(`${t('risk.title', { name })}\n\n${describeRisks(risks)}\n\n${t('risk.question')}`, {
    okLabel: t('risk.runAnyway'),
    danger: true,
  });
  if (ok) await rememberAllowed(code);
  return ok;
}
