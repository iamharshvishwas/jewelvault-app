// WEB04: the banner of C7 reaches the Save controls. "Every Save control is disabled" while the banner "Offline: changes cannot be saved" or "Waking up…" is on screen, and
// is as it was when the banner is gone. The real DOM halves (a Save control that is disabled in Chromium with the network cut) are tests/e2e/poll.spec.ts.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus } from '@/lib/api/client';

let status: ConnectionStatus = 'ok';
// the hook reads the client's state with useSyncExternalStore, which a server render answers with "ok": the test says what the client would say
vi.mock('@/lib/api/connection', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api/connection')>();
  return { ...real, useConnectionStatus: () => status };
});

import SaveButton from '@/components/ui/SaveButton';
import { CONNECTION_BANNER } from '@/lib/api/client';
import { bannerText, savingAllowedFor } from '@/lib/api/connection';

beforeEach(() => {
  status = 'ok';
});

const html = (props: React.ComponentProps<typeof SaveButton>) =>
  renderToStaticMarkup(React.createElement(SaveButton, props));

describe('T-E03 the connection decides whether Save may be pressed (C7)', () => {
  it('saving is allowed only when the connection is fine: not offline, not waking up', () => {
    expect(savingAllowedFor('ok')).toBe(true);
    expect(savingAllowedFor('offline')).toBe(false);
    expect(savingAllowedFor('waking')).toBe(false);
  });

  it('the words of the banner are the ones of the spec', () => {
    expect(bannerText('offline')).toBe('Offline: changes cannot be saved');
    expect(bannerText('waking')).toBe('Waking up…');
    expect(bannerText('ok')).toBeNull();
    expect(CONNECTION_BANNER.offline).toBe('Offline: changes cannot be saved');
  });
});

describe('T-E03 SaveButton is a plain button that is off while there is a banner (C7, C6)', () => {
  it('with a good connection it is an ordinary button: its own props, enabled', () => {
    const out = html({ className: 'btn-primary', title: 'Save the rates', children: 'Save Rates' });
    expect(out).toContain('<button');
    expect(out).toContain('class="btn-primary"');
    expect(out).toContain('title="Save the rates"');
    expect(out).toContain('Save Rates');
    expect(out).not.toContain('disabled');
  });

  it('offline it is disabled, and its title says why', () => {
    status = 'offline';
    const out = html({ className: 'btn-primary', title: 'Save the rates', children: 'Save Rates' });
    expect(out).toContain('disabled=""');
    expect(out).toContain('title="Offline: changes cannot be saved"');
  });

  it('while the app is waking up it is disabled too', () => {
    status = 'waking';
    const out = html({ children: 'Save' });
    expect(out).toContain('disabled=""');
    expect(out).toContain('title="Waking up…"');
  });

  it("the caller's own disabled (a save is running, C6) stays on when the connection is fine", () => {
    expect(html({ disabled: true, children: 'Save' })).toContain('disabled=""');
    expect(html({ disabled: false, children: 'Save' })).not.toContain('disabled');
  });

  it('type and the other attributes of a button go through (a submit button of a form)', () => {
    const out = html({ type: 'submit', children: 'Record' });
    expect(out).toContain('type="submit"');
  });
});
