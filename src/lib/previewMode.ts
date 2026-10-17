// Preview mode: a build made with NEXT_PUBLIC_PREVIEW_MODE=1 opens every screen as the owner, with no login and no call to any server, so the front
// end can be looked at before a back end exists. The data on the screens is the prototype's own sample data (src/lib/mockData.ts), kept in this
// browser only, and a banner says so (AppLayout). The variable is written out in full because Next.js replaces exactly that text at build time. It
// is off unless it is exactly "1": a real build never opens like this, and never holds the sample data (the build drops it). WEB15 removes the
// switch together with the sample data.
//
// This file exists so that mockData.ts and the stores can ask the question without importing the session store (authStore re-exports the flag).
export const PREVIEW_MODE = process.env.NEXT_PUBLIC_PREVIEW_MODE === '1';
