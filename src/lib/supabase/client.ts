import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// The one Supabase client of the browser (U10, H4).
//
// The build holds the project URL and the PUBLISHABLE key and nothing else: no secret key, no service-role key, no database
// connection string. Both values are public by design; what a signed-in person may do is decided by the database
// (row-level security and the grants), not by hiding a key.
//
// The two values are read as `process.env.NEXT_PUBLIC_...` written out in full, because Next.js replaces exactly that text at
// build time (a lookup by a variable name is not replaced).
//
// The client is made on first use and only in the browser, so that `next build` (which loads every page on the server to
// write its HTML) never needs the values and never starts a session.

let client: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !publishableKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set when the site is built.'
    );
  }
  client = createClient(url, publishableKey, {
    auth: {
      // The library keeps the session in localStorage (C8: the only thing the browser stores) and refreshes the token.
      persistSession: true,
      autoRefreshToken: true,
      // Nobody signs in from a link in this application; never read a session out of the address.
      detectSessionInUrl: false,
    },
  });
  return client;
}
