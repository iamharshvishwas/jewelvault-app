import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PasswordField, { revealLabel } from '@/components/ui/PasswordField';
import LoginScreen from '@/components/LoginScreen';
import ChangePasswordScreen from '@/components/ChangePasswordScreen';

// The eye button of every password field (Completion-Plan/password-help-2026-11-26/DESIGN.md, part 1).
const field = (extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(PasswordField, {
      label: 'Password',
      labelClassName: 'block',
      inputClassName: 'input-field',
      value: '',
      onChange: () => {},
      autoComplete: 'current-password',
      ...extra,
    })
  );

const toggles = (html: string) => html.match(/data-testid="password-reveal"/g)?.length ?? 0;

describe('PasswordField', () => {
  it('starts hidden: the input is type="password" and the button says it will show', () => {
    const html = field();
    expect(html).toMatch(/<input[^>]*type="password"/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"/);
    expect(html).toContain(`aria-label="${revealLabel(false)}"`);
  });

  it('the button never submits the form', () => {
    expect(field()).toMatch(/<button[^>]*type="button"/);
  });

  it('the label names the input by id, and the button is outside the label', () => {
    const html = field();
    const id = /<input[^>]*id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`for="${id}"`);
    const label = /<label[^>]*>[\s\S]*?<\/label>/.exec(html)?.[0] ?? '';
    expect(label).not.toContain('<button');
  });

  it('the button names never contain "password", so getByLabel("Password") finds only the field', () => {
    expect(revealLabel(false).toLowerCase()).not.toContain('password');
    expect(revealLabel(true).toLowerCase()).not.toContain('password');
    expect(revealLabel(false)).not.toBe(revealLabel(true));
  });

  it('passes the input attributes through (test id, autocomplete, required)', () => {
    const html = field({
      'data-testid': 'confirm-password-input',
      required: true,
      autoComplete: 'new-password',
    });
    expect(html).toMatch(/<input[^>]*data-testid="confirm-password-input"/);
    expect(html).toMatch(
      /<input[^>]*autoComplete="new-password"|<input[^>]*autocomplete="new-password"/
    );
    expect(html).toMatch(/<input[^>]*required/);
  });
});

describe('the screens use it', () => {
  it('Sign in has one eye button', () => {
    expect(toggles(renderToStaticMarkup(createElement(LoginScreen, { notice: null })))).toBe(1);
  });

  it('Choose a new password has three, one per field', () => {
    const session = { displayName: 'Test Person' } as Parameters<
      typeof ChangePasswordScreen
    >[0]['session'];
    expect(toggles(renderToStaticMarkup(createElement(ChangePasswordScreen, { session })))).toBe(3);
  });
});
