'use client';

import React, { useState } from 'react';
import AppLogo from '@/components/ui/AppLogo';
import { signIn, type AuthSession } from '@/lib/authStore';
import { BUSINESS_NAME } from '@/lib/businessConfig';

export default function LoginScreen({ onLogin }: { onLogin: (session: AuthSession) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const session = signIn(username, password);
    if (!session) {
      setError('Invalid username or password.');
      return;
    }
    setError('');
    onLogin(session);
  };

  return (
    <main className="min-h-screen bg-background flex items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="jewel-card w-full max-w-sm p-6 space-y-5">
        <div className="flex items-center gap-3">
          <AppLogo size={42} />
          <div>
            <h1 className="text-lg font-bold text-foreground">{BUSINESS_NAME}</h1>
            <p className="text-xs text-muted-foreground">Local staff access</p>
          </div>
        </div>

        <div className="space-y-3">
          <label className="text-xs font-semibold text-muted-foreground block">
            Username
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="input-field mt-1"
              autoComplete="username"
            />
          </label>
          <label className="text-xs font-semibold text-muted-foreground block">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="input-field mt-1"
              autoComplete="current-password"
            />
          </label>
          {error && <p className="text-xs font-semibold text-red-600">{error}</p>}
        </div>

        <button type="submit" className="btn-primary w-full justify-center py-2.5">
          Sign In
        </button>

        <div className="rounded-sm bg-muted/60 p-3 text-xs text-muted-foreground space-y-1">
          <p><strong className="text-foreground">Admin:</strong> admin / admin123</p>
          <p><strong className="text-foreground">Staff:</strong> staff / staff123</p>
        </div>
      </form>
    </main>
  );
}
