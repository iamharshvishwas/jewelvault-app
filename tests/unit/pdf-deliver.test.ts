// PDF-2: the file names of the two PDFs and the two ways to hand one over (src/lib/pdf/fileName.ts, deliver.ts):
//   - estimate `{invoiceNumber} - {customerName}.pdf` (just the number when the name is blank), catalogue `Stock Catalogue - {categories} - {DD-MM-YYYY}.pdf`
//   - `\ / : * ? " < > |` and control characters become `-`, white space runs become one space, at most 120 characters before `.pdf`
//   - Download PDF: an <a download> on a blob address, clicked once, the address freed 60 s later
//   - Share: shown only when the browser can share a PDF file; a menu the person closes is `cancelled`, a refusal of the tap is `blocked`, anything else is thrown
//
// Run: npm test -- tests/unit/pdf-deliver.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canSharePdf, downloadPdf, sharePdf } from '@/lib/pdf/deliver';
import { catalogueFileName, estimateFileName, safeFileName } from '@/lib/pdf/fileName';
import type { PdfFile } from '@/lib/pdf/types';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const pdf = (fileName = 'EST-0042 - Anita Sharma.pdf'): PdfFile => ({
  blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
  fileName,
});

describe('PDF-2: estimateFileName', () => {
  it('is the number, a dash and the customer name', () => {
    expect(estimateFileName({ invoiceNumber: 'EST-0042', customerName: 'Anita Sharma' })).toBe(
      'EST-0042 - Anita Sharma.pdf'
    );
  });

  it('turns the letters a file name cannot hold into dashes', () => {
    expect(estimateFileName({ invoiceNumber: 'EST-0042', customerName: 'A/B: C*?' })).toBe(
      'EST-0042 - A-B- C--.pdf'
    );
    expect(safeFileName('a\\b/c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j.pdf');
    expect(safeFileName('a\u0000b\u001fc\u007fd')).toBe('a-b-c-d.pdf');
  });

  it('is just the number when the name is blank', () => {
    expect(estimateFileName({ invoiceNumber: 'EST-0042', customerName: '' })).toBe('EST-0042.pdf');
    expect(estimateFileName({ invoiceNumber: 'EST-0042', customerName: '  \t \n ' })).toBe(
      'EST-0042.pdf'
    );
  });

  it('makes a run of white space one space, a tab or a new line included', () => {
    expect(
      estimateFileName({ invoiceNumber: 'EST-0042', customerName: 'Anita   \t Sharma\n' })
    ).toBe('EST-0042 - Anita Sharma.pdf');
  });

  it('cuts a 200-letter name so that 120 characters stand before .pdf', () => {
    const name = estimateFileName({ invoiceNumber: 'EST-0042', customerName: 'a'.repeat(200) });
    expect(name.endsWith('.pdf')).toBe(true);
    expect(name.length - '.pdf'.length).toBe(120);
    expect(name.startsWith('EST-0042 - aaa')).toBe(true);
  });

  it('never cuts a letter in half (an emoji is two code units)', () => {
    const base = safeFileName('x'.repeat(119) + '😀😀');
    expect(base).toBe('x'.repeat(119) + '😀.pdf');
    expect(Array.from(base.slice(0, -4)).length).toBe(120);
  });

  it('keeps a Hindi name as it is', () => {
    expect(estimateFileName({ invoiceNumber: 'EST-0042', customerName: 'अनीता शर्मा' })).toBe(
      'EST-0042 - अनीता शर्मा.pdf'
    );
  });

  it('is never just .pdf', () => {
    expect(safeFileName('')).toBe('Document.pdf');
    expect(safeFileName('   ')).toBe('Document.pdf');
  });
});

describe('PDF-2: catalogueFileName', () => {
  it('names one chosen category and the business date, day first', () => {
    expect(catalogueFileName(['Ring'], '2026-11-24')).toBe(
      'Stock Catalogue - Ring - 24-11-2026.pdf'
    );
  });

  it('joins up to three categories with a comma', () => {
    expect(catalogueFileName(['Ring', 'Chain', 'Bangle'], '2026-11-24')).toBe(
      'Stock Catalogue - Ring, Chain, Bangle - 24-11-2026.pdf'
    );
  });

  it('leaves the categories out when none is chosen or more than three are', () => {
    expect(catalogueFileName([], '2026-11-24')).toBe('Stock Catalogue - 24-11-2026.pdf');
    expect(catalogueFileName(['Ring', 'Chain', 'Bangle', 'Anklet'], '2026-11-24')).toBe(
      'Stock Catalogue - 24-11-2026.pdf'
    );
  });

  it('leaves the date out when there is no business date', () => {
    expect(catalogueFileName(['Ring'], null)).toBe('Stock Catalogue - Ring.pdf');
    expect(catalogueFileName([], null)).toBe('Stock Catalogue.pdf');
  });

  it('leaves out a date it cannot read, rather than writing it wrong', () => {
    expect(catalogueFileName(['Ring'], 'yesterday')).toBe('Stock Catalogue - Ring.pdf');
  });

  it('turns the letters a file name cannot hold into dashes in a category', () => {
    expect(catalogueFileName(['Rings/Bands'], '2026-11-24')).toBe(
      'Stock Catalogue - Rings-Bands - 24-11-2026.pdf'
    );
  });
});

describe('PDF-2: downloadPdf', () => {
  function fakeDocument() {
    const link = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    };
    const createElement = vi.fn(() => link);
    const doc = { createElement, body: { appendChild: vi.fn() } } as unknown as Document;
    return { doc, link, createElement };
  }

  it('clicks an <a download> on a blob address once, and frees the address 60 s later', () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:jv-1');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { doc, link, createElement } = fakeDocument();
    const file = pdf();

    downloadPdf(file, doc);

    expect(createElement).toHaveBeenCalledWith('a');
    expect(create).toHaveBeenCalledWith(file.blob);
    expect(link.href).toBe('blob:jv-1');
    expect(link.download).toBe('EST-0042 - Anita Sharma.pdf');
    expect(link.click).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(59_999);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:jv-1');
  });
});

describe('PDF-2: canSharePdf', () => {
  const nav = (parts: Record<string, unknown>) => parts as unknown as Navigator;

  it('is false when share or canShare is missing', () => {
    expect(canSharePdf(nav({}))).toBe(false);
    expect(canSharePdf(nav({ share: async () => {} }))).toBe(false);
    expect(canSharePdf(nav({ canShare: () => true }))).toBe(false);
  });

  it('is false when canShare says no', () => {
    expect(canSharePdf(nav({ share: async () => {}, canShare: () => false }))).toBe(false);
  });

  it('is false when canShare throws', () => {
    const canShare = () => {
      throw new TypeError('not supported');
    };
    expect(canSharePdf(nav({ share: async () => {}, canShare }))).toBe(false);
  });

  it('is true when canShare accepts a PDF file, and asks about a PDF file', () => {
    const canShare = vi.fn(() => true);
    expect(canSharePdf(nav({ share: async () => {}, canShare }))).toBe(true);
    const asked = (canShare.mock.calls[0] as unknown as [{ files: File[] }])[0];
    expect(asked.files).toHaveLength(1);
    expect(asked.files[0]).toBeInstanceOf(File);
    expect(asked.files[0].type).toBe('application/pdf');
  });
});

describe('PDF-2: sharePdf', () => {
  const navOf = (share: (data: ShareData) => Promise<void>) =>
    ({ share, canShare: () => true }) as unknown as Navigator;
  const failure = (name: string) => Object.assign(new Error(name), { name });

  it('shares the PDF as a File of that name and type, with the title', async () => {
    const share = vi.fn(async (_data: ShareData) => {});
    const file = pdf('Stock Catalogue - 24-11-2026.pdf');

    await expect(sharePdf(file, 'Stock Catalogue', navOf(share))).resolves.toBe('shared');

    expect(share).toHaveBeenCalledTimes(1);
    const data = share.mock.calls[0][0];
    expect(data.title).toBe('Stock Catalogue');
    expect(data.files).toHaveLength(1);
    const sent = data.files![0];
    expect(sent).toBeInstanceOf(File);
    expect(sent.name).toBe('Stock Catalogue - 24-11-2026.pdf');
    expect(sent.type).toBe('application/pdf');
    expect(sent.size).toBe(file.blob.size);
  });

  it('is cancelled when the person closes the share menu (AbortError)', async () => {
    const nav = navOf(async () => {
      throw failure('AbortError');
    });
    await expect(sharePdf(pdf(), 'T', nav)).resolves.toBe('cancelled');
  });

  it('is blocked when the browser refuses the tap (NotAllowedError)', async () => {
    const nav = navOf(async () => {
      throw failure('NotAllowedError');
    });
    await expect(sharePdf(pdf(), 'T', nav)).resolves.toBe('blocked');
  });

  it('reads a DOMException the same way', async () => {
    const aborted = navOf(async () => {
      throw new DOMException('closed', 'AbortError');
    });
    const refused = navOf(async () => {
      throw new DOMException('stale tap', 'NotAllowedError');
    });
    await expect(sharePdf(pdf(), 'T', aborted)).resolves.toBe('cancelled');
    await expect(sharePdf(pdf(), 'T', refused)).resolves.toBe('blocked');
  });

  it('throws any other error', async () => {
    const nav = navOf(async () => {
      throw new TypeError('files are not supported');
    });
    await expect(sharePdf(pdf(), 'T', nav)).rejects.toBeInstanceOf(TypeError);
  });
});
