// PDF-4: the Download PDF and Share buttons (src/components/pdf/PdfActions.tsx) as the static export writes them, before any script runs:
//   - `Download PDF` is there; `Share` is not (it is drawn only after the page has started, and only where the browser can share a PDF file), nor are `Stop` and `Send PDF`
//     (they belong to a PDF being made, and to a share the browser refused)
//   - disabled (a catalogue with nothing in stock), the button cannot be pressed and its title says why
// The buttons at work (the download, the share, Stop, Send PDF, the fonts fetched only after the tap, the phone) are tests/e2e/print.spec.ts, PDF-S1.
//
// Run: npm test -- tests/unit/pdf-actions.test.ts
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PdfActions, { type PdfActionsProps } from '@/components/pdf/PdfActions';

const neverMade: PdfActionsProps['make'] = () => Promise.reject(new Error('not in this test'));

const markup = (props: Partial<PdfActionsProps> = {}) =>
  renderToStaticMarkup(
    createElement(PdfActions, {
      make: neverMade,
      shareTitle: 'Estimate W13-QTY3',
      testIdPrefix: 'estimate-pdf',
      ...props,
    })
  );

/** The `<button>` with the test id, as written. */
const buttonOf = (html: string, testId: string) =>
  new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>[\\s\\S]*?</button>`).exec(html)?.[0] ?? '';
/** The words of a piece of markup, with its tags (the icon) taken out. */
const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('PDF-4: PdfActions as the static page has it', () => {
  it('has the Download PDF button and no Share, Stop or Send PDF', () => {
    const html = markup();
    const download = buttonOf(html, 'estimate-pdf-download');
    expect(download, 'the estimate-pdf-download button').not.toBe('');
    expect(words(download)).toBe('Download PDF');
    expect(download).toContain('btn-primary');
    expect(download).not.toMatch(/\sdisabled=""/);
    for (const id of ['share', 'stop', 'send', 'progress', 'error']) {
      expect(html).not.toContain(`data-testid="estimate-pdf-${id}"`);
    }
    for (const word of ['Share', 'Stop', 'Send PDF', 'Making PDF']) {
      expect(words(html)).not.toContain(word);
    }
  });

  it('takes the prefix it is given, so the catalogue has its own ids', () => {
    const html = markup({ testIdPrefix: 'catalogue-pdf', shareTitle: 'Stock Catalogue' });
    expect(words(buttonOf(html, 'catalogue-pdf-download'))).toBe('Download PDF');
    expect(html).not.toContain('estimate-pdf');
  });

  it('disabled, the button cannot be pressed and its title gives the reason', () => {
    const html = markup({ disabled: true, disabledReason: 'Nothing in stock' });
    const download = buttonOf(html, 'estimate-pdf-download');
    expect(download).toMatch(/\sdisabled=""/);
    expect(download).toContain('title="Nothing in stock"');
    expect(words(download)).toBe('Download PDF');
  });

  it('enabled, the button has no title, even with a reason given', () => {
    const html = markup({ disabled: false, disabledReason: 'Nothing in stock' });
    expect(buttonOf(html, 'estimate-pdf-download')).not.toContain('title=');
  });
});
