'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import AppLogo from '@/components/ui/AppLogo';
import { BUSINESS_NAME } from '@/lib/businessConfig';
import { LINK_SENT_MESSAGE, requestResetLink } from '@/lib/passwordReset';

// "Forgot password?" on the sign-in screen opens this one (DESIGN, part 2). It asks for the e-mail of the login and asks the API to send a link to it. The API answers the same
// for every e-mail, and so does this screen: after Send link it always says the same sentence (LINK_SENT_MESSAGE) and never whether the e-mail has a login. The only other
// answer is a failure: the API's "e-mail is not set up here", or the plain message of a call that did not get through. The screen opens whatever the session state (AppLayout).
export default function ForgotPasswordScreen() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);
    try {
      const result = await requestResetLink(email);
      if ('error' in result) setError(result.error);
      else setSent(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="jewel-card w-full max-w-sm p-6 space-y-5">
        <div className="flex items-center gap-3">
          <AppLogo size={42} />
          <div>
            <h1 className="text-lg font-bold text-foreground">Forgot password</h1>
            <p className="text-xs text-muted-foreground">{BUSINESS_NAME}</p>
          </div>
        </div>

        {sent ? (
          <p role="status" className="text-sm text-foreground">
            {LINK_SENT_MESSAGE}
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-3">
              <label className="text-xs font-semibold text-muted-foreground block">
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="input-field mt-1"
                  autoComplete="email"
                  required
                />
              </label>
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
              {submitting ? 'Sending...' : 'Send link'}
            </button>
          </form>
        )}

        <Link href="/" className="block text-xs font-semibold text-primary hover:underline">
          Back to sign in
        </Link>
      </div>
    </main>
  );
}
