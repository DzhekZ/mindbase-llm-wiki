import { X, PenLine } from 'lucide-react';
import { FINDING_COLOR, FINDING_LABEL, type Finding } from './ops-types';

interface FindingCardProps {
  finding: Finding;
  onOpenPage: (path: string) => void;
  /** Omit to hide the per-card actions (compact chat rendering). */
  onDismiss?: (id: string) => void;
  onFollowUp?: (finding: Finding) => void;
}

export function FindingCard({ finding, onOpenPage, onDismiss, onFollowUp }: FindingCardProps) {
  const color = FINDING_COLOR[finding.kind];
  return (
    <div
      className="px-3 py-2.5 rounded-lg"
      style={{
        background: 'var(--input-bg)',
        border: '0.5px solid var(--hairline)',
        borderLeft: `3px solid ${color}`,
        opacity: finding.dismissed ? 0.45 : 1,
      }}
      data-testid={`finding-${finding.kind}`}
    >
      <div className="flex items-center gap-2">
        <span
          className="px-1.5 rounded"
          style={{ fontSize: 10, fontWeight: 700, color, border: `0.5px solid ${color}44`, textTransform: 'uppercase', letterSpacing: '0.04em' }}
        >
          {FINDING_LABEL[finding.kind]}
        </span>
        <span className="flex-1" />
        {onFollowUp && !finding.dismissed && (
          <button
            onClick={() => onFollowUp(finding)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer"
            style={{ fontSize: 11, color: 'var(--text-mid)' }}
            title="File a follow-up note into today's contributor entry"
            data-testid="finding-followup"
          >
            <PenLine size={11} strokeWidth={1.8} /> Follow up
          </button>
        )}
        {onDismiss && !finding.dismissed && (
          <button
            onClick={() => onDismiss(finding.id)}
            className="w-5 h-5 flex items-center justify-center rounded cursor-pointer"
            style={{ color: 'var(--text-faint)' }}
            title="Dismiss"
            data-testid="finding-dismiss"
          >
            <X size={11} strokeWidth={2} />
          </button>
        )}
      </div>
      <div className="mt-1.5" style={{ fontSize: 12.5, color: 'var(--text-default)', lineHeight: '18px' }}>
        {finding.detail}
      </div>
      {finding.evidence && finding.evidence.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {finding.evidence.map((ev, i) => (
            <div
              key={`${ev.page}-${i}`}
              className="pl-2"
              style={{
                borderLeft: `2px solid ${ev.verified ? color : 'var(--hairline)'}`,
                fontSize: 11.5,
                lineHeight: '16px',
                opacity: ev.verified ? 1 : 0.6,
              }}
              data-testid="finding-evidence"
            >
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => onOpenPage(ev.page)}
                  className="cursor-pointer text-left"
                  style={{ fontSize: 10.5, color: 'var(--accent)', fontFamily: 'ui-monospace, monospace' }}
                  data-testid="finding-evidence-page"
                >
                  {ev.page}
                </button>
                <span
                  style={{ fontSize: 10, fontWeight: 600, color: ev.verified ? 'var(--success, #34a853)' : 'var(--text-faint)' }}
                  data-testid={ev.verified ? 'finding-evidence-verified' : 'finding-evidence-unverified'}
                >
                  {ev.verified ? '✓ verified' : 'unverified'}
                </span>
              </div>
              <div style={{ fontStyle: 'italic', color: 'var(--text-mid)' }}>“{ev.quote}”</div>
            </div>
          ))}
        </div>
      )}
      {finding.pages.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
          {finding.pages.map((pg) => (
            <button
              key={pg}
              onClick={() => onOpenPage(pg)}
              className="cursor-pointer text-left"
              style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'ui-monospace, monospace' }}
              data-testid="finding-page"
            >
              {pg}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
