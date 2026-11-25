'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import AppLogo from '@/components/ui/AppLogo';
import PasswordField from '@/components/ui/PasswordField';
import { BUSINESS_NAME } from '@/lib/businessConfig';
import {
  BAD_LINK_MESSAGE,
  PASSWORD_CHANGED_MESSAGE,
  resetPassword,
  tokenFromHash,
} from '@/lib/passwordReset';

// The page the link of the mail opens: `<site>/reset-password#t=<token>` (DESIGN, part 2). It opens whatever the session state (AppLayout), so a person who is signed in on this
// browser sees it too; the API ends every session of the login when the password is saved, and a later call of the store finds that out.
//
// The token is read from the address once, on mount, kept in state, and taken out of the address bar at once (`history.replaceState`), so it stays out of the history and out of a
// copied address. It is never drawn on the page. The static page is made with no address to read, so the first render of the browser must be the same as the static one: it draws
// the card and nothing else (`reading`), and the sentence or the form follow once the address has been read. A page with no token, a damaged one, one that was reloaded after the
// token was taken out, or one the API refused, is the bad-link sentence with the way to ask again: never a blank or a broken form.
//
// `hash` is for the tests: the address fragment to read the token from, at once, instead of reading the browser's own on mount.
type Stage =
  | { kind: 'reading' }
  | { kind: 'bad' }
  | { kind: 'form'; token: string }
  | { kind: 'done' };

const stageOf = (hash: string): Stage => {
  const token = tokenFromHash(hash);
  return token === null ? { kind: 'bad' } : { kind: 'form', token };
};

export default function ResetPasswordScreen({ hash }: { hash?: string }) {
  const [stage, setStage] = useState<Stage>(() =>
    hash === undefined ? { kind: 'reading' } : stageOf(hash)
  );
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Once: in development React runs an effect twice, and the second run would find the address already empty.
  const read = useRef(false);
  useEffect(() => {
    if (hash !== undefined || read.current) return;
    read.current = true;
    const found = stageOf(window.location.hash);
    window.history.replaceState(null, '', window.location.pathname);
    setStage(found);
  }, [hash]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || stage.kind !== 'form') return;
    setError('');
    if (next !== repeat) {
      setError('The two new passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await resetPassword(stage.token, next);
      if ('error' in result) {
        if (result.field === 'token') {
          // the link is no good any more (used, expired, or made useless by another change): the form goes, the way to ask again comes
          setNext('');
          setRepeat('');
          setStage({ kind: 'bad' });
        } else {
          setError(result.error);
        }
      } else {
        setNext('');
        setRepeat('');
        setStage({ kind: 'done' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const header = (
    <div className="flex items-center gap-3">
      <AppLogo size={42} />
      <div>
        <h1 className="text-lg font-bold text-foreground">Choose a new password</h1>
        <p className="text-xs text-muted-foreground">{BUSINESS_NAME}</p>
      </div>
    </div>
  );
  const backToSignIn = (
    <Link href="/" className="block text-xs font-semibold text-primary hover:underline">
      Back to sign in
    </Link>
  );

  if (stage.kind === 'form') {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center px-4">
        <form onSubmit={handleSubmit} className="jewel-card w-full max-w-sm p-6 space-y-5">
          {header}
          <div className="space-y-3">
            <PasswordField
              label="New password"
              labelClassName="text-xs font-semibold text-muted-foreground block"
              inputClassName="input-field"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              autoComplete="new-password"
              required
            />
            <PasswordField
              label="Repeat the new password"
              labelClassName="text-xs font-semibold text-muted-foreground block"
              inputClassName="input-field"
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
              autoComplete="new-password"
              required
            />
            {error && (
              <p role="alert" className="text-xs font-semibold text-red-600">
                {error}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary w-full justify-center py-2.5 disabled:opacity-60"
          >
            {submitting ? 'Saving...' : 'Save new password'}
          </button>
          {backToSignIn}
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="jewel-card w-full max-w-sm p-6 space-y-5">
        {header}
        {stage.kind === 'bad' && (
          <>
            <p role="alert" className="text-sm font-semibold text-red-600">
              {BAD_LINK_MESSAGE}
            </p>
            <Link href="/forgot-password" className="btn-primary w-full justify-center py-2.5">
              Ask for a new link
            </Link>
            {backToSignIn}
          </>
        )}
        {stage.kind === 'done' && (
          <>
            <p role="status" className="text-sm text-foreground">
              {PASSWORD_CHANGED_MESSAGE}
            </p>
            {/* a person whose session this reset ended is shown sign-in at once: resetPassword makes the session store look at its session again as soon as the password is saved (the API decides, not this screen) */}
            <Link href="/" className="btn-primary w-full justify-center py-2.5">
              Sign in
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
