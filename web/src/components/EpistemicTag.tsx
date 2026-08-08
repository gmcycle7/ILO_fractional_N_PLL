/**
 * Epistemic status badge, mirroring MODEL_SPEC.md labels. Every equation /
 * claim in chapter content should carry one where the spec does.
 *
 *   <EpistemicTag kind="EXACT" />  ->  [EXACT]
 */

export type EpistemicKind = 'EXACT' | 'ASSUMPTION' | 'APPROX' | 'EXPERIMENT' | 'INFERENCE';

export const EPISTEMIC_KINDS: EpistemicKind[] = [
  'EXACT',
  'ASSUMPTION',
  'APPROX',
  'EXPERIMENT',
  'INFERENCE',
];

export default function EpistemicTag({ kind }: { kind: EpistemicKind }) {
  return <span className={`epistemic-tag epistemic-${kind.toLowerCase()}`}>[{kind}]</span>;
}
